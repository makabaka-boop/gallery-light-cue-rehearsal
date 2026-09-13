import { describe, expect, it } from 'vitest';
import {
  CueSheetError,
  decodeCueSheet,
  MAX_CHANNEL,
  MAX_DURATION_MS,
  MAX_MAX_LATENESS_MS,
  MIN_CHANNEL,
  MIN_DURATION_MS,
  MIN_MAX_LATENESS_MS,
  parseCueSheet,
} from './validate';

const valid = [
  { id: 'a', label: '开场灯', durationMs: 1000 },
  { id: 'b', label: '追光', durationMs: 2000 },
];

describe('parseCueSheet 合法输入', () => {
  it('解析合法清单并规范化数字 id', () => {
    const items = parseCueSheet(JSON.stringify([...valid, { id: 3, label: '谢幕', durationMs: 100 }]));
    expect(items).toEqual([...valid, { id: '3', label: '谢幕', durationMs: 100 }]);
  });

  it('接受边界时长 100 与 600000', () => {
    const items = parseCueSheet(
      JSON.stringify([
        { id: 'lo', label: '最短', durationMs: MIN_DURATION_MS },
        { id: 'hi', label: '最长', durationMs: MAX_DURATION_MS },
      ]),
    );
    expect(items.map((item) => item.durationMs)).toEqual([100, 600000]);
  });

  it('接受含中文与特殊字符的 UTF-8 内容', () => {
    const items = parseCueSheet('[{"id":"x","label":"追光·主舞台 💡","durationMs":100}]');
    expect(items[0].label).toBe('追光·主舞台 💡');
  });
});

describe('parseCueSheet maxLatenessMs 可选字段', () => {
  it('省略时不设置该字段（旧清单保持原样）', () => {
    const items = parseCueSheet(JSON.stringify(valid));
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.maxLatenessMs === undefined)).toBe(true);
  });

  it('接受边界迟到阈值 0 与 600000（含零容忍）', () => {
    const items = parseCueSheet(
      JSON.stringify([
        { id: 'lo', label: '零容忍', durationMs: 100, maxLatenessMs: MIN_MAX_LATENESS_MS },
        { id: 'hi', label: '最宽', durationMs: 100, maxLatenessMs: MAX_MAX_LATENESS_MS },
      ]),
    );
    expect(items.map((item) => item.maxLatenessMs)).toEqual([0, 600000]);
  });

  it('新旧字段可在同一清单内混用', () => {
    const items = parseCueSheet(
      JSON.stringify([
        { id: 'old', label: '旧项', durationMs: 100 },
        { id: 'new', label: '新项', durationMs: 100, maxLatenessMs: 500 },
      ]),
    );
    expect(items[0].maxLatenessMs).toBeUndefined();
    expect(items[1].maxLatenessMs).toBe(500);
  });

  const invalidCases: Array<[string, unknown, string]> = [
    ['maxLatenessMs 为小数', [{ id: 'a', label: 'x', durationMs: 100, maxLatenessMs: 0.5 }], 'maxLatenessMs 必须是整数'],
    ['maxLatenessMs 为字符串', [{ id: 'a', label: 'x', durationMs: 100, maxLatenessMs: '100' }], 'maxLatenessMs 必须是整数'],
    ['maxLatenessMs 为布尔', [{ id: 'a', label: 'x', durationMs: 100, maxLatenessMs: true }], 'maxLatenessMs 必须是整数'],
    ['maxLatenessMs 为 null', [{ id: 'a', label: 'x', durationMs: 100, maxLatenessMs: null }], 'maxLatenessMs 必须是整数'],
    ['maxLatenessMs 为负数', [{ id: 'a', label: 'x', durationMs: 100, maxLatenessMs: -1 }], '0 到 600000'],
    ['maxLatenessMs 大于 600000', [{ id: 'a', label: 'x', durationMs: 100, maxLatenessMs: 600001 }], '0 到 600000'],
  ];

  it.each(invalidCases)('%s', (_name, payload, message) => {
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow(CueSheetError);
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow(message);
  });

  it('非法 maxLatenessMs 指出具体条目序号与字段', () => {
    const payload = [
      valid[0],
      { id: 'b', label: 'y', durationMs: 200, maxLatenessMs: 600001 },
    ];
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow('第 2 项');
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow('maxLatenessMs');
  });
});

describe('parseCueSheet channelStart/channelCount 通道配接', () => {
  it('两字段同时省略时不设置（旧清单保持原样）', () => {
    const items = parseCueSheet(JSON.stringify(valid));
    expect(items.every((item) => item.channelStart === undefined)).toBe(true);
    expect(items.every((item) => item.channelCount === undefined)).toBe(true);
  });

  it('接受边界值：起始 1 与 512、数量 1 与 512、结束通道恰为 512', () => {
    const items = parseCueSheet(
      JSON.stringify([
        { id: 'lo', label: '首通道', durationMs: 100, channelStart: MIN_CHANNEL, channelCount: 1 },
        { id: 'hi', label: '末通道', durationMs: 100, channelStart: MAX_CHANNEL, channelCount: 1 },
        { id: 'full', label: '满配', durationMs: 100, channelStart: 1, channelCount: MAX_CHANNEL },
        { id: 'edge', label: '贴边', durationMs: 100, channelStart: 500, channelCount: 13 },
      ]),
    );
    expect(items.map((item) => [item.channelStart, item.channelCount])).toEqual([
      [1, 1],
      [512, 1],
      [1, 512],
      [500, 13],
    ]);
  });

  it('与 maxLatenessMs 及未配接旧项可在同一清单内混用', () => {
    const items = parseCueSheet(
      JSON.stringify([
        { id: 'old', label: '旧项', durationMs: 100 },
        { id: 'late', label: '阈值项', durationMs: 100, maxLatenessMs: 500 },
        { id: 'dmx', label: '配接项', durationMs: 100, channelStart: 10, channelCount: 4 },
      ]),
    );
    expect(items[0].channelStart).toBeUndefined();
    expect(items[1].channelStart).toBeUndefined();
    expect(items[2]).toMatchObject({ channelStart: 10, channelCount: 4 });
  });

  const invalidCases: Array<[string, unknown, string]> = [
    ['只出现 channelStart', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 1 }], '必须同时出现'],
    ['只出现 channelCount', [{ id: 'a', label: 'x', durationMs: 100, channelCount: 1 }], '必须同时出现'],
    ['channelStart 为小数', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 1.5, channelCount: 2 }], 'channelStart 必须是整数'],
    ['channelStart 为字符串', [{ id: 'a', label: 'x', durationMs: 100, channelStart: '1', channelCount: 2 }], 'channelStart 必须是整数'],
    ['channelStart 为布尔', [{ id: 'a', label: 'x', durationMs: 100, channelStart: true, channelCount: 2 }], 'channelStart 必须是整数'],
    ['channelStart 为 null', [{ id: 'a', label: 'x', durationMs: 100, channelStart: null, channelCount: 2 }], 'channelStart 必须是整数'],
    ['channelCount 为小数', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 1, channelCount: 2.5 }], 'channelCount 必须是整数'],
    ['channelCount 为字符串', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 1, channelCount: '2' }], 'channelCount 必须是整数'],
    ['channelCount 为 null', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 1, channelCount: null }], 'channelCount 必须是整数'],
    ['channelStart 为 0', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 0, channelCount: 1 }], 'channelStart 必须在 1 到 512'],
    ['channelStart 大于 512', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 513, channelCount: 1 }], 'channelStart 必须在 1 到 512'],
    ['channelStart 为负数', [{ id: 'a', label: 'x', durationMs: 100, channelStart: -4, channelCount: 1 }], 'channelStart 必须在 1 到 512'],
    ['channelCount 为 0', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 1, channelCount: 0 }], 'channelCount 必须在 1 到 512'],
    ['channelCount 大于 512', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 1, channelCount: 513 }], 'channelCount 必须在 1 到 512'],
    ['结束通道超过 512（512 + 2 - 1）', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 512, channelCount: 2 }], '结束通道'],
    ['结束通道超过 512（500 + 14 - 1）', [{ id: 'a', label: 'x', durationMs: 100, channelStart: 500, channelCount: 14 }], '结束通道'],
  ];

  it.each(invalidCases)('%s', (_name, payload, message) => {
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow(CueSheetError);
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow(message);
  });

  it('非法通道配接指出具体条目序号与字段', () => {
    const payload = [
      valid[0],
      { id: 'b', label: 'y', durationMs: 200, channelStart: 510, channelCount: 10 },
    ];
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow('第 2 项');
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow('channelStart');
  });

  it('任一项通道配接非法即整份拒绝，不返回部分结果', () => {
    const payload = [
      { id: 'ok', label: '好项', durationMs: 100, channelStart: 1, channelCount: 8 },
      { id: 'bad', label: '坏项', durationMs: 100, channelStart: 600, channelCount: 1 },
    ];
    expect(() => parseCueSheet(JSON.stringify(payload))).toThrow(CueSheetError);
  });
});

describe('parseCueSheet 非法输入整份拒绝', () => {
  const cases: Array<[string, unknown, string]> = [
    ['非 JSON 文本', 'not json{', '有效的 JSON'],
    ['顶层不是数组', { id: 'a' }, '顶层必须是数组'],
    ['空数组', [], '空数组'],
    ['项不是对象', ['x'], '必须是对象'],
    ['包含额外字段', [{ id: 'a', label: 'x', durationMs: 100, note: '多' }], '不允许的字段'],
    ['缺少 id', [{ label: 'x', durationMs: 100 }], 'id'],
    ['id 为空串', [{ id: '  ', label: 'x', durationMs: 100 }], 'id 不能为空'],
    ['id 重复', [...valid, { id: 'a', label: 'y', durationMs: 100 }], '重复'],
    ['数字与文本形式的同一 id', [{ id: 1, label: 'x', durationMs: 100 }, { id: '1', label: 'y', durationMs: 100 }], '重复'],
    ['缺少 label', [{ id: 'a', durationMs: 100 }], 'label'],
    ['label 为空白', [{ id: 'a', label: '   ', durationMs: 100 }], '非空字符串'],
    ['label 不是字符串', [{ id: 'a', label: 5, durationMs: 100 }], '非空字符串'],
    ['durationMs 为小数', [{ id: 'a', label: 'x', durationMs: 100.5 }], '整数'],
    ['durationMs 为字符串', [{ id: 'a', label: 'x', durationMs: '100' }], '整数'],
    ['durationMs 小于 100', [{ id: 'a', label: 'x', durationMs: 99 }], '100 到 600000'],
    ['durationMs 大于 600000', [{ id: 'a', label: 'x', durationMs: 600001 }], '100 到 600000'],
  ];

  it.each(cases)('%s', (_name, payload, message) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    expect(() => parseCueSheet(text)).toThrow(CueSheetError);
    expect(() => parseCueSheet(text)).toThrow(message);
  });

  it('任一项非法即整份拒绝，不返回部分结果', () => {
    const text = JSON.stringify([valid[0], { id: 'b', label: '', durationMs: 2000 }]);
    expect(() => parseCueSheet(text)).toThrow('第 2 项');
  });

  it('标签合法包含替换字符（U+FFFD）时正常载入，不误报编码异常', () => {
    const items = parseCueSheet('[{"id":"a","label":"追光�灯","durationMs":1000}]');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('追光�灯');
  });
});

describe('decodeCueSheet 严格 UTF-8 解码', () => {
  const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));

  it('非法字节序列整份拒绝并提示编码异常', () => {
    // 0xC0 0xAF 为 "/" 的过长编码，属非法 UTF-8；宽松解码会替换为 U+FFFD 后静默通过
    const bytes = new Uint8Array([
      ...utf8('[{"id":"bad","label":"追光'),
      0xc0, 0xaf,
      ...utf8('","durationMs":1000}]'),
    ]);
    expect(() => decodeCueSheet(bytes)).toThrow(CueSheetError);
    expect(() => decodeCueSheet(bytes)).toThrow('编码异常');
  });

  it('合法编码的 U+FFFD 字符正常解码，与非法字节区分开', () => {
    // U+FFFD 的合法 UTF-8 编码为 0xEF 0xBF 0xBD，不是解码失败的产物
    const text = '[{"id":"a","label":"追光�灯","durationMs":1000}]';
    const bytes = new TextEncoder().encode(text);
    expect(Array.from(bytes)).toContain(0xef);
    expect(decodeCueSheet(bytes)).toBe(text);
    expect(parseCueSheet(decodeCueSheet(bytes))[0].label).toBe('追光�灯');
  });

  it('合法 UTF-8 多字节字符（中文、emoji）正常解码', () => {
    const text = '[{"id":"x","label":"追光·主舞台 💡","durationMs":100}]';
    expect(decodeCueSheet(new TextEncoder().encode(text))).toBe(text);
  });
});
