/**
 * 单调时钟抽象。生产环境使用 performance.now()（单调、不受系统时间回拨影响），
 * 测试中注入手动时钟以精确驱动截止时刻。
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};
