import { useEffect, useRef, useState } from 'react';
import { systemClock } from './engine/clock';
import { RehearsalEngine } from './engine/engine';
import type { EngineStatus, Snapshot } from './engine/types';
import { parseCueSheet } from './engine/validate';

const engine = new RehearsalEngine(systemClock);

const STATUS_TEXT: Record<EngineStatus, string> = {
  idle: '未载入',
  ready: '待启动',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
};

function formatMs(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

function verdictCell(row: {
  maxLatenessMs: number | null;
  actualAtMs: number | null;
  latenessMs: number | null;
  latenessVerdict: 'on-time' | 'over-limit' | null;
}): { text: string; className: string } {
  if (row.actualAtMs === null || row.latenessMs === null) {
    // 尚未处理：未配置阈值的旧格式项始终显示“未设标准”
    return { text: row.maxLatenessMs === null ? '未设标准' : '待判定', className: 'verdict-pending' };
  }
  if (row.latenessVerdict === null) {
    // 已处理但未配置阈值：只记录迟到量，不判级
    return { text: `迟到 ${row.latenessMs} ms（未设标准）`, className: 'verdict-nostandard' };
  }
  if (row.latenessVerdict === 'over-limit') {
    return { text: `迟到 ${row.latenessMs} ms（超限）`, className: 'verdict-over' };
  }
  return { text: `迟到 ${row.latenessMs} ms（准时）`, className: 'verdict-ontime' };
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => engine.getSnapshot());
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const sync = () => setSnapshot(engine.getSnapshot());

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    timerRef.current = window.setTimeout(fireTimer, delayMs);
  };

  /** 定时器到期回调：浏览器可能因标签页降频而延迟投递 */
  const fireTimer = () => {
    timerRef.current = null;
    if (engine.getSnapshot().status !== 'running') {
      return; // 迟到且已失效的回调（如暂停前排队），直接忽略
    }
    try {
      const nextDelay = engine.handleTimer();
      setError(null);
      if (nextDelay !== null) {
        schedule(nextDelay);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    sync();
  };

  /** 执行一次操作：成功则清除错误，失败则就地报错且引擎状态不变 */
  const runSafely = (op: () => void) => {
    try {
      op();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    sync();
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // 允许重复选择同一文件
    if (!file) {
      return;
    }
    const text = await file.text();
    runSafely(() => {
      // 先校验：任一项非法即整份拒绝；再载入：状态不符（如进行中）会抛错。
      // 两步都在产生任何副作用之前失败，当前有效数据与进行中的演练均不受影响。
      const items = parseCueSheet(text);
      engine.load(items);
      clearTimer();
    });
  };

  const handleStart = () => runSafely(() => schedule(engine.start()));
  const handlePause = () =>
    runSafely(() => {
      engine.pause();
      clearTimer();
    });
  const handleResume = () => runSafely(() => schedule(engine.resume()));

  useEffect(() => clearTimer, []);

  const { status, rows } = snapshot;
  const currentRow = snapshot.currentIndex !== null ? rows[snapshot.currentIndex] : null;
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;

  return (
    <main className="app">
      <h1>展厅灯光提示联排演练器</h1>

      <section className="controls" aria-label="操作区">
        <label className="import">
          导入提示清单（UTF-8 JSON）
          <input
            type="file"
            accept="application/json,.json"
            data-testid="file-input"
            onChange={(event) => {
              void handleImport(event);
            }}
          />
        </label>
        <div className="buttons">
          <button type="button" onClick={handleStart}>
            开始
          </button>
          <button type="button" onClick={handlePause}>
            暂停
          </button>
          <button type="button" onClick={handleResume}>
            继续
          </button>
        </div>
      </section>

      <p className={`status status-${status}`} data-testid="status">
        状态：{STATUS_TEXT[status]}
      </p>

      {status === 'running' && currentRow && (
        <p className="current" data-testid="current">
          当前应执行：{currentRow.label}（计划截止 {formatMs(currentRow.plannedAtMs)}）
        </p>
      )}
      {status === 'paused' && currentRow && (
        <p className="current" data-testid="current">
          已暂停于：{currentRow.label}，冻结剩余 {formatMs(snapshot.currentRemainingMs)}
        </p>
      )}
      {status === 'completed' && lastRow && (
        <p className="done" data-testid="done">
          已完成：计划总时长 {snapshot.totalDurationMs} ms；最后一项计划截止{' '}
          {formatMs(lastRow.plannedAtMs)}，实际处理 {formatMs(snapshot.finishedAtMs)}
          （均相对启动时刻）
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {rows.length > 0 && (
        <p className="summary" data-testid="lateness-summary">
          迟到判定汇总：超限 {snapshot.overLimitCount} 项
        </p>
      )}

      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">ID</th>
              <th scope="col">提示</th>
              <th scope="col">时长</th>
              <th scope="col">迟到上限</th>
              <th scope="col">计划截止</th>
              <th scope="col">实际处理</th>
              <th scope="col">迟到判定</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const verdict = verdictCell(row);
              return (
                <tr key={row.id} data-testid={`cue-row-${row.id}`}>
                  <td>{i + 1}</td>
                  <td>{row.id}</td>
                  <td>{row.label}</td>
                  <td>{row.durationMs} ms</td>
                  <td data-testid={`threshold-${row.id}`}>
                    {row.maxLatenessMs === null ? '未设标准' : `${row.maxLatenessMs} ms`}
                  </td>
                  <td data-testid={`planned-${row.id}`}>{formatMs(row.plannedAtMs)}</td>
                  <td data-testid={`actual-${row.id}`}>{formatMs(row.actualAtMs)}</td>
                  <td
                    className={verdict.className}
                    data-testid={`verdict-${row.id}`}
                    data-verdict={row.latenessVerdict ?? 'none'}
                  >
                    {verdict.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
