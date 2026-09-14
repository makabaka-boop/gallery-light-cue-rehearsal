import type { Clock } from './clock';
import { computeChannelChecks } from './channels';
import type {
  ChannelCheck,
  CueItem,
  CueLogEntry,
  CueLogKind,
  CueRow,
  EngineStatus,
  LatenessVerdict,
  Snapshot,
  WarningState,
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
 * - 到期预告：配置了 warningLeadMs 的当前项在「计划截止 − 预告时长」处被标为
 *   “即将到期”，此前标为“等待预告”；预告点与截止点都是绝对时刻，延迟回调
 *   跨过预告点或截止点时只按当前绝对时刻推进状态，不改写任何后续截止时刻。
 *   暂停冻结预告进度，恢复后以冻结余量重建预告边界；未配置该项的旧清单无预告。
 * - 人工跳过先按当前单调时刻结算所有已到期项（记为“到期处理”），再把首个
 *   尚未到期项记为“人工跳过”，随后沿原绝对时间线等待下一项：不重排清单、
 *   不延长总计划；跳过项保留原计划截止与操作时刻，但不计算迟到量、不参与超限汇总。
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

  /**
   * 启动演练，返回距首个定时事件的毫秒数：首项配置了 warningLeadMs 时为
   * 距预告点的时长，否则为距首项截止的时长。
   */
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
    return this.delayUntilNextEvent(this.startedAtMs);
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

  /**
   * 恢复：以冻结的余量建立新的绝对截止时刻，预告点随之按同一边界重建。
   * 返回距下一个事件（预告点或截止点，取较早者）的毫秒数。
   */
  resume(): number {
    if (this.status !== 'paused') {
      throw new RehearsalError('当前未处于暂停状态，无法继续');
    }
    const now = this.clock.now();
    this.deadlineMs = now + this.remainingMs;
    this.status = 'running';
    return this.delayUntilNextEvent(now);
  }

  /**
   * 定时回调。回调可能因标签页降频而迟到并跨过多项：
   * 逐项按各自截止时刻记入轨迹（实际处理时刻均为当前时刻），
   * 然后把当前项推进到第一个尚未到期的项，返回距其下一个定时事件
   * （等待预告时为预告点，否则为截止点）的毫秒数；全部到期则完成并返回 null。
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
    return this.delayUntilNextEvent(now);
  }

  /**
   * 人工跳过当前提示。先按当前单调时刻结算所有已到期但尚未收到回调的项
   * （与定时回调相同的“到期处理”），再把首个尚未到期项记为“人工跳过”：
   * 保留原计划截止与操作时刻，但不计算迟到量、不参与超限汇总。
   * 随后沿原绝对时间线等待下一项（不重排清单、不延长总计划），
   * 返回距下一项定时事件（其预告点或截止点）的毫秒数；
   * 跳过的是末项（或结算后全部到期）则完成并返回 null。
   */
  skip(): number | null {
    if (this.status === 'idle') {
      throw new RehearsalError('尚未导入提示清单，无法跳过当前提示');
    }
    if (this.status === 'ready') {
      throw new RehearsalError('演练尚未启动，无法跳过当前提示');
    }
    if (this.status === 'paused') {
      throw new RehearsalError('演练处于暂停状态，无法跳过当前提示');
    }
    if (this.status === 'completed') {
      throw new RehearsalError('演练已完成，无法跳过当前提示');
    }
    const now = this.clock.now();
    this.settleOverdue(now);
    if (this.index >= this.items.length) {
      this.status = 'completed';
      return null;
    }
    const item = this.items[this.index];
    this.log.push({
      id: item.id,
      label: item.label,
      kind: 'skipped',
      plannedAtMs: this.deadlineMs - this.startedAtMs,
      actualAtMs: now - this.startedAtMs,
      maxLatenessMs: item.maxLatenessMs ?? null,
      latenessMs: null,
      latenessVerdict: null,
    });
    this.index += 1;
    if (this.index >= this.items.length) {
      this.status = 'completed';
      return null;
    }
    this.deadlineMs += this.items[this.index].durationMs;
    return this.delayUntilNextEvent(now);
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
        kind: 'settled',
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

  /**
   * 距当前项下一个定时事件的毫秒数，用于安排 setTimeout：
   * - 尚在预告点之前（等待预告）：下一个事件是预告点 = 截止点 − warningLeadMs；
   * - 已到/越过预告点（即将到期）：下一个事件就是截止点。
   * 未配置 warningLeadMs 的旧项只有截止点。预告点只作状态标记，回调在预告点
   * 被延迟跨过（now 已越过预告点）时不再补发预告事件，直接等到截止点；
   * 任何情况下后续截止时刻都不被改写。
   */
  private delayUntilNextEvent(now: number): number {
    const lead = this.items[this.index]?.warningLeadMs;
    if (lead === undefined) {
      return Math.max(0, this.deadlineMs - now);
    }
    const remaining = this.deadlineMs - now;
    // 余量已不大于预告提前量：预告点已到或被延迟回调跨过，等待截止点
    return remaining <= lead ? Math.max(0, remaining) : remaining - lead;
  }

  /**
   * 当前项的预告状态：配置了 warningLeadMs 时，余量不大于预告提前量即为
   * “即将到期”（已到预告点），否则为“等待预告”；未配置则为 null。
   * 暂停时以冻结余量判定（预告进度一并冻结）；进行中若截止点已过但结算回调
   * 尚未到达，则不展示预告——“即将到期”只在 [预告点, 截止点) 区间成立。
   */
  private warningForCurrent(now: number, remainingMs: number): WarningState | null {
    const lead = this.items[this.index]?.warningLeadMs;
    if (lead === undefined) {
      return null;
    }
    if (this.status === 'running' && this.deadlineMs - now <= 0) {
      return null;
    }
    return remainingMs <= lead ? 'due-soon' : 'waiting';
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
      let kind: CueLogKind | null = null;
      let plannedAtMs: number | null = null;
      let actualAtMs: number | null = null;
      let latenessMs: number | null = null;
      let latenessVerdict: LatenessVerdict | null = null;
      if (i < this.index) {
        const entry = this.log[i];
        kind = entry.kind;
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
        warningLeadMs: item.warningLeadMs ?? null,
        channelCheck: this.channelChecks[i],
        kind,
        plannedAtMs,
        actualAtMs,
        latenessMs,
        latenessVerdict,
      });
    }
    const isActive = this.status === 'running' || this.status === 'paused';
    const currentRemainingMs =
      this.status === 'running'
        ? Math.max(0, this.deadlineMs - now)
        : this.status === 'paused'
          ? this.remainingMs
          : null;
    const currentWarning =
      isActive && this.index < this.items.length && currentRemainingMs !== null
        ? this.warningForCurrent(now, currentRemainingMs)
        : null;
    return {
      status: this.status,
      rows,
      currentIndex: isActive ? this.index : null,
      currentRemainingMs,
      currentWarning,
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
