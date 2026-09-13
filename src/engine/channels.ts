import type { ChannelCheck, ChannelConflict, CueItem } from './types';

/**
 * 计算整份清单的通道占用检查。
 *
 * 所有已配置通道的提示按闭区间 [channelStart, channelStart + channelCount - 1]
 * 两两比较：区间相交（含端点相接）即为冲突，冲突双方互相列出对方标签与重叠范围；
 * 无任何重叠的已配置项标为“可用”；未配置通道的旧项标为“未配接”，不参与比较。
 *
 * 结果只作联排提示，不影响开始、暂停、恢复、绝对截止、迟到判定与完成条件。
 */
export function computeChannelChecks(items: CueItem[]): ChannelCheck[] {
  const ranges = items.map((item) =>
    item.channelStart !== undefined && item.channelCount !== undefined
      ? { start: item.channelStart, end: item.channelStart + item.channelCount - 1 }
      : null,
  );
  return items.map((_, i) => {
    const range = ranges[i];
    if (range === null) {
      return { status: 'unassigned', conflicts: [] };
    }
    const conflicts: ChannelConflict[] = [];
    for (let j = 0; j < items.length; j++) {
      if (j === i) {
        continue;
      }
      const other = ranges[j];
      if (other === null) {
        continue;
      }
      // 闭区间相交：重叠段为 [max(起点), min(终点)]，起点不大于终点即有重叠
      const overlapStart = Math.max(range.start, other.start);
      const overlapEnd = Math.min(range.end, other.end);
      if (overlapStart <= overlapEnd) {
        conflicts.push({ id: items[j].id, label: items[j].label, overlapStart, overlapEnd });
      }
    }
    return conflicts.length > 0
      ? { status: 'conflict', conflicts }
      : { status: 'available', conflicts: [] };
  });
}
