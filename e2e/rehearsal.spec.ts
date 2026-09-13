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

  const invalidSheets: Array<[string, unknown, string]> = [
    ['时长越界', [{ id: 'x', label: '坏项', durationMs: 50 }], 'durationMs'],
    ['id 重复', [...cues, { id: 'a', label: '重复', durationMs: 100 }], '重复'],
    ['数字与文本同一 id', [{ id: 1, label: '数字', durationMs: 100 }, { id: '1', label: '文本', durationMs: 100 }], '重复'],
    ['含额外字段', [{ id: 'x', label: '多字段', durationMs: 100, note: 1 }], '不允许的字段'],
    ['label 为空', [{ id: 'x', label: '  ', durationMs: 100 }], '非空字符串'],
    ['时长非整数', [{ id: 'x', label: '小数', durationMs: 100.5 }], '整数'],
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
  await expect(page.getByTestId('planned-a')).toHaveText('11000 ms');
  await expect(page.getByTestId('actual-a')).toHaveText('14500 ms');
  await expect(page.getByTestId('planned-b')).toHaveText('13000 ms');
  await expect(page.getByTestId('actual-b')).toHaveText('14500 ms');
  await expect(page.getByTestId('current')).toContainText('谢幕');
  await expect(page.getByTestId('planned-c')).toHaveText('16000 ms');
  await expect(page.getByTestId('actual-c')).toHaveText('—');

  // c 仍在原计划截止时刻到期：长延迟虽造成集中处理，却没有延长整段演练
  await page.clock.runFor(1500);
  await expect(page.getByTestId('status')).toContainText('已完成');
  await expect(page.getByTestId('actual-c')).toHaveText('16000 ms');
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
  await expect(page.getByTestId('done')).toContainText('计划截止 16000 ms');
  await expect(page.getByTestId('done')).toContainText('实际处理 16000 ms');

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
  await expect(page.getByTestId('done')).toContainText('计划总时长 6000 ms');
});
