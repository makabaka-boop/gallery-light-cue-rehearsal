export interface CueItem {
  id: string;
  label: string;
  durationMs: number;
  /** 可选的最大可接受迟到毫秒数（0 ～ 600000 的整数）；省略则只记录迟到量，不做准时/超限判定 */
  maxLatenessMs?: number;
}

/** 迟到判定：准时（迟到量不超过该项阈值）或超限（超过阈值） */
export type LatenessVerdict = 'on-time' | 'over-limit';

/** 已处理提示的轨迹记录，时刻均为相对演练启动的毫秒偏移 */
export interface CueLogEntry {
  id: string;
  label: string;
  /** 计划截止时刻（相对启动） */
  plannedAtMs: number;
  /** 实际处理时刻（相对启动） */
  actualAtMs: number;
  /** 该项配置的迟到阈值；未配置为 null */
  maxLatenessMs: number | null;
  /** 迟到量 = 实际处理时刻 - 计划截止时刻 */
  latenessMs: number;
  /** 准时 / 超限；未配置阈值时为 null（只记录时间，不判级） */
  latenessVerdict: LatenessVerdict | null;
}

export type EngineStatus = 'idle' | 'ready' | 'running' | 'paused' | 'completed';

export interface CueRow {
  id: string;
  label: string;
  durationMs: number;
  /** 该项配置的迟到阈值；未配置为 null */
  maxLatenessMs: number | null;
  /** 计划截止时刻；未启动或暂停期间待定（null） */
  plannedAtMs: number | null;
  /** 实际处理时刻；未处理为 null */
  actualAtMs: number | null;
  /** 迟到量；未处理为 null */
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
  /** 全部提示的时长合计 */
  totalDurationMs: number;
  /** 最后一项实际处理时刻（仅已完成时有值） */
  finishedAtMs: number | null;
  /** 已处理项中判定为“超限”的数量（未配置阈值的项不计入） */
  overLimitCount: number;
}
