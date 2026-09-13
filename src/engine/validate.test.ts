import { describe, expect, it } from 'vitest';
import { CueSheetError, MAX_DURATION_MS, MIN_DURATION_MS, parseCueSheet } from './validate';

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
});
