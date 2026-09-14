import { expect, test, type Page } from '@playwright/test';

const cues = [
  { id: 'a', label: '开场灯', durationMs: 1000 },
  { id: 'b', label: '追光', durationMs: 2000 },
  { id: 'c', label: '谢幕', durationMs: 3000 },
];

async function importJson(page: Page, data: unknown) {
  await page.setInputFiles('[data-testid="file-input"]', {
    name: 'cues.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data), 'utf-8'),
  });
}

test.beforeEach(async ({ page }) => {
  // 安装假时钟（performance.now、Date、setTimeout 等全部由测试控制），
  // 并停在固定时刻：此后时间仅由 runFor/fastForward 精确推进，不随真实时间流动
  await page.clock.install({ time: new Date('2026-09-13T09:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-13T10:00:00Z'));
  await page.goto('/');
});

test('未载入时启动就地报错且状态不变', async ({ page }) => {
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByRole('alert')).toContainText('尚未导入提示清单');
  await expect(page.getByTestId('status')).toContainText('未载入');
});

test('非法清单整份拒绝，且不替换当前有效数据', async ({ page }) => {
  await importJson(page, cues);
  await expect(page.getByTestId('status')).toContainText('待启动');
  await expect(page.getByTestId('cue-row-a')).toBeVisible();
  await expect(page.getByTestId('cue-row-c')).toBeVisible();
  // 旧格式（无 maxLatenessMs）：阈值列与判定列均显示“未设标准”，超限汇总为 0
  await expect(page.getByTestId('threshold-a')).toHaveText('未设标准');
  await expect(page.getByTestId('verdict-a')).toHaveText('未设标准');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');

  const invalidSheets: Array<[string, unknown, string]> = [
    ['时长越界', [{ id: 'x', label: '坏项', durationMs: 50 }], 'durationMs'],
    ['id 重复', [...cues, { id: 'a', label: '重复', durationMs: 100 }], '重复'],
    ['数字与文本同一 id', [{ id: 1, label: '数字', durationMs: 100 }, { id: '1', label: '文本', durationMs: 100 }], '重复'],
    ['含额外字段', [{ id: 'x', label: '多字段', durationMs: 100, note: 1 }], '不允许的字段'],
    ['label 为空', [{ id: 'x', label: '  ', durationMs: 100 }], '非空字符串'],
    ['时长非整数', [{ id: 'x', label: '小数', durationMs: 100.5 }], '整数'],
    ['迟到阈值非整数', [{ id: 'x', label: '阈值小数', durationMs: 100, maxLatenessMs: 0.5 }], 'maxLatenessMs'],
    ['迟到阈值越界', [{ id: 'x', label: '阈值越界', durationMs: 100, maxLatenessMs: 600001 }], 'maxLatenessMs'],
  ];
  for (const [, payload, message] of invalidSheets) {
    await importJson(page, payload);
    await expect(page.getByRole('alert')).toContainText(message);
    // 当前有效数据保持不变
    await expect(page.getByTestId('cue-row-a')).toBeVisible();
    await expect(page.getByTestId('cue-row-c')).toBeVisible();
    await expect(page.getByTestId('status')).toContainText('待启动');
  }
});

test('状态不符的重复操作就地报错且状态不变', async ({ page }) => {
  await importJson(page, cues);

  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByRole('alert')).toContainText('无法暂停');
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByRole('alert')).toContainText('无法继续');
  await expect(page.getByTestId('status')).toContainText('待启动');

  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByTestId('status')).toContainText('进行中');

  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByRole('alert')).toContainText('请勿重复启动');
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByRole('alert')).toContainText('无法继续');
  await expect(page.getByTestId('status')).toContainText('进行中');
});

test('暂停冻结余量、恢复重建截止，延迟回调集中处理且不延长整段演练', async ({ page }) => {
  await importJson(page, cues);
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');
  await expect(page.getByTestId('current')).toContainText('开场灯');
  await expect(page.getByTestId('planned-a')).toHaveText('1000 ms');

  // 进行 400ms 后暂停，剩余 600ms 被冻结
  await page.clock.runFor(400);
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByTestId('status')).toContainText('已暂停');
  await expect(page.getByTestId('current')).toContainText('冻结剩余 600 ms');

  // 暂停期间时间流逝 10s，余量不变、无任何项被处理
  await page.clock.runFor(10000);
  await expect(page.getByTestId('current')).toContainText('冻结剩余 600 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('—');

  // 恢复：以冻结的 600ms 建立新截止时刻（相对启动为 11000ms）
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');
  await expect(page.getByTestId('planned-a')).toHaveText('11000 ms');
  await expect(page.getByTestId('planned-c')).toHaveText('16000 ms');

  // 模拟标签页降频：时间快进到 14500ms（越过 a@11000、b@13000，未到 c@16000），
  // 到期的定时回调只被延迟投递一次，其观察到的时刻为 14500ms
  await page.clock.fastForward(4100);

  // a、b 按各自截止时刻依次记入轨迹，实际处理时刻同为 14500；当前应执行项直接落到 c
  // 处理类型列直接标出这两项属于到期处理，未处理的 c 仍为占位符
  await expect(page.getByTestId('planned-a')).toHaveText('11000 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('14500 ms');
  await expect(page.getByTestId('kind-a')).toHaveText('到期处理');
  await expect(page.getByTestId('planned-b')).toHaveText('13000 ms');
  await expect(page.getByTestId('actual-b')).toHaveText('14500 ms');
  await expect(page.getByTestId('kind-b')).toHaveText('到期处理');
  await expect(page.getByTestId('current')).toContainText('谢幕');
  await expect(page.getByTestId('planned-c')).toHaveText('16000 ms');
  await expect(page.getByTestId('actual-c')).toHaveText('—');
  await expect(page.getByTestId('kind-c')).toHaveText('—');

  // c 仍在原计划截止时刻到期：长延迟虽造成集中处理，却没有延长整段演练
  await page.clock.runFor(1500);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('actual-c')).toHaveText('16000 ms');
  await expect(page.getByTestId('kind-c')).toHaveText('到期处理');
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
  await expect(page.getByTestId('done')).toContainText('计划截止 16000 ms');
  await expect(page.getByTestId('done')).toContainText('实际处理 16000 ms');

  // 旧格式演练路径行为不变：迟到量照记但不判级，三行均为“未设标准”，汇总始终 0
  await expect(page.getByTestId('verdict-a')).toHaveText('迟到 3500 ms（未设标准）');
  await expect(page.getByTestId('verdict-b')).toHaveText('迟到 1500 ms（未设标准）');
  await expect(page.getByTestId('verdict-c')).toHaveText('迟到 0 ms（未设标准）');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');

  // 完成后操作报错且界面保持稳定
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByRole('alert')).toContainText('已完成');
  await expect(page.getByTestId('status')).toContainText('已完成');
});

test('进行中的演练不受失败导入影响', async ({ page }) => {
  await importJson(page, cues);
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');

  // 演练进行中导入（无论文件是否合法）都被拒绝，且不打断当前演练
  await importJson(page, [{ id: 'x', label: '另一份清单', durationMs: 100 }]);
  await expect(page.getByRole('alert')).toContainText('演练进行中');
  await expect(page.getByTestId('status')).toContainText('进行中');
  await expect(page.getByTestId('cue-row-a')).toBeVisible();

  // 计时链路完好：第一项仍按原截止时刻到期
  await page.clock.runFor(1000);
  await expect(page.getByTestId('actual-a')).toHaveText('1000 ms');
  await expect(page.getByTestId('current')).toContainText('追光');
});

test('暂停中导入另一份清单被拒绝，提示明确反映暂停状态', async ({ page }) => {
  await importJson(page, cues);
  await page.getByRole('button', { name: '开始' }).click();
  await page.clock.runFor(400);
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByTestId('status')).toContainText('已暂停');

  // 暂停中导入被拒绝：提示必须反映暂停状态，而非笼统的“进行中”
  await importJson(page, [{ id: 'x', label: '另一份清单', durationMs: 100 }]);
  await expect(page.getByRole('alert')).toContainText('演练已暂停');
  // 原清单与暂停状态保持不变
  await expect(page.getByTestId('cue-row-a')).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('已暂停');
  await expect(page.getByTestId('current')).toContainText('冻结剩余 600 ms');
});

test('warningLeadMs 预告：新旧字段混合清单完整演练，预告边界、暂停恢复与截止结算', async ({ page }) => {
  // a 带预告（提前 300）与阈值；b 带预告（提前 500）；c 为旧项，全程无预告提示
  const warningCues = [
    { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 100, warningLeadMs: 300 },
    { id: 'b', label: '追光', durationMs: 2000, warningLeadMs: 500 },
    { id: 'c', label: '谢幕', durationMs: 3000 },
  ];
  await importJson(page, warningCues);
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');

  // 启动后当前项 a 处于等待预告；旧项 c 即使成为当前项也不显示预告徽标（先确认初始等待态）
  await expect(page.getByTestId('warning-badge')).toHaveText(/等待预告/);
  await expect(page.getByTestId('warning-badge')).toHaveAttribute('data-warning', 'waiting');

  // 进行 400ms 后暂停：余量 600 > 预告量 300，预告冻结在“等待预告”
  await page.clock.runFor(400);
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByTestId('status')).toContainText('已暂停');
  await expect(page.getByTestId('current')).toContainText('冻结剩余 600 ms');
  await expect(page.getByTestId('warning-badge')).toHaveText(/预告已冻结 · 等待预告 · 距预告点 300 ms/);
  await expect(page.getByTestId('warning-badge')).toHaveAttribute('data-warning', 'waiting');

  // 暂停期间时间流逝不推进预告
  await page.clock.runFor(10000);
  await expect(page.getByTestId('current')).toContainText('冻结剩余 600 ms');
  await expect(page.getByTestId('warning-badge')).toHaveText(/距预告点 300 ms/);

  // 恢复：以冻结余量重建预告边界（新预告点 = 恢复时刻 + 300）
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');
  await expect(page.getByTestId('warning-badge')).toHaveAttribute('data-warning', 'waiting');
  await expect(page.getByTestId('planned-a')).toHaveText('11000 ms');

  // 推进到重建后的预告点（10400 + 300 = 10700）：a 变即将到期，距截止 300ms，但不结算
  await page.clock.runFor(300);
  await expect(page.getByTestId('warning-badge')).toHaveText(/即将到期 · 剩余 300 ms/);
  await expect(page.getByTestId('warning-badge')).toHaveAttribute('data-warning', 'due-soon');
  await expect(page.getByTestId('actual-a')).toHaveText('—');

  // 标签页降频：唯一回调被延迟到相对启动 12500ms 投递。
  // a 截止 11000（迟到 1500 > 100 => 超限）；b 截止 13000、预告点 12500 恰到达；c 尚未到期
  await page.clock.fastForward(1800);
  await expect(page.getByTestId('actual-a')).toHaveText('12500 ms');
  await expect(page.getByTestId('kind-a')).toHaveText('到期处理');
  await expect(page.getByTestId('verdict-a')).toHaveText('迟到 1500 ms（超限）');
  // a 结算后当前项推进到 b：此刻恰在 b 的预告点，呈现即将到期、距截止 500ms
  await expect(page.getByTestId('current')).toContainText('追光');
  await expect(page.getByTestId('warning-badge')).toHaveText(/即将到期 · 剩余 500 ms/);
  await expect(page.getByTestId('warning-badge')).toHaveAttribute('data-warning', 'due-soon');
  await expect(page.getByTestId('actual-b')).toHaveText('—');

  // b 在原截止 13000 结算后，当前项推进到旧项 c：c 未配置预告，不显示任何预告提示
  await page.clock.runFor(500);
  await expect(page.getByTestId('actual-b')).toHaveText('13000 ms');
  await expect(page.getByTestId('kind-b')).toHaveText('到期处理');
  await expect(page.getByTestId('current')).toContainText('谢幕');
  await expect(page.getByTestId('warning-badge')).toHaveCount(0);

  // c 照常到期，演练完成；绝对截止未因预告或延迟漂移
  await page.clock.runFor(3000);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('planned-c')).toHaveText('16000 ms');
  await expect(page.getByTestId('actual-c')).toHaveText('16000 ms');
  await expect(page.getByTestId('kind-c')).toHaveText('到期处理');
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
  await expect(page.getByTestId('warning-badge')).toHaveCount(0);
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 1 项');
});

test('一次延迟回调跨过预告点与截止点：当前项直接呈现即将到期，截止不被改写', async ({ page }) => {
  await importJson(page, [
    { id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 },
    { id: 'b', label: '追光', durationMs: 2000, warningLeadMs: 500 },
  ]);
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('warning-badge')).toHaveAttribute('data-warning', 'waiting');

  // 标签页降频到 2700ms：越过 a 的预告点 700 与截止 1000（a 结算），
  // 并越过 b 的预告点 2500 但未到 b 的截止 3000（b 依据当前绝对时刻直接呈现即将到期）
  await page.clock.fastForward(2700);
  await expect(page.getByTestId('actual-a')).toHaveText('2700 ms');
  await expect(page.getByTestId('kind-a')).toHaveText('到期处理');
  await expect(page.getByTestId('current')).toContainText('追光');
  await expect(page.getByTestId('warning-badge')).toHaveText(/即将到期 · 剩余 300 ms/);
  await expect(page.getByTestId('warning-badge')).toHaveAttribute('data-warning', 'due-soon');
  await expect(page.getByTestId('actual-b')).toHaveText('—');

  // b 仍按原截止时刻 3000 结算：预告没有顺延或改写截止
  await page.clock.runFor(300);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('planned-b')).toHaveText('3000 ms');
  await expect(page.getByTestId('actual-b')).toHaveText('3000 ms');
  await expect(page.getByTestId('kind-b')).toHaveText('到期处理');
});

test('非法 warningLeadMs 整份拒绝并指出条目与字段，当前清单与演练状态保留', async ({ page }) => {
  await importJson(page, cues);
  await expect(page.getByTestId('status')).toContainText('待启动');
  await expect(page.getByTestId('cue-row-a')).toBeVisible();

  const invalidSheets: Array<[string, unknown, string]> = [
    ['预告为小数', [{ id: 'x', label: '坏项', durationMs: 100, warningLeadMs: 0.5 }], 'warningLeadMs 必须是整数'],
    ['预告为字符串', [{ id: 'x', label: '坏项', durationMs: 100, warningLeadMs: '100' }], 'warningLeadMs 必须是整数'],
    ['预告为 null', [{ id: 'x', label: '坏项', durationMs: 100, warningLeadMs: null }], 'warningLeadMs 必须是整数'],
    ['预告为负数', [{ id: 'x', label: '坏项', durationMs: 100, warningLeadMs: -1 }], 'warningLeadMs 必须在 0'],
    ['预告超过该项时长', [{ id: 'x', label: '坏项', durationMs: 100, warningLeadMs: 101 }], '0 到该项 durationMs（100）'],
  ];
  for (const [, payload, message] of invalidSheets) {
    await importJson(page, payload);
    await expect(page.getByRole('alert')).toContainText(message);
    // 当前有效清单保持不变
    await expect(page.getByTestId('cue-row-a')).toBeVisible();
    await expect(page.getByTestId('cue-row-c')).toBeVisible();
    await expect(page.getByTestId('status')).toContainText('待启动');
  }

  // 指出具体条目序号与字段
  await importJson(page, [
    cues[0],
    { id: 'bad', label: '预告越界', durationMs: 2000, warningLeadMs: 2001 },
  ]);
  await expect(page.getByRole('alert')).toContainText('第 2 项');
  await expect(page.getByRole('alert')).toContainText('warningLeadMs');
  await expect(page.getByTestId('cue-row-bad')).toHaveCount(0);
  await expect(page.getByTestId('status')).toContainText('待启动');
});

test('旧格式清单没有预告提示且时序与原表现一致', async ({ page }) => {
  await importJson(page, cues);

  // 待启动：无当前项，不出现预告徽标
  await expect(page.getByTestId('warning-badge')).toHaveCount(0);

  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');
  // 进行中、当前项为旧项：不出现任何预告徽标，提示行与引入预告前一致
  await expect(page.getByTestId('current')).toHaveText(/当前应执行：开场灯（计划截止 1000 ms）/);
  await expect(page.getByTestId('warning-badge')).toHaveCount(0);

  // 标签页降频、一次性集中处理的原始路径：计划截止与实际处理时刻均与引入预告前一致
  await page.clock.fastForward(7500);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('planned-a')).toHaveText('1000 ms');
  await expect(page.getByTestId('planned-b')).toHaveText('3000 ms');
  await expect(page.getByTestId('planned-c')).toHaveText('6000 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('7500 ms');
  await expect(page.getByTestId('actual-b')).toHaveText('7500 ms');
  await expect(page.getByTestId('actual-c')).toHaveText('7500 ms');
  await expect(page.getByTestId('kind-a')).toHaveText('到期处理');
  await expect(page.getByTestId('kind-b')).toHaveText('到期处理');
  await expect(page.getByTestId('kind-c')).toHaveText('到期处理');
  await expect(page.getByTestId('warning-badge')).toHaveCount(0);
  // 旧格式迟到量照记但不判级，汇总始终 0
  await expect(page.getByTestId('verdict-a')).toContainText('迟到 6500 ms（未设标准）');
  await expect(page.getByTestId('verdict-b')).toContainText('迟到 4500 ms（未设标准）');
  await expect(page.getByTestId('verdict-c')).toContainText('迟到 1500 ms（未设标准）');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');
});

test('含非法编码字节的清单整份拒绝并提示编码异常', async ({ page }) => {
  await importJson(page, cues);
  await expect(page.getByTestId('status')).toContainText('待启动');

  // 构造含非法 UTF-8 字节（0xC0 0xAF 过长编码）的文件：解码后产生 U+FFFD
  // 乱码、JSON 仍能解析，但乱码标签不得作为有效数据载入，整份拒绝
  const buffer = Buffer.concat([
    Buffer.from('[{"id":"bad","label":"追光', 'utf-8'),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from('","durationMs":1000}]', 'utf-8'),
  ]);
  await page.setInputFiles('[data-testid="file-input"]', {
    name: 'bad-encoding.json',
    mimeType: 'application/json',
    buffer,
  });
  await expect(page.getByRole('alert')).toContainText('编码异常');
  // 当前有效清单与状态保持不变
  await expect(page.getByTestId('cue-row-a')).toBeVisible();
  await expect(page.getByTestId('cue-row-c')).toBeVisible();
  await expect(page.getByTestId('cue-row-bad')).toHaveCount(0);
  await expect(page.getByTestId('status')).toContainText('待启动');
});

test('标签合法包含替换字符的清单正常载入，不误报编码异常', async ({ page }) => {
  // 标签中的 U+FFFD 以合法 UTF-8 编码（0xEF 0xBF 0xBD），是原文内容而非解码失败产物
  const buffer = Buffer.concat([
    Buffer.from('[{"id":"a","label":"追光', 'utf-8'),
    Buffer.from([0xef, 0xbf, 0xbd]),
    Buffer.from('灯","durationMs":1000}]', 'utf-8'),
  ]);
  await page.setInputFiles('[data-testid="file-input"]', {
    name: 'legit-replacement-char.json',
    mimeType: 'application/json',
    buffer,
  });
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByTestId('status')).toContainText('待启动');
  await expect(page.getByTestId('cue-row-a')).toBeVisible();
  await expect(page.getByTestId('cue-row-a')).toContainText('追光�灯');
});

test('暂停时先结算已到期项：保留原截止与真实迟到，并定位下一项', async ({ page }) => {
  const thresholdCues = [
    { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 100 },
    { id: 'b', label: '追光', durationMs: 2000 },
    { id: 'c', label: '谢幕', durationMs: 3000 },
  ];
  await importJson(page, thresholdCues);
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');

  // 模拟标签页降频中点击暂停：时钟越过 a 的截止（1000ms）但回调尚未投递
  await page.clock.pauseAt(new Date('2026-09-13T10:00:01.300Z'));
  await page.getByRole('button', { name: '暂停' }).click();

  // a 被结算：保留原计划截止 1000，按暂停时刻记录真实迟到 300 => 超限
  await expect(page.getByTestId('planned-a')).toHaveText('1000 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('1300 ms');
  await expect(page.getByTestId('verdict-a')).toHaveText('迟到 300 ms（超限）');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 1 项');
  // 不停留在过期首项：暂停定位到 b，冻结其真实余量 1700ms
  await expect(page.getByTestId('status')).toContainText('已暂停');
  await expect(page.getByTestId('current')).toContainText('追光');
  await expect(page.getByTestId('current')).toContainText('冻结剩余 1700 ms');

  // 恢复后以冻结余量重建 b 的截止时刻（相对启动 3000ms），b 准时处理
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByTestId('planned-b')).toHaveText('3000 ms');
  await page.clock.runFor(1700);
  await expect(page.getByTestId('actual-b')).toHaveText('3000 ms');
  await expect(page.getByTestId('current')).toContainText('谢幕');
});

test('演练中人工跳过一项：当前提示推进、轨迹类型与超限汇总符合语义，总计划不变', async ({ page }) => {
  await importJson(page, cues);

  // 待启动状态点击跳过：就地说明当前状态，快照不变
  await page.getByRole('button', { name: '跳过当前提示' }).click();
  await expect(page.getByRole('alert')).toContainText('尚未启动');
  await expect(page.getByTestId('status')).toContainText('待启动');
  await expect(page.getByTestId('planned-a')).toHaveText('—');

  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');
  await expect(page.getByTestId('current')).toContainText('开场灯');

  // 进行 400ms 后跳过首项：a 记为人工跳过，当前提示推进到 b，沿原绝对时间线等待
  await page.clock.runFor(400);
  await page.getByRole('button', { name: '跳过当前提示' }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByTestId('current')).toContainText('追光');
  await expect(page.getByTestId('planned-a')).toHaveText('1000 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('400 ms');
  // 处理类型列直接标出人工跳过；判定格说明该项不计算迟到、不参与判定
  await expect(page.getByTestId('kind-a')).toHaveText('人工跳过');
  await expect(page.getByTestId('verdict-a')).toHaveText('人工跳过（不计算迟到，不参与判定）');
  await expect(page.getByTestId('verdict-a')).toHaveAttribute('data-kind', 'skipped');
  // 未处理项的处理类型为占位符
  await expect(page.getByTestId('kind-b')).toHaveText('—');
  await expect(page.getByTestId('planned-b')).toHaveText('3000 ms');
  await expect(page.getByTestId('planned-c')).toHaveText('6000 ms');
  // 跳过项不计算迟到量、不参与超限汇总
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');

  // b 仍在原计划截止 3000ms 到期（跳过没有顺延后续项），处理类型为到期处理
  await page.clock.runFor(2600);
  await expect(page.getByTestId('actual-b')).toHaveText('3000 ms');
  await expect(page.getByTestId('kind-b')).toHaveText('到期处理');
  await expect(page.getByTestId('verdict-b')).toHaveText('迟到 0 ms（未设标准）');
  await expect(page.getByTestId('verdict-b')).toHaveAttribute('data-kind', 'settled');
  await expect(page.getByTestId('current')).toContainText('谢幕');

  // c 到期后完成：最终计划截止与总时长均保持原值
  await page.clock.runFor(3000);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
  await expect(page.getByTestId('done')).toContainText('计划截止 6000 ms');
  await expect(page.getByTestId('done')).toContainText('实际处理 6000 ms');
  await expect(page.getByTestId('kind-c')).toHaveText('到期处理');
  await expect(page.getByTestId('verdict-a')).toHaveText('人工跳过（不计算迟到，不参与判定）');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');

  // 完成后点击跳过：就地说明当前状态，快照不变
  await page.getByRole('button', { name: '跳过当前提示' }).click();
  await expect(page.getByRole('alert')).toContainText('已完成');
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('verdict-a')).toHaveText('人工跳过（不计算迟到，不参与判定）');
});

test('跳过末项直接完成，计划截止保持原值，完成摘要标注人工跳过时刻', async ({ page }) => {
  await importJson(page, cues);
  await page.getByRole('button', { name: '开始' }).click();

  // 前两项按截止到期处理后，在 c 截止前跳过末项
  await page.clock.runFor(1000);
  await expect(page.getByTestId('actual-a')).toHaveText('1000 ms');
  await page.clock.runFor(2000);
  await expect(page.getByTestId('actual-b')).toHaveText('3000 ms');
  await page.clock.runFor(1500); // 4500ms，c@6000 尚未到期
  await page.getByRole('button', { name: '跳过当前提示' }).click();

  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('kind-a')).toHaveText('到期处理');
  await expect(page.getByTestId('kind-b')).toHaveText('到期处理');
  await expect(page.getByTestId('kind-c')).toHaveText('人工跳过');
  await expect(page.getByTestId('verdict-c')).toHaveText('人工跳过（不计算迟到，不参与判定）');
  await expect(page.getByTestId('verdict-c')).toHaveAttribute('data-kind', 'skipped');
  await expect(page.getByTestId('planned-c')).toHaveText('6000 ms');
  await expect(page.getByTestId('actual-c')).toHaveText('4500 ms');
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
  await expect(page.getByTestId('done')).toContainText('计划截止 6000 ms');
  // 末项为人工跳过：完成摘要把提前点击的时刻明确标注为人工跳过时刻，而非实际处理
  await expect(page.getByTestId('done')).toContainText('人工跳过时刻 4500 ms');
  await expect(page.getByTestId('done')).not.toContainText('实际处理');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');
});

test('暂停中点击跳过就地说明状态且快照不变', async ({ page }) => {
  await importJson(page, cues);
  await page.getByRole('button', { name: '开始' }).click();
  await page.clock.runFor(400);
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByTestId('status')).toContainText('已暂停');

  await page.getByRole('button', { name: '跳过当前提示' }).click();
  await expect(page.getByRole('alert')).toContainText('暂停');
  await expect(page.getByTestId('status')).toContainText('已暂停');
  await expect(page.getByTestId('current')).toContainText('冻结剩余 600 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('—');

  // 暂停恢复链路不受影响：暂停期间时间流逝不改变冻结余量，继续后按余量重建截止
  await page.clock.runFor(10000);
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');
  await expect(page.getByTestId('planned-a')).toHaveText('11000 ms');
});

test('延迟回调一次跨过全部项时集中处理并完成', async ({ page }) => {
  await importJson(page, cues);
  await page.getByRole('button', { name: '开始' }).click();

  // 标签页被降频 7.5s，恢复时三项均已过期，回调一次性投递
  await page.clock.fastForward(7500);

  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('planned-a')).toHaveText('1000 ms');
  await expect(page.getByTestId('planned-b')).toHaveText('3000 ms');
  await expect(page.getByTestId('planned-c')).toHaveText('6000 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('7500 ms');
  await expect(page.getByTestId('actual-b')).toHaveText('7500 ms');
  await expect(page.getByTestId('actual-c')).toHaveText('7500 ms');
  // 集中处理的各项在处理类型列均标为到期处理
  await expect(page.getByTestId('kind-a')).toHaveText('到期处理');
  await expect(page.getByTestId('kind-b')).toHaveText('到期处理');
  await expect(page.getByTestId('kind-c')).toHaveText('到期处理');
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
  // 旧格式：各项迟到量照记但无判定，汇总不统计超限
  await expect(page.getByTestId('verdict-a')).toContainText('迟到 6500 ms（未设标准）');
  await expect(page.getByTestId('verdict-b')).toContainText('迟到 4500 ms（未设标准）');
  await expect(page.getByTestId('verdict-c')).toContainText('迟到 1500 ms（未设标准）');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');
});

test('混合新旧字段：制造一次延迟后各行独立判定并汇总超限数', async ({ page }) => {
  // a 阈值 5000（迟到 3500 => 准时）；b 阈值 1000（迟到 1500 => 超限）；c 为旧项无阈值
  const mixedCues = [
    { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 5000 },
    { id: 'b', label: '追光', durationMs: 2000, maxLatenessMs: 1000 },
    { id: 'c', label: '谢幕', durationMs: 3000 },
  ];
  await importJson(page, mixedCues);

  // 待启动：阈值列分别显示配置值与“未设标准”；判定列未处理时显示待判定/未设标准
  await expect(page.getByTestId('threshold-a')).toHaveText('5000 ms');
  await expect(page.getByTestId('threshold-b')).toHaveText('1000 ms');
  await expect(page.getByTestId('threshold-c')).toHaveText('未设标准');
  await expect(page.getByTestId('verdict-a')).toHaveText('待判定');
  await expect(page.getByTestId('verdict-b')).toHaveText('待判定');
  await expect(page.getByTestId('verdict-c')).toHaveText('未设标准');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 0 项');

  await page.getByRole('button', { name: '开始' }).click();

  // 标签页降频：回调被延迟到 4500ms 投递一次，越过 a@1000、b@3000
  await page.clock.fastForward(4500);

  // a：迟到 3500 <= 5000 => 准时；b：迟到 1500 > 1000 => 超限；c 尚未处理
  await expect(page.getByTestId('actual-a')).toHaveText('4500 ms');
  await expect(page.getByTestId('verdict-a')).toHaveText('迟到 3500 ms（准时）');
  await expect(page.getByTestId('actual-b')).toHaveText('4500 ms');
  await expect(page.getByTestId('verdict-b')).toHaveText('迟到 1500 ms（超限）');
  await expect(page.getByTestId('actual-c')).toHaveText('—');
  await expect(page.getByTestId('verdict-c')).toHaveText('未设标准');
  // 进行中即展示汇总：仅 b 超限
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 1 项');

  // c 在原计划截止 6000ms 准时到期：绝对截止不因延迟漂移；无阈值不判级
  await page.clock.runFor(1500);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('actual-c')).toHaveText('6000 ms');
  await expect(page.getByTestId('verdict-c')).toHaveText('迟到 0 ms（未设标准）');
  await expect(page.getByTestId('lateness-summary')).toContainText('超限 1 项');
});

test('非法 maxLatenessMs 就地指出条目与字段且保留当前清单', async ({ page }) => {
  await importJson(page, cues);
  await importJson(page, [
    { id: 'a', label: '开场灯', durationMs: 1000 },
    { id: 'bad', label: '阈值缺失', durationMs: 100, maxLatenessMs: 700000 },
  ]);
  await expect(page.getByRole('alert')).toContainText('第 2 项');
  await expect(page.getByRole('alert')).toContainText('maxLatenessMs');
  // 当前清单与运行状态保持不变
  await expect(page.getByTestId('cue-row-a')).toBeVisible();
  await expect(page.getByTestId('cue-row-c')).toBeVisible();
  await expect(page.getByTestId('cue-row-bad')).toHaveCount(0);
  await expect(page.getByTestId('status')).toContainText('待启动');
});

test('混合清单含通道冲突：双向标记与重叠范围，完成演练后轨迹仍显示', async ({ page }) => {
  // a 占 1–10，b 占 8–17（与 a 重叠 8–10），c 占 20–23（可用），d 为未配接旧项
  const channelCues = [
    { id: 'a', label: '开场灯', durationMs: 1000, channelStart: 1, channelCount: 10 },
    { id: 'b', label: '追光', durationMs: 2000, channelStart: 8, channelCount: 10 },
    { id: 'c', label: '洗墙灯', durationMs: 3000, channelStart: 20, channelCount: 4 },
    { id: 'd', label: '谢幕', durationMs: 1000 },
  ];
  await importJson(page, channelCues);
  await expect(page.getByTestId('status')).toContainText('待启动');

  // 通道区间列：已配接项显示闭区间，旧项显示未配接
  await expect(page.getByTestId('channels-a')).toHaveText('1–10');
  await expect(page.getByTestId('channels-b')).toHaveText('8–17');
  await expect(page.getByTestId('channels-c')).toHaveText('20–23');
  await expect(page.getByTestId('channels-d')).toHaveText('未配接');

  // 冲突双向标记：双方都标为冲突并列出对方标签与重叠范围
  await expect(page.getByTestId('channel-check-a')).toHaveText('冲突：与「追光」重叠 8–10');
  await expect(page.getByTestId('channel-check-a')).toHaveAttribute(
    'data-channel-status',
    'conflict',
  );
  await expect(page.getByTestId('channel-check-b')).toHaveText('冲突：与「开场灯」重叠 8–10');
  await expect(page.getByTestId('channel-check-b')).toHaveAttribute(
    'data-channel-status',
    'conflict',
  );
  // 无重叠项标为可用，未配置的旧项标为未配接
  await expect(page.getByTestId('channel-check-c')).toHaveText('可用');
  await expect(page.getByTestId('channel-check-c')).toHaveAttribute(
    'data-channel-status',
    'available',
  );
  await expect(page.getByTestId('channel-check-d')).toHaveText('未配接');
  await expect(page.getByTestId('channel-check-d')).toHaveAttribute(
    'data-channel-status',
    'unassigned',
  );
  await expect(page.getByTestId('channel-summary')).toContainText('冲突 2 项');

  // 通道检查只作联排提示：演练照常开始、暂停、恢复并完成
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');
  await page.clock.runFor(400);
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByTestId('status')).toContainText('已暂停');
  await expect(page.getByTestId('current')).toContainText('冻结剩余 600 ms');
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByTestId('status')).toContainText('进行中');

  // 标签页降频：回调延迟投递，集中处理已到期项，整段演练不被顺延
  await page.clock.fastForward(16600);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('done')).toContainText('计划总时长 7000 ms');

  // 完成轨迹中仍显示通道检查结论（双向标记与重叠范围不随处理状态消失）
  await expect(page.getByTestId('channel-check-a')).toHaveText('冲突：与「追光」重叠 8–10');
  await expect(page.getByTestId('channel-check-b')).toHaveText('冲突：与「开场灯」重叠 8–10');
  await expect(page.getByTestId('channel-check-c')).toHaveText('可用');
  await expect(page.getByTestId('channel-check-d')).toHaveText('未配接');
  await expect(page.getByTestId('channel-summary')).toContainText('冲突 2 项');
});

test('非法通道配接整份拒绝并保留当前清单', async ({ page }) => {
  const validChannelCues = [
    { id: 'a', label: '开场灯', durationMs: 1000, channelStart: 1, channelCount: 8 },
    { id: 'b', label: '追光', durationMs: 2000 },
  ];
  await importJson(page, validChannelCues);
  await expect(page.getByTestId('status')).toContainText('待启动');
  await expect(page.getByTestId('channels-a')).toHaveText('1–8');
  await expect(page.getByTestId('channel-check-a')).toHaveText('可用');

  const invalidSheets: Array<[string, unknown, string]> = [
    ['只出现起始通道', [{ id: 'x', label: '坏项', durationMs: 100, channelStart: 1 }], '必须同时出现'],
    ['只出现通道数量', [{ id: 'x', label: '坏项', durationMs: 100, channelCount: 4 }], '必须同时出现'],
    ['起始通道为 0', [{ id: 'x', label: '坏项', durationMs: 100, channelStart: 0, channelCount: 1 }], 'channelStart'],
    ['起始通道超过 512', [{ id: 'x', label: '坏项', durationMs: 100, channelStart: 513, channelCount: 1 }], 'channelStart'],
    ['通道数量为 0', [{ id: 'x', label: '坏项', durationMs: 100, channelStart: 1, channelCount: 0 }], 'channelCount'],
    ['通道数量非整数', [{ id: 'x', label: '坏项', durationMs: 100, channelStart: 1, channelCount: 2.5 }], 'channelCount'],
    ['结束通道超过 512', [{ id: 'x', label: '坏项', durationMs: 100, channelStart: 510, channelCount: 10 }], '结束通道'],
  ];
  for (const [, payload, message] of invalidSheets) {
    await importJson(page, payload);
    await expect(page.getByRole('alert')).toContainText(message);
    // 当前有效清单（含通道配接）与状态保持不变
    await expect(page.getByTestId('cue-row-a')).toBeVisible();
    await expect(page.getByTestId('cue-row-b')).toBeVisible();
    await expect(page.getByTestId('channels-a')).toHaveText('1–8');
    await expect(page.getByTestId('channel-check-a')).toHaveText('可用');
    await expect(page.getByTestId('status')).toContainText('待启动');
  }
});

test('无配接旧清单全部标为未配接，演练行为不变', async ({ page }) => {
  await importJson(page, cues);
  await expect(page.getByTestId('channels-a')).toHaveText('未配接');
  await expect(page.getByTestId('channels-b')).toHaveText('未配接');
  await expect(page.getByTestId('channels-c')).toHaveText('未配接');
  await expect(page.getByTestId('channel-check-a')).toHaveText('未配接');
  await expect(page.getByTestId('channel-check-c')).toHaveText('未配接');
  await expect(page.getByTestId('channel-summary')).toContainText('冲突 0 项');

  // 旧格式清单仍可直接演练：延迟回调集中处理，照常完成
  await page.getByRole('button', { name: '开始' }).click();
  await page.clock.fastForward(7500);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('7500 ms');
  // 完成轨迹中通道列保持未配接，迟到记录行为不变
  await expect(page.getByTestId('channel-check-b')).toHaveText('未配接');
  await expect(page.getByTestId('verdict-a')).toContainText('迟到 6500 ms（未设标准）');
  await expect(page.getByTestId('channel-summary')).toContainText('冲突 0 项');
});
