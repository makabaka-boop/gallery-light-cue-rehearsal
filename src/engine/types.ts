export interface CueItem {
  id: string;
  label: string;
  durationMs: number;
}

/** 已处理提示的轨迹记录，时刻均为相对演练启动的毫秒偏移 */
export interface CueLogEntry {
  id: string;
  label: string;
  /** 计划截止时刻（相对启动） */
  plannedAtMs: number;
  /** 实际处理时刻（相对启动） */
  actualAtMs: number;
}

export type EngineStatus = 'idle' | 'ready' | 'running' | 'paused' | 'completed';

export interface CueRow {
  id: string;
  label: string;
  durationMs: number;
  /** 计划截止时刻；未启动或暂停期间待定（null） */
  plannedAtMs: number | null;
  /** 实际处理时刻；未处理为 null */
  actualAtMs: number | null;
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
}
