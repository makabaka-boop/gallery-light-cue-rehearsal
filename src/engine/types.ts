export interface CueItem {
  id: string;
  label: string;
  durationMs: number;
  /** 可选的最大可接受迟到毫秒数（0 ～ 600000 的整数）；省略则只记录迟到量，不做准时/超限判定 */
  maxLatenessMs?: number;
  /** 可选的灯具起始通道（1 ～ 512 的整数）；必须与 channelCount 同时出现 */
  channelStart?: number;
  /** 可选的占用通道数（1 ～ 512 的整数，且起始 + 数量 - 1 不得超过 512）；必须与 channelStart 同时出现 */
  channelCount?: number;
  /** 可选的到期预告提前量（0 ～ durationMs 的整数）；省略则不显示预告 */
  warningLeadMs?: number;
}

/** 通道占用检查结论：可用（无重叠）、冲突（与他项通道区间重叠）、未配接（未配置通道的旧项） */
export type ChannelStatus = 'available' | 'conflict' | 'unassigned';

/** 一条通道冲突：对方身份与重叠的闭区间范围 */
export interface ChannelConflict {
  id: string;
  label: string;
  /** 重叠起始通道（闭区间） */
  overlapStart: number;
  /** 重叠结束通道（闭区间） */
  overlapEnd: number;
}

/** 单项提示的通道占用检查结果（只作联排提示，不影响计时语义） */
export interface ChannelCheck {
  status: ChannelStatus;
  /** 冲突对方清单，按清单顺序排列；仅 status 为 conflict 时非空 */
  conflicts: ChannelConflict[];
}

/** 迟到判定：准时（迟到量不超过该项阈值）或超限（超过阈值） */
export type LatenessVerdict = 'on-time' | 'over-limit';

/**
 * 当前提示的预告状态（只在进行中/已暂停且当前项配置了 warningLeadMs 时有值）：
 * waiting（等待预告，尚在预告点之前）或 due-soon（即将到期，已过预告点未到截止）。
 * 未配置 warningLeadMs 的旧项恒为 null。
 */
export type WarningState = 'waiting' | 'due-soon';

/** 轨迹记录类型：到期处理（按截止时刻结算）或人工跳过（技术员主动跳过当前提示） */
export type CueLogKind = 'settled' | 'skipped';

/** 已处理提示的轨迹记录，时刻均为相对演练启动的毫秒偏移 */
export interface CueLogEntry {
  id: string;
  label: string;
  /** 到期处理 / 人工跳过 */
  kind: CueLogKind;
  /** 计划截止时刻（相对启动） */
  plannedAtMs: number;
  /** 实际处理时刻（相对启动）；人工跳过项为点击跳过的操作时刻 */
  actualAtMs: number;
  /** 该项配置的迟到阈值；未配置为 null */
  maxLatenessMs: number | null;
  /** 迟到量 = 实际处理时刻 - 计划截止时刻；人工跳过项不计算迟到量，为 null */
  latenessMs: number | null;
  /** 准时 / 超限；未配置阈值或人工跳过时为 null（不参与超限汇总） */
  latenessVerdict: LatenessVerdict | null;
}

export type EngineStatus = 'idle' | 'ready' | 'running' | 'paused' | 'completed';

export interface CueRow {
  id: string;
  label: string;
  durationMs: number;
  /** 该项配置的迟到阈值；未配置为 null */
  maxLatenessMs: number | null;
  /** 该项配置的起始通道；未配接为 null */
  channelStart: number | null;
  /** 该项配置的占用通道数；未配接为 null */
  channelCount: number | null;
  /** 该项配置的到期预告提前量；未配置为 null */
  warningLeadMs: number | null;
  /** 通道占用检查结果（载入时按闭区间比较得出，演练期间不变） */
  channelCheck: ChannelCheck;
  /** 轨迹类型（到期处理 / 人工跳过）；未处理为 null */
  kind: CueLogKind | null;
  /** 计划截止时刻；未启动或暂停期间待定（null） */
  plannedAtMs: number | null;
  /** 实际处理时刻；未处理为 null */
  actualAtMs: number | null;
  /** 迟到量；未处理或人工跳过为 null */
  latenessMs: number | null;
  /** 准时 / 超限；未处理或未配置阈值为 null */
  latenessVerdict: LatenessVerdict | null;
}

export interface Snapshot {
  status: EngineStatus;
  rows: CueRow[];
  /** 当前应执行项下标（仅进行中/已暂停时有值） */
  currentIndex: number | null;
  /** 当前项剩余毫秒（进行中为实时推算，已暂停为冻结余量） */
  currentRemainingMs: number | null;
  /**
   * 当前项预告状态：等待预告 / 即将到期。
   * 仅进行中或已暂停、且当前项配置了 warningLeadMs 时有值；
   * 旧格式当前项（未配置预告）或无当前项时为 null。
   */
  currentWarning: WarningState | null;
  /** 全部提示的时长合计 */
  totalDurationMs: number;
  /** 最后一项实际处理时刻（仅已完成时有值） */
  finishedAtMs: number | null;
  /** 已处理项中判定为“超限”的数量（未配置阈值的项不计入） */
  overLimitCount: number;
  /** 通道检查判定为“冲突”的项数（未配接的项不计入） */
  channelConflictCount: number;
}
