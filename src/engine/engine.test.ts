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
