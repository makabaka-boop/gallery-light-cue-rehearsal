import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import { RehearsalEngine, RehearsalError } from './engine';
import type { CueItem } from './types';

class ManualClock implements Clock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }

  jumpTo(ms: number): number {
    this.current = ms;
    return this.current;
  }
}

const cues: CueItem[] = [
  { id: 'a', label: '开场灯', durationMs: 1000 },
  { id: 'b', label: '追光', durationMs: 2000 },
  { id: 'c', label: '谢幕', durationMs: 3000 },
];

function setup() {
  const clock = new ManualClock();
  const engine = new RehearsalEngine(clock);
  return { clock, engine };
}

function loaded() {
  const { clock, engine } = setup();
  engine.load(cues);
  return { clock, engine };
}

describe('载入与启动', () => {
  it('未载入时启动就地报错且状态不变', () => {
    const { engine } = setup();
    expect(() => engine.start()).toThrow(RehearsalError);
    expect(() => engine.start()).toThrow('尚未导入提示清单');
    expect(engine.getSnapshot().status).toBe('idle');
  });

  it('载入后进入待启动，空清单被拒绝', () => {
    const { engine } = setup();
    expect(() => engine.load([])).toThrow('提示清单不能为空');
    expect(engine.getSnapshot().status).toBe('idle');
    engine.load(cues);
    const snap = engine.getSnapshot();
    expect(snap.status).toBe('ready');
    expect(snap.rows).toHaveLength(3);
    expect(snap.totalDurationMs).toBe(6000);
    expect(snap.rows.every((row) => row.plannedAtMs === null)).toBe(true);
  });

  it('启动后按计划给出各项截止时刻', () => {
    const { engine } = loaded();
    expect(engine.start()).toBe(1000);
    const snap = engine.getSnapshot();
    expect(snap.status).toBe('running');
    expect(snap.currentIndex).toBe(0);
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([1000, 3000, 6000]);
  });
});

describe('正常逐项到期', () => {
  it('截止前回调不记录轨迹，到期后按序记录并完成', () => {
    const { clock, engine } = loaded();
    engine.start();

    clock.advance(999);
    expect(engine.handleTimer()).toBe(1); // 尚未到期，返回剩余毫秒
    expect(engine.getSnapshot().rows[0].actualAtMs).toBeNull();

    clock.advance(1);
    expect(engine.handleTimer()).toBe(2000);
    clock.advance(2000);
    expect(engine.handleTimer()).toBe(3000);
    clock.advance(3000);
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([1000, 3000, 6000]);
    expect(snap.rows.map((row) => row.actualAtMs)).toEqual([1000, 3000, 6000]);
    expect(snap.finishedAtMs).toBe(6000);
    expect(snap.currentIndex).toBeNull();
  });
});

describe('延迟回调（标签页降频）', () => {
  it('跨过多项时按各自截止时刻依次记录，并直接推进当前应执行项', () => {
    const { clock, engine } = loaded();
    engine.start();
    // 回调被延迟到 4500ms 才投递：越过 a@1000、b@3000，未到 c@6000
    clock.jumpTo(4500);
    expect(engine.handleTimer()).toBe(1500);

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('running');
    expect(snap.currentIndex).toBe(2); // 当前应执行项直接落到 c
    expect(snap.rows[0]).toMatchObject({ plannedAtMs: 1000, actualAtMs: 4500 });
    expect(snap.rows[1]).toMatchObject({ plannedAtMs: 3000, actualAtMs: 4500 });
    expect(snap.rows[2]).toMatchObject({ plannedAtMs: 6000, actualAtMs: null });
  });

  it('长延迟造成集中处理，但不延长整段演练', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(4500);
    engine.handleTimer(); // a、b 在 4500 被集中处理
    clock.advance(1500); // 到 6000，c 按原计划截止时刻到期
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    // c 的实际处理时刻仍是原计划的 6000，延迟没有顺延整段演练
    expect(snap.rows[2]).toMatchObject({ plannedAtMs: 6000, actualAtMs: 6000 });
    expect(snap.finishedAtMs).toBe(6000);
  });

  it('回调迟到不会让后续截止时刻漂移（不靠递减 tick 累计）', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(1300); // a 的回调迟到 300ms
    const nextDelay = engine.handleTimer();
    // b 的截止时刻仍是绝对时刻 3000，而不是从回调时刻再数 2000
    expect(nextDelay).toBe(1700);
    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({ plannedAtMs: 1000, actualAtMs: 1300 });
    expect(snap.rows[1].plannedAtMs).toBe(3000);
  });

  it('一次延迟跨过全部项时直接完成', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(100000);
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([1000, 3000, 6000]);
    expect(snap.rows.map((row) => row.actualAtMs)).toEqual([100000, 100000, 100000]);
    expect(snap.finishedAtMs).toBe(100000);
  });
});

describe('迟到判定（maxLatenessMs）', () => {
  it('准时处理时迟到量为 0，零容忍阈值也判定准时', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 0 }]);
    engine.start();
    clock.advance(1000);
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({
      plannedAtMs: 1000,
      actualAtMs: 1000,
      latenessMs: 0,
      latenessVerdict: 'on-time',
    });
    expect(snap.overLimitCount).toBe(0);
  });

  it('阈值边界：迟到量等于阈值判准时，超过一毫判超限', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 300 },
      { id: 'b', label: '追光', durationMs: 2000, maxLatenessMs: 300 },
    ]);
    engine.start();
    // a 在 1300 处理，迟到恰为 300，等于阈值 => 准时
    clock.jumpTo(1300);
    expect(engine.handleTimer()).toBe(1700);
    expect(engine.getSnapshot().rows[0]).toMatchObject({
      latenessMs: 300,
      latenessVerdict: 'on-time',
    });
    expect(engine.getSnapshot().overLimitCount).toBe(0);

    // b 在 3301 处理，迟到 301（实际 3301 - 计划 3000），超过阈值 300 => 超限
    clock.jumpTo(3301);
    expect(engine.handleTimer()).toBeNull();
    const snap = engine.getSnapshot();
    expect(snap.rows[1]).toMatchObject({
      plannedAtMs: 3000,
      actualAtMs: 3301,
      latenessMs: 301,
      latenessVerdict: 'over-limit',
    });
    expect(snap.overLimitCount).toBe(1);
  });

  it('一次延迟跨过多项时按各项阈值独立判定，未配置阈值的项只记录不判级', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 5000 }, // 迟到 3500 <= 5000 准时
      { id: 'b', label: '追光', durationMs: 2000, maxLatenessMs: 1000 }, // 迟到 1500 > 1000 超限
      { id: 'c', label: '谢幕', durationMs: 3000 }, // 未设阈值，记录但不判级
    ]);
    engine.start();
    clock.jumpTo(4500); // 一次回调越过 a@1000、b@3000
    engine.handleTimer();

    let snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({ latenessMs: 3500, latenessVerdict: 'on-time' });
    expect(snap.rows[1]).toMatchObject({ latenessMs: 1500, latenessVerdict: 'over-limit' });
    expect(snap.rows[2]).toMatchObject({
      latenessMs: null,
      latenessVerdict: null,
      maxLatenessMs: null,
    });
    expect(snap.overLimitCount).toBe(1); // 仅 b 超限，未设阈值的 c 尚未处理

    clock.advance(1500); // c@6000 准时
    expect(engine.handleTimer()).toBeNull();
    snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows[2]).toMatchObject({
      plannedAtMs: 6000,
      actualAtMs: 6000,
      latenessMs: 0,
      latenessVerdict: null,
    });
    // 未配置阈值的项即使迟到也不计入超限数量
    expect(snap.overLimitCount).toBe(1);
  });

  it('旧清单（均无阈值）只记录迟到量，全部不判级、超限数始终为零', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(100000);
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.rows.map((row) => row.latenessMs)).toEqual([99000, 97000, 94000]);
    expect(snap.rows.every((row) => row.latenessVerdict === null)).toBe(true);
    expect(snap.rows.every((row) => row.maxLatenessMs === null)).toBe(true);
    expect(snap.overLimitCount).toBe(0);
  });

  it('暂停恢复后以重建的截止时刻计算迟到量，判定规则不变', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 100 }]);
    engine.start();
    clock.advance(400);
    engine.pause();
    clock.advance(10000); // 暂停期间不计时
    engine.resume(); // 新截止时刻 = 11000
    // 回调延迟到 11150：相对新截止迟到 150，超过 100 => 超限
    clock.advance(750); // 11150
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({
      plannedAtMs: 11000,
      actualAtMs: 11150,
      latenessMs: 150,
      latenessVerdict: 'over-limit',
    });
    expect(snap.overLimitCount).toBe(1);
  });
});

describe('到期预告（warningLeadMs）', () => {
  it('启动即安排到预告点：预告点前等待预告，跨过预告点变即将到期，截止仍按原规则结算', () => {
    const { clock, engine } = setup();
    // a 时长 1000、提前 300 预告：预告点 = 700，截止 = 1000
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }]);
    expect(engine.start()).toBe(700); // 首次定时安排到预告点，而非截止点

    clock.advance(699);
    let snap = engine.getSnapshot();
    expect(snap.currentWarning).toBe('waiting');
    expect(snap.currentRemainingMs).toBe(301);
    expect(snap.rows[0]).toMatchObject({ warningLeadMs: 300, actualAtMs: null });

    // 预告点之前的回调不结算，返回距预告点的余量
    expect(engine.handleTimer()).toBe(1);
    expect(engine.getSnapshot().currentWarning).toBe('waiting');

    clock.advance(1); // 700：到达预告点
    expect(engine.handleTimer()).toBe(300); // 下一个事件是截止点，返回 300
    snap = engine.getSnapshot();
    expect(snap.currentWarning).toBe('due-soon');
    expect(snap.currentRemainingMs).toBe(300);
    expect(snap.rows[0].actualAtMs).toBeNull(); // 预告只标记，不结算

    clock.advance(299);
    expect(engine.handleTimer()).toBe(1);
    expect(engine.getSnapshot().currentWarning).toBe('due-soon');

    clock.advance(1); // 1000：到达原截止点，按既有规则结算
    expect(engine.handleTimer()).toBeNull();
    snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.currentWarning).toBeNull();
    expect(snap.rows[0]).toMatchObject({
      plannedAtMs: 1000,
      actualAtMs: 1000,
      kind: 'settled',
      latenessMs: 0,
    });
  });

  it('多项各自独立预告：前项结算后，下一项先等待预告再即将到期', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }, // 预告 700，截止 1000
      { id: 'b', label: '追光', durationMs: 2000, warningLeadMs: 500 }, // 预告 2500，截止 3000
    ]);
    engine.start();

    clock.advance(700);
    expect(engine.handleTimer()).toBe(300);
    expect(engine.getSnapshot().currentWarning).toBe('due-soon');

    clock.advance(300); // a@1000 结算；b 的预告点 2500 尚远
    expect(engine.handleTimer()).toBe(1500);
    let snap = engine.getSnapshot();
    expect(snap.currentIndex).toBe(1);
    expect(snap.currentWarning).toBe('waiting');

    clock.advance(1500); // 到 2500：b 预告点
    expect(engine.handleTimer()).toBe(500);
    expect(engine.getSnapshot().currentWarning).toBe('due-soon');

    clock.advance(500); // b@3000 截止
    expect(engine.handleTimer()).toBeNull();
    snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows.map((row) => row.actualAtMs)).toEqual([1000, 3000]);
  });

  it('一次延迟回调同时跨过预告点与截止点：直接结算，当前项推进且后续截止不被改写', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }, // 预告 700，截止 1000
      { id: 'b', label: '追光', durationMs: 2000, warningLeadMs: 500 }, // 预告 2500，截止 3000
    ]);
    engine.start();
    // 回调被延迟到 2700 才投递：越过 a 的预告点 700 与截止 1000（a 结算），
    // 并越过 b 的预告点 2500 但未到 b 的截止 3000（b 直接呈现“即将到期”）
    clock.jumpTo(2700);
    expect(engine.handleTimer()).toBe(300);

    const snap = engine.getSnapshot();
    expect(snap.currentIndex).toBe(1);
    expect(snap.currentWarning).toBe('due-soon'); // 依据当前绝对时刻推进，错过的预告点不补发
    expect(snap.rows[0]).toMatchObject({ plannedAtMs: 1000, actualAtMs: 2700, kind: 'settled' });
    expect(snap.rows[1]).toMatchObject({ plannedAtMs: 3000, actualAtMs: null });

    clock.advance(300); // b 仍按原截止时刻 3000 结算
    expect(engine.handleTimer()).toBeNull();
    expect(engine.getSnapshot().rows[1]).toMatchObject({ plannedAtMs: 3000, actualAtMs: 3000 });
  });

  it('一次延迟回调跨过预告点但未到截止点：仅标记即将到期，不产生轨迹', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }]);
    engine.start();
    clock.jumpTo(850); // 越过预告点 700，未到截止 1000
    expect(engine.handleTimer()).toBe(150);
    const snap = engine.getSnapshot();
    expect(snap.currentWarning).toBe('due-soon');
    expect(snap.currentRemainingMs).toBe(150);
    expect(snap.rows[0].actualAtMs).toBeNull();
  });

  it('等待预告期间暂停冻结预告进度，恢复后按剩余时间重建预告边界', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }]);
    engine.start();
    clock.advance(400); // 余量 600 > 预告量 300：等待预告
    engine.pause();

    let snap = engine.getSnapshot();
    expect(snap.status).toBe('paused');
    expect(snap.currentRemainingMs).toBe(600);
    expect(snap.currentWarning).toBe('waiting'); // 预告进度冻结在“等待预告”

    clock.advance(10000); // 暂停期间不计时
    snap = engine.getSnapshot();
    expect(snap.currentRemainingMs).toBe(600);
    expect(snap.currentWarning).toBe('waiting');

    expect(engine.resume()).toBe(300); // 新预告点 = 恢复时刻 + (600 - 300)
    snap = engine.getSnapshot();
    expect(snap.currentWarning).toBe('waiting');
    expect(snap.rows[0].plannedAtMs).toBe(11000);

    clock.advance(300); // 10700：到达重建后的预告点
    expect(engine.handleTimer()).toBe(300);
    expect(engine.getSnapshot().currentWarning).toBe('due-soon');

    clock.advance(300); // 11000：截止
    expect(engine.handleTimer()).toBeNull();
    expect(engine.getSnapshot().rows[0]).toMatchObject({ plannedAtMs: 11000, actualAtMs: 11000 });
  });

  it('即将到期期间暂停：冻结为即将到期，恢复后仍在即将到期并按重建截止结算', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }]);
    engine.start();
    clock.advance(800); // 余量 200 <= 300：即将到期
    engine.pause();

    let snap = engine.getSnapshot();
    expect(snap.currentWarning).toBe('due-soon');
    expect(snap.currentRemainingMs).toBe(200);

    clock.advance(10000);
    expect(engine.getSnapshot().currentWarning).toBe('due-soon');

    expect(engine.resume()).toBe(200); // 预告点已在过去，下一个事件即截止
    snap = engine.getSnapshot();
    expect(snap.currentWarning).toBe('due-soon');

    clock.advance(200);
    expect(engine.handleTimer()).toBeNull();
    expect(engine.getSnapshot().rows[0]).toMatchObject({ plannedAtMs: 11000, actualAtMs: 11000 });
  });

  it('暂停时刻已越过预告点但未到截止：按即将到期冻结，预告状态不回退', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }]);
    engine.start();
    clock.jumpTo(850);
    engine.pause();
    const snap = engine.getSnapshot();
    expect(snap.status).toBe('paused');
    expect(snap.currentWarning).toBe('due-soon');
    expect(snap.currentRemainingMs).toBe(150);
  });

  it('暂停时刻跨过预告点与截止点：照常结算并完成，不残留预告状态', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }]);
    engine.start();
    clock.jumpTo(1200);
    engine.pause();
    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.currentWarning).toBeNull();
    expect(snap.rows[0]).toMatchObject({ plannedAtMs: 1000, actualAtMs: 1200 });
  });

  it('等待预告与即将到期期间跳过：均记为人工跳过，随后沿原时间线安排下一项预告', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 300 }, // 预告 700
      { id: 'b', label: '追光', durationMs: 2000, warningLeadMs: 500 }, // 预告 2500
    ]);
    engine.start();

    clock.advance(400); // a 等待预告时跳过
    expect(engine.skip()).toBe(2100); // 下一项 b 预告点 2500 - 当前 400
    let snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({ kind: 'skipped', latenessMs: null });
    expect(snap.currentIndex).toBe(1);
    expect(snap.currentWarning).toBe('waiting');

    clock.jumpTo(2700); // 越过 b 预告点 2500：即将到期时跳过
    expect(engine.skip()).toBeNull(); // b 是末项，直接完成
    snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows[1]).toMatchObject({ kind: 'skipped', plannedAtMs: 3000, actualAtMs: 2700 });
  });

  it('warningLeadMs 为 0：预告点即截止点，等待预告直到截止、结算时直接完成', () => {
    const { clock, engine } = setup();
    engine.load([{ id: 'a', label: '开场灯', durationMs: 1000, warningLeadMs: 0 }]);
    expect(engine.start()).toBe(1000); // 预告点 = 截止点

    clock.advance(999);
    let snap = engine.getSnapshot();
    expect(snap.currentWarning).toBe('waiting');
    expect(engine.handleTimer()).toBe(1);

    clock.advance(1);
    expect(engine.handleTimer()).toBeNull();
    snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows[0]).toMatchObject({ plannedAtMs: 1000, actualAtMs: 1000 });
  });

  it('预告不影响迟到判定、超限汇总与暂停恢复后的迟到量', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 100, warningLeadMs: 300 },
    ]);
    engine.start();
    clock.advance(400); // 余量 600 > 300：等待预告
    engine.pause(); // 冻结余量 600
    clock.advance(10000); // 暂停期间不计时
    engine.resume(); // 恢复于 10400；新截止 11000，新预告点 10700
    clock.advance(300); // 到 10700：预告点，仍未到期
    expect(engine.handleTimer()).toBe(300);
    expect(engine.getSnapshot().currentWarning).toBe('due-soon');
    // 回调延迟到 11150 才投递：相对新截止迟到 150 > 100 => 超限
    clock.advance(450);
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({
      plannedAtMs: 11000,
      actualAtMs: 11150,
      latenessMs: 150,
      latenessVerdict: 'over-limit',
    });
    expect(snap.overLimitCount).toBe(1);
  });

  it('未配置 warningLeadMs 的旧清单：快照无预告状态，首次定时仍安排到截止点', () => {
    const { clock, engine } = loaded();
    expect(engine.start()).toBe(1000);
    let snap = engine.getSnapshot();
    expect(snap.currentWarning).toBeNull();
    expect(snap.rows.every((row) => row.warningLeadMs === null)).toBe(true);

    clock.advance(400);
    engine.pause();
    snap = engine.getSnapshot();
    expect(snap.currentWarning).toBeNull();
    expect(snap.currentRemainingMs).toBe(600);
    expect(engine.resume()).toBe(600);
    expect(engine.getSnapshot().currentWarning).toBeNull();

    clock.jumpTo(100000);
    expect(engine.handleTimer()).toBeNull();
    expect(engine.getSnapshot().currentWarning).toBeNull();
  });
});

describe('暂停与恢复', () => {
  it('暂停只冻结当前项剩余毫秒，恢复以该余量建立新截止时刻', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.advance(400);
    engine.pause();

    let snap = engine.getSnapshot();
    expect(snap.status).toBe('paused');
    expect(snap.currentRemainingMs).toBe(600);
    expect(snap.rows[0].plannedAtMs).toBeNull(); // 暂停期间计划待定

    clock.advance(10000); // 暂停期间时间流逝不影响冻结余量
    snap = engine.getSnapshot();
    expect(snap.currentRemainingMs).toBe(600);
    expect(snap.rows[0].actualAtMs).toBeNull();

    expect(engine.resume()).toBe(600);
    snap = engine.getSnapshot();
    // 新截止时刻 = 10400 + 600 = 11000（相对启动），后续项依次累加
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([11000, 13000, 16000]);

    clock.advance(600);
    expect(engine.handleTimer()).toBe(2000);
    expect(engine.getSnapshot().rows[0]).toMatchObject({ plannedAtMs: 11000, actualAtMs: 11000 });
  });

  it('暂停中定时回调报错且状态不变', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.advance(400);
    engine.pause();
    expect(() => engine.handleTimer()).toThrow('不在进行中');
    const snap = engine.getSnapshot();
    expect(snap.status).toBe('paused');
    expect(snap.currentRemainingMs).toBe(600);
  });

  it('首项已过期但回调未处理时暂停：保留原截止并记录真实迟到，恢复后定位下一项', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 100 },
      { id: 'b', label: '追光', durationMs: 2000 },
      { id: 'c', label: '谢幕', durationMs: 3000 },
    ]);
    engine.start();
    clock.jumpTo(1300); // a@1000 已过期 300ms，回调尚未投递
    engine.pause();

    let snap = engine.getSnapshot();
    // a 被结算：保留原计划截止 1000，按暂停时刻记录真实迟到 300 => 超限
    expect(snap.rows[0]).toMatchObject({
      plannedAtMs: 1000,
      actualAtMs: 1300,
      latenessMs: 300,
      latenessVerdict: 'over-limit',
    });
    expect(snap.overLimitCount).toBe(1);
    // 不停留在过期首项：当前项定位到 b，冻结其真实余量 1700
    expect(snap.status).toBe('paused');
    expect(snap.currentIndex).toBe(1);
    expect(snap.currentRemainingMs).toBe(1700);

    // 恢复后以冻结余量重建 b 的截止时刻，b 准时处理
    expect(engine.resume()).toBe(1700);
    snap = engine.getSnapshot();
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([1000, 3000, 6000]);
    clock.advance(1700);
    expect(engine.handleTimer()).toBe(3000);
    expect(engine.getSnapshot().rows[1]).toMatchObject({ plannedAtMs: 3000, actualAtMs: 3000 });
  });

  it('暂停时逐项结算连续到期的多项，再冻结第一个未到期项', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(4500); // a@1000、b@3000 均已到期，c@6000 未到期
    engine.pause();

    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({ plannedAtMs: 1000, actualAtMs: 4500, latenessMs: 3500 });
    expect(snap.rows[1]).toMatchObject({ plannedAtMs: 3000, actualAtMs: 4500, latenessMs: 1500 });
    expect(snap.status).toBe('paused');
    expect(snap.currentIndex).toBe(2);
    expect(snap.currentRemainingMs).toBe(1500);
  });

  it('暂停时全部项均已到期则直接完成', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(100000);
    engine.pause();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows.map((row) => row.actualAtMs)).toEqual([100000, 100000, 100000]);
    expect(snap.finishedAtMs).toBe(100000);
    expect(() => engine.resume()).toThrow('无法继续');
  });
});

describe('通道占用检查（channelStart/channelCount）', () => {
  const dmx = (id: string, label: string, channelStart: number, channelCount: number): CueItem => ({
    id,
    label,
    durationMs: 1000,
    channelStart,
    channelCount,
  });

  it('无重叠时已配置项全部标为可用，未配置项标为未配接', () => {
    const { engine } = setup();
    engine.load([
      dmx('a', '开场灯', 1, 8), // 1–8
      dmx('b', '追光', 9, 8), // 9–16
      { id: 'c', label: '谢幕', durationMs: 1000 }, // 未配接
    ]);
    const snap = engine.getSnapshot();
    expect(snap.rows.map((row) => row.channelCheck.status)).toEqual([
      'available',
      'available',
      'unassigned',
    ]);
    expect(snap.rows[0].channelCheck.conflicts).toEqual([]);
    expect(snap.rows[2].channelCheck.conflicts).toEqual([]);
    expect(snap.channelConflictCount).toBe(0);
  });

  it('快照行携带通道区间，未配接项为 null', () => {
    const { engine } = setup();
    engine.load([dmx('a', '开场灯', 3, 4), { id: 'b', label: '追光', durationMs: 1000 }]);
    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({ channelStart: 3, channelCount: 4 });
    expect(snap.rows[1]).toMatchObject({ channelStart: null, channelCount: null });
  });

  it('端点相交按闭区间判定为冲突，双方互相列出对方与重叠范围', () => {
    const { engine } = setup();
    engine.load([
      dmx('a', '开场灯', 1, 5), // 1–5
      dmx('b', '追光', 5, 6), // 5–10，端点 5 相接
    ]);
    const snap = engine.getSnapshot();
    expect(snap.rows[0].channelCheck).toEqual({
      status: 'conflict',
      conflicts: [{ id: 'b', label: '追光', overlapStart: 5, overlapEnd: 5 }],
    });
    expect(snap.rows[1].channelCheck).toEqual({
      status: 'conflict',
      conflicts: [{ id: 'a', label: '开场灯', overlapStart: 5, overlapEnd: 5 }],
    });
    expect(snap.channelConflictCount).toBe(2);
  });

  it('端点相邻但不相交不算冲突', () => {
    const { engine } = setup();
    engine.load([
      dmx('a', '开场灯', 1, 5), // 1–5
      dmx('b', '追光', 6, 5), // 6–10，与上一项首尾相邻
    ]);
    const snap = engine.getSnapshot();
    expect(snap.rows.every((row) => row.channelCheck.status === 'available')).toBe(true);
    expect(snap.channelConflictCount).toBe(0);
  });

  it('多项冲突：一项与多项重叠时全部列出，冲突双方均被标记', () => {
    const { engine } = setup();
    engine.load([
      dmx('a', '开场灯', 1, 10), // 1–10，与 b、c 均重叠
      dmx('b', '追光', 5, 10), // 5–14，与 a 重叠 5–10
      dmx('c', '洗墙灯', 8, 20), // 8–27，与 a 重叠 8–10、与 b 重叠 8–14
      dmx('d', '谢幕', 100, 4), // 100–103，无重叠
      { id: 'e', label: '旧项', durationMs: 1000 }, // 未配接，不参与比较
    ]);
    const snap = engine.getSnapshot();
    expect(snap.rows[0].channelCheck).toEqual({
      status: 'conflict',
      conflicts: [
        { id: 'b', label: '追光', overlapStart: 5, overlapEnd: 10 },
        { id: 'c', label: '洗墙灯', overlapStart: 8, overlapEnd: 10 },
      ],
    });
    expect(snap.rows[1].channelCheck).toEqual({
      status: 'conflict',
      conflicts: [
        { id: 'a', label: '开场灯', overlapStart: 5, overlapEnd: 10 },
        { id: 'c', label: '洗墙灯', overlapStart: 8, overlapEnd: 14 },
      ],
    });
    expect(snap.rows[2].channelCheck).toEqual({
      status: 'conflict',
      conflicts: [
        { id: 'a', label: '开场灯', overlapStart: 8, overlapEnd: 10 },
        { id: 'b', label: '追光', overlapStart: 8, overlapEnd: 14 },
      ],
    });
    expect(snap.rows[3].channelCheck.status).toBe('available');
    expect(snap.rows[4].channelCheck.status).toBe('unassigned');
    expect(snap.channelConflictCount).toBe(3);
  });

  it('包含关系按重叠闭区间报告范围', () => {
    const { engine } = setup();
    engine.load([
      dmx('a', '主灯', 10, 50), // 10–59
      dmx('b', '灯带', 20, 5), // 20–24，被 a 包含
    ]);
    const snap = engine.getSnapshot();
    expect(snap.rows[0].channelCheck.conflicts).toEqual([
      { id: 'b', label: '灯带', overlapStart: 20, overlapEnd: 24 },
    ]);
    expect(snap.rows[1].channelCheck.conflicts).toEqual([
      { id: 'a', label: '主灯', overlapStart: 20, overlapEnd: 24 },
    ]);
  });

  it('通道检查只作联排提示：带冲突的清单计时与完成行为不变，完成后轨迹仍带检查结论', () => {
    const { clock, engine } = setup();
    engine.load([
      dmx('a', '开场灯', 1, 8),
      dmx('b', '追光', 8, 8), // 与 a 在通道 8 冲突
      { id: 'c', label: '谢幕', durationMs: 3000 },
    ]);
    engine.start();
    clock.jumpTo(4500); // 延迟回调集中处理 a@1000、b@2000
    engine.handleTimer();
    clock.advance(500); // 到 5000，c 按原计划截止时刻到期
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    // 计时语义不受通道检查影响：绝对截止不漂移，照常完成
    expect(snap.status).toBe('completed');
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([1000, 2000, 5000]);
    expect(snap.rows.map((row) => row.actualAtMs)).toEqual([4500, 4500, 5000]);
    expect(snap.finishedAtMs).toBe(5000);
    // 完成轨迹中仍携带通道检查结论
    expect(snap.rows[0].channelCheck.status).toBe('conflict');
    expect(snap.rows[0].channelCheck.conflicts).toEqual([
      { id: 'b', label: '追光', overlapStart: 8, overlapEnd: 8 },
    ]);
    expect(snap.rows[1].channelCheck.status).toBe('conflict');
    expect(snap.rows[2].channelCheck.status).toBe('unassigned');
    expect(snap.channelConflictCount).toBe(2);
  });

  it('旧格式清单（无通道字段）全部标为未配接，演练行为不变', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(100000);
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows.every((row) => row.channelCheck.status === 'unassigned')).toBe(true);
    expect(snap.rows.every((row) => row.channelStart === null && row.channelCount === null)).toBe(
      true,
    );
    expect(snap.channelConflictCount).toBe(0);
  });
});

describe('人工跳过', () => {
  it('中途跳过：记为人工跳过、保留原计划截止与操作时刻，后续沿原绝对时间线推进', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.advance(400);
    // a 尚未到期（截止 1000），跳过后沿原时间线等待 b@3000
    expect(engine.skip()).toBe(2600);

    let snap = engine.getSnapshot();
    expect(snap.status).toBe('running');
    expect(snap.currentIndex).toBe(1);
    expect(snap.rows[0]).toMatchObject({
      kind: 'skipped',
      plannedAtMs: 1000,
      actualAtMs: 400,
      latenessMs: null,
      latenessVerdict: null,
    });
    // 后续项截止时刻不变，总计划不延长
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([1000, 3000, 6000]);

    clock.advance(2600);
    expect(engine.handleTimer()).toBe(3000);
    snap = engine.getSnapshot();
    expect(snap.rows[1]).toMatchObject({ kind: 'settled', plannedAtMs: 3000, actualAtMs: 3000 });
    expect(snap.overLimitCount).toBe(0);
  });

  it('跳过时先结算已到期项：到期边界项记为到期处理，首个未到期项记为人工跳过', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 100 },
      { id: 'b', label: '追光', durationMs: 2000 },
      { id: 'c', label: '谢幕', durationMs: 3000 },
    ]);
    engine.start();
    clock.jumpTo(1300); // a@1000 已到期但回调未投递，b@3000 未到期
    // b 被跳过后沿原绝对时间线等待 c@6000：6000 - 1300 = 4700
    expect(engine.skip()).toBe(4700);

    const snap = engine.getSnapshot();
    // a 按截止边界先结算：保留原截止、按跳过时刻记录真实迟到并照常判定
    expect(snap.rows[0]).toMatchObject({
      kind: 'settled',
      plannedAtMs: 1000,
      actualAtMs: 1300,
      latenessMs: 300,
      latenessVerdict: 'over-limit',
    });
    // b 才是被跳过项：不计算迟到量、不参与超限汇总
    expect(snap.rows[1]).toMatchObject({
      kind: 'skipped',
      plannedAtMs: 3000,
      actualAtMs: 1300,
      latenessMs: null,
      latenessVerdict: null,
    });
    expect(snap.overLimitCount).toBe(1); // 仅 a 超限
    expect(snap.currentIndex).toBe(2);
    expect(snap.rows[2].plannedAtMs).toBe(6000);
  });

  it('截止恰等于跳过时刻的项按到期处理而非跳过', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(1000); // a 恰好在截止时刻
    // a 按到期处理，b 被跳过，随后等待 c@6000：6000 - 1000 = 5000
    expect(engine.skip()).toBe(5000);

    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({ kind: 'settled', plannedAtMs: 1000, actualAtMs: 1000 });
    expect(snap.rows[1]).toMatchObject({ kind: 'skipped', plannedAtMs: 3000, actualAtMs: 1000 });
    expect(snap.currentIndex).toBe(2);
  });

  it('跳过末项直接完成，计划总时长与最终截止不变', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(3000);
    expect(engine.handleTimer()).toBe(3000); // a、b 到期处理
    clock.advance(1500); // 4500，c@6000 未到期
    expect(engine.skip()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows[2]).toMatchObject({
      kind: 'skipped',
      plannedAtMs: 6000,
      actualAtMs: 4500,
      latenessMs: null,
    });
    expect(snap.totalDurationMs).toBe(6000);
    expect(snap.finishedAtMs).toBe(4500);
    expect(snap.overLimitCount).toBe(0);
  });

  it('跳过时全部项均已到期则只结算不跳过，直接完成', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(100000);
    expect(engine.skip()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows.every((row) => row.kind === 'settled')).toBe(true);
    expect(snap.rows.map((row) => row.actualAtMs)).toEqual([100000, 100000, 100000]);
    expect(snap.finishedAtMs).toBe(100000);
  });

  it('跳过项不参与超限汇总，其余项判定照常', () => {
    const { clock, engine } = setup();
    engine.load([
      { id: 'a', label: '开场灯', durationMs: 1000, maxLatenessMs: 500 },
      { id: 'b', label: '追光', durationMs: 2000, maxLatenessMs: 0 },
    ]);
    engine.start();
    clock.advance(200); // a 未到期即跳过：虽有阈值也不判级
    engine.skip();
    clock.jumpTo(3200); // b@3000 到期，回调迟到 200 > 0 => 超限
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.rows[0]).toMatchObject({ kind: 'skipped', latenessVerdict: null });
    expect(snap.rows[1]).toMatchObject({
      kind: 'settled',
      latenessMs: 200,
      latenessVerdict: 'over-limit',
    });
    expect(snap.overLimitCount).toBe(1);
  });

  it('待启动、暂停或完成状态下跳过就地报错且快照不变', () => {
    const { clock, engine } = loaded();
    const before = engine.getSnapshot();
    expect(() => engine.skip()).toThrow('演练尚未启动');
    expect(engine.getSnapshot()).toEqual(before);

    engine.start();
    clock.advance(400);
    engine.pause();
    const pausedSnap = engine.getSnapshot();
    expect(() => engine.skip()).toThrow('暂停状态');
    expect(engine.getSnapshot()).toEqual(pausedSnap);

    engine.resume();
    clock.jumpTo(200000);
    engine.handleTimer();
    expect(engine.getSnapshot().status).toBe('completed');
    const doneSnap = engine.getSnapshot();
    expect(() => engine.skip()).toThrow('已完成');
    expect(engine.getSnapshot()).toEqual(doneSnap);
  });

  it('未导入清单时跳过就地报错', () => {
    const { engine } = setup();
    expect(() => engine.skip()).toThrow('尚未导入提示清单');
    expect(engine.getSnapshot().status).toBe('idle');
  });

  it('未使用跳过的旧清单保持原计时、暂停恢复和完成表现', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.advance(400);
    engine.pause();
    clock.advance(10000);
    expect(engine.resume()).toBe(600);
    clock.jumpTo(200000);
    expect(engine.handleTimer()).toBeNull();

    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows.every((row) => row.kind === 'settled')).toBe(true);
    expect(snap.rows.map((row) => row.plannedAtMs)).toEqual([11000, 13000, 16000]);
    expect(snap.finishedAtMs).toBe(200000);
  });
});

describe('状态不符的重复操作', () => {
  it('各类非法操作均就地报错且不改变状态', () => {
    const { clock, engine } = loaded();

    expect(() => engine.pause()).toThrow('无法暂停');
    expect(() => engine.resume()).toThrow('无法继续');
    expect(engine.getSnapshot().status).toBe('ready');

    engine.start();
    expect(() => engine.start()).toThrow('请勿重复启动');
    expect(() => engine.resume()).toThrow('无法继续');
    expect(() => engine.load(cues)).toThrow('演练进行中');
    expect(engine.getSnapshot().status).toBe('running');

    clock.advance(400);
    engine.pause();
    expect(() => engine.pause()).toThrow('无法暂停');
    expect(() => engine.start()).toThrow('请使用“继续”');
    expect(() => engine.load(cues)).toThrow('演练已暂停');
    expect(engine.getSnapshot().status).toBe('paused');
    expect(engine.getSnapshot().currentRemainingMs).toBe(600);

    engine.resume();
    clock.jumpTo(200000);
    engine.handleTimer();
    expect(engine.getSnapshot().status).toBe('completed');
    expect(() => engine.start()).toThrow('已完成');
    expect(() => engine.pause()).toThrow('无法暂停');
    expect(engine.getSnapshot().status).toBe('completed');
  });

  it('完成后可重新导入并再次演练', () => {
    const { clock, engine } = loaded();
    engine.start();
    clock.jumpTo(200000);
    engine.handleTimer();
    expect(engine.getSnapshot().status).toBe('completed');

    engine.load([{ id: 'x', label: '返场', durationMs: 500 }]);
    expect(engine.getSnapshot().status).toBe('ready');
    expect(engine.start()).toBe(500);
    clock.advance(500);
    expect(engine.handleTimer()).toBeNull();
    const snap = engine.getSnapshot();
    expect(snap.status).toBe('completed');
    expect(snap.rows[0]).toMatchObject({ plannedAtMs: 500, actualAtMs: 500 });
  });
});
