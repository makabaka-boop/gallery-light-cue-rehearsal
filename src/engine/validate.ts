import type { CueItem } from './types';

export const MIN_DURATION_MS = 100;
export const MAX_DURATION_MS = 600000;
export const MIN_MAX_LATENESS_MS = 0;
export const MAX_MAX_LATENESS_MS = 600000;
export const MIN_CHANNEL = 1;
export const MAX_CHANNEL = 512;

const ALLOWED_KEYS = new Set([
  'id',
  'label',
  'durationMs',
  'maxLatenessMs',
  'channelStart',
  'channelCount',
]);

export class CueSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CueSheetError';
  }
}

/**
 * 以严格 UTF-8 解码清单文件字节。
 * 非法字节序列直接整份拒绝（抛出 CueSheetError），不做 U+FFFD 静默替换；
 * 合法编码的 U+FFFD 字符本身不是解码错误，不受影响、可正常载入。
 */
export function decodeCueSheet(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CueSheetError('文件编码异常：包含无法以 UTF-8 解码的字节，请使用 UTF-8 编码后重新导入');
  }
}

/**
 * 解析并校验 UTF-8 JSON 提示清单。
 * 任一项非法即整份拒绝（抛出 CueSheetError），调用方不得用其结果替换现有数据。
 */
export function parseCueSheet(text: string): CueItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CueSheetError('文件内容不是有效的 JSON');
  }
  if (!Array.isArray(data)) {
    throw new CueSheetError('JSON 顶层必须是数组');
  }
  if (data.length === 0) {
    throw new CueSheetError('提示清单不能为空数组');
  }
  const seenIds = new Set<string>();
  return data.map((raw, index) => validateItem(raw, index, seenIds));
}

function validateItem(raw: unknown, index: number, seenIds: Set<string>): CueItem {
  const where = `第 ${index + 1} 项`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CueSheetError(`${where}必须是对象`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new CueSheetError(
        `${where}包含不允许的字段 "${key}"，仅允许 id、label、durationMs、maxLatenessMs、channelStart、channelCount`,
      );
    }
  }
  const { id, label, durationMs, maxLatenessMs, channelStart, channelCount } = record;

  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new CueSheetError(`${where}的 id 必须是字符串或数字`);
  }
  if (typeof id === 'number' && !Number.isFinite(id)) {
    throw new CueSheetError(`${where}的 id 必须是有限数字`);
  }
  const idText = typeof id === 'string' ? id : String(id);
  if (idText.trim() === '') {
    throw new CueSheetError(`${where}的 id 不能为空`);
  }
  // 唯一性按规范化后的 id 判定：数字 1 与文本 "1" 是同一个 id
  if (seenIds.has(idText)) {
    throw new CueSheetError(`${where}的 id "${idText}" 与前面的项重复`);
  }
  seenIds.add(idText);

  if (typeof label !== 'string' || label.trim() === '') {
    throw new CueSheetError(`${where}的 label 必须是非空字符串`);
  }

  if (typeof durationMs !== 'number' || !Number.isInteger(durationMs)) {
    throw new CueSheetError(`${where}的 durationMs 必须是整数`);
  }
  if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    throw new CueSheetError(
      `${where}的 durationMs 必须在 ${MIN_DURATION_MS} 到 ${MAX_DURATION_MS} 之间`,
    );
  }

  const item: CueItem = { id: idText, label, durationMs };
  // maxLatenessMs 为可选字段：省略时只记录迟到量，不判级；
  // 出现时必须是 0 ～ 600000 的整数，任一非法值整份拒绝（exactOptionalPropertyTypes 下显式赋值）。
  if (maxLatenessMs !== undefined) {
    if (typeof maxLatenessMs !== 'number' || !Number.isInteger(maxLatenessMs)) {
      throw new CueSheetError(`${where}的 maxLatenessMs 必须是整数`);
    }
    if (maxLatenessMs < MIN_MAX_LATENESS_MS || maxLatenessMs > MAX_MAX_LATENESS_MS) {
      throw new CueSheetError(
        `${where}的 maxLatenessMs 必须在 ${MIN_MAX_LATENESS_MS} 到 ${MAX_MAX_LATENESS_MS} 之间`,
      );
    }
    item.maxLatenessMs = maxLatenessMs;
  }

  // channelStart 与 channelCount 为成对的可选字段：只能同时出现或同时省略；
  // 出现时都必须是整数，起始 1 ～ 512、数量 1 ～ 512，且结束通道
  // （起始 + 数量 - 1）不得超过 512。任一条件不符即整份拒绝。
  if (channelStart === undefined && channelCount === undefined) {
    return item;
  }
  if (channelStart === undefined || channelCount === undefined) {
    throw new CueSheetError(`${where}的 channelStart 与 channelCount 必须同时出现`);
  }
  if (typeof channelStart !== 'number' || !Number.isInteger(channelStart)) {
    throw new CueSheetError(`${where}的 channelStart 必须是整数`);
  }
  if (typeof channelCount !== 'number' || !Number.isInteger(channelCount)) {
    throw new CueSheetError(`${where}的 channelCount 必须是整数`);
  }
  if (channelStart < MIN_CHANNEL || channelStart > MAX_CHANNEL) {
    throw new CueSheetError(
      `${where}的 channelStart 必须在 ${MIN_CHANNEL} 到 ${MAX_CHANNEL} 之间`,
    );
  }
  if (channelCount < MIN_CHANNEL || channelCount > MAX_CHANNEL) {
    throw new CueSheetError(
      `${where}的 channelCount 必须在 ${MIN_CHANNEL} 到 ${MAX_CHANNEL} 之间`,
    );
  }
  if (channelStart + channelCount - 1 > MAX_CHANNEL) {
    throw new CueSheetError(
      `${where}的结束通道（channelStart + channelCount - 1 = ${channelStart + channelCount - 1}）不能超过 ${MAX_CHANNEL}`,
    );
  }
  item.channelStart = channelStart;
  item.channelCount = channelCount;

  return item;
}
