import type { Clock } from './clock';
import { computeChannelChecks } from './channels';
import type {
  ChannelCheck,
  CueItem,
  CueLogEntry,
  CueRow,
  EngineStatus,
  LatenessVerdict,
  Snapshot,
} from './types';

export class RehearsalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RehearsalError';
  }
}

/**
 * 演练计时引擎。
 *
 * 计时语义：
 * - 所有截止时刻都由单调时钟的绝对时刻计算（启动时刻 + 时长累加），
 *   不靠递减 tick 累计，因此回调迟到不会让后续截止时刻漂移。
 * - 暂停先按各自截止时刻结算所有已到期项（保留原截止、记录真实迟到），
 *   再冻结第一个尚未到期项的剩余毫秒数；恢复时以该余量建立新的绝对截止时刻。
 * - 定时回调若因标签页降频而延迟并跨过多项，handleTimer 会按各自截止时刻
 *   依次记入轨迹，并把“当前应执行项”直接推进到第一个尚未到期的项。
 * - 一切状态不符的操作就地抛错（RehearsalError），且不改变任何状态。
 */
export class RehearsalEngine {
  private readonly clock: Clock;
  private status: EngineStatus = 'idle';
  private items: CueItem[] = [];
  private index = 0;
  private startedAtMs = 0;
  /** 当前项的绝对截止时刻（时钟毫秒） */
  private deadlineMs = 0;
  /** 暂停时冻结的当前项剩余毫秒 */
  private remainingMs = 0;
  private log: CueLogEntry[] = [];
  /** 载入时按闭区间比较得出的通道占用检查（只作联排提示，不参与计时） */
  private channelChecks: ChannelCheck[] = [];

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** 载入清单。进行中/已暂停时拒绝；载入成功后进入待启动状态。 */
  load(items: CueItem[]): void {
    if (this.status === 'running') {
      throw new RehearsalError('演练进行中，无法导入新的提示清单');
    }
    if (this.status === 'paused') {
      throw new RehearsalError('演练已暂停，无法导入新的提示清单');
    }
    if (items.length === 0) {
      throw new RehearsalError('提示清单不能为空');
    }
    this.items = items.map((item) => ({ ...item }));
    this.index = 0;
    this.log = [];
    this.remainingMs = 0;
    this.channelChecks = computeChannelChecks(this.items);
    this.status = 'ready';
  }

  /** 启动演练，返回距首个截止时刻的毫秒数。 */
  start(): number {
    if (this.status === 'idle') {
      throw new RehearsalError('尚未导入提示清单，无法启动演练');
    }
    if (this.status === 'running') {
      throw new RehearsalError('演练已在进行中，请勿重复启动');
    }
    if (this.status === 'paused') {
      throw new RehearsalError('演练处于暂停状态，请使用“继续”');
    }
    if (this.status === 'completed') {
      throw new RehearsalError('演练已完成，如需再次演练请重新导入清单');
    }
    this.status = 'running';
    this.index = 0;
    this.log = [];
    this.startedAtMs = this.clock.now();
    this.deadlineMs = this.startedAtMs + this.items[0].durationMs;
    return this.items[0].durationMs;
  }

  /**
   * 暂停：先结算所有已到期但尚未收到回调的项（保留各自原截止时刻，
   * 以暂停时刻为实际处理时刻记录真实迟到），再冻结第一个尚未到期项的
   * 剩余毫秒数；若结算后全部到期则直接进入完成状态。
   */
  pause(): void {
    if (this.status !== 'running') {
      throw new RehearsalError('当前不在进行中，无法暂停');
    }
    const now = this.clock.now();
    this.settleOverdue(now);
    if (this.index >= this.items.length) {
      this.status = 'completed';
      return;
    }
    // 结算后当前项截止时刻必在未来，余量恒为正
    this.remainingMs = this.deadlineMs - now;
    this.status = 'paused';
  }

  /** 恢复：以冻结的余量建立新的绝对截止时刻，返回距截止的毫秒数。 */
  resume(): number {
    if (this.status !== 'paused') {
      throw new RehearsalError('当前未处于暂停状态，无法继续');
    }
    this.deadlineMs = this.clock.now() + this.remainingMs;
    this.status = 'running';
    return this.remainingMs;
  }

  /**
   * 定时回调。回调可能因标签页降频而迟到并跨过多项：
   * 逐项按各自截止时刻记入轨迹（实际处理时刻均为当前时刻），
   * 然后把当前项推进到第一个尚未到期的项，返回其剩余毫秒；
   * 全部到期则进入完成状态并返回 null。
   */
  handleTimer(): number | null {
    if (this.status !== 'running') {
      throw new RehearsalError('定时回调到达时演练不在进行中');
    }
    const now = this.clock.now();
    this.settleOverdue(now);
    if (this.index >= this.items.length) {
      this.status = 'completed';
      return null;
    }
    return this.deadlineMs - now;
  }

  /**
   * 把截止时刻不晚于 now 的项依次记入轨迹（实际处理时刻均为 now，
   * 计划截止时刻保持各自原值），并把当前项推进到第一个尚未到期的项。
   */
  private settleOverdue(now: number): void {
    while (this.index < this.items.length && this.deadlineMs <= now) {
      const item = this.items[this.index];
      const plannedAtMs = this.deadlineMs - this.startedAtMs;
      const actualAtMs = now - this.startedAtMs;
      // 迟到量 = 实际处理时刻 - 计划截止时刻；按各项自己的阈值独立判定，
      // 一次延迟跨过多项时，每项的准时/超限结论互不影响。
      const latenessMs = actualAtMs - plannedAtMs;
      const threshold = item.maxLatenessMs ?? null;
      let latenessVerdict: LatenessVerdict | null = null;
      if (threshold !== null) {
        latenessVerdict = latenessMs <= threshold ? 'on-time' : 'over-limit';
      }
      this.log.push({
        id: item.id,
        label: item.label,
        plannedAtMs,
        actualAtMs,
        maxLatenessMs: threshold,
        latenessMs,
        latenessVerdict,
      });
      this.index += 1;
      if (this.index < this.items.length) {
        this.deadlineMs += this.items[this.index].durationMs;
      }
    }
  }

  getSnapshot(): Snapshot {
    const now = this.clock.now();
    const rows: CueRow[] = [];
    // 进行中时，未处理项的计划截止时刻从当前截止时刻向后累加
    // （第 i 项截止 = 第 i-1 项截止 + 第 i 项时长）；暂停期间截止时刻尚未重建，计划显示为待定。
    let pendingOffsetMs = this.deadlineMs - this.startedAtMs;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const maxLatenessMs = item.maxLatenessMs ?? null;
      let plannedAtMs: number | null = null;
      let actualAtMs: number | null = null;
      let latenessMs: number | null = null;
      let latenessVerdict: LatenessVerdict | null = null;
      if (i < this.index) {
        const entry = this.log[i];
        plannedAtMs = entry.plannedAtMs;
        actualAtMs = entry.actualAtMs;
        latenessMs = entry.latenessMs;
        latenessVerdict = entry.latenessVerdict;
      } else if (this.status === 'running') {
        if (i > this.index) {
          pendingOffsetMs += item.durationMs;
        }
        plannedAtMs = pendingOffsetMs;
      }
      rows.push({
        id: item.id,
        label: item.label,
        durationMs: item.durationMs,
        maxLatenessMs,
        channelStart: item.channelStart ?? null,
        channelCount: item.channelCount ?? null,
        channelCheck: this.channelChecks[i],
        plannedAtMs,
        actualAtMs,
        latenessMs,
        latenessVerdict,
      });
    }
    const isActive = this.status === 'running' || this.status === 'paused';
    return {
      status: this.status,
      rows,
      currentIndex: isActive ? this.index : null,
      currentRemainingMs:
        this.status === 'running'
          ? Math.max(0, this.deadlineMs - now)
          : this.status === 'paused'
            ? this.remainingMs
            : null,
      totalDurationMs: this.items.reduce((sum, item) => sum + item.durationMs, 0),
      finishedAtMs:
        this.status === 'completed' && this.log.length > 0
          ? this.log[this.log.length - 1].actualAtMs
          : null,
      overLimitCount: this.log.reduce(
        (count, entry) => count + (entry.latenessVerdict === 'over-limit' ? 1 : 0),
        0,
      ),
      channelConflictCount: this.channelChecks.reduce(
        (count, check) => count + (check.status === 'conflict' ? 1 : 0),
        0,
      ),
    };
  }
}
