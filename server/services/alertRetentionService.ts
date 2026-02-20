interface AlertRetentionQueryPool {
  query: (sql: string, values?: unknown[]) => Promise<{ rowCount?: number | null }>;
}

interface AlertRetentionSchedulerOptions {
  pool: AlertRetentionQueryPool;
  retentionDays: number;
  checkIntervalMs: number;
  initialDelayMs?: number;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface AlertRetentionSchedulerHandle {
  stop: () => void;
  pruneNow: () => Promise<void>;
}

export function startAlertRetentionScheduler(options: AlertRetentionSchedulerOptions): AlertRetentionSchedulerHandle {
  const {
    pool,
    retentionDays,
    checkIntervalMs,
    initialDelayMs = 60_000,
    log = (message: string) => console.log(message),
    error = (message: string) => console.error(message),
  } = options;

  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const pruneNow = async () => {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - Math.max(1, Math.floor(retentionDays)));
      const result = await pool.query('DELETE FROM alerts WHERE timestamp < $1', [cutoffDate]);
      if (result.rowCount && result.rowCount > 0) {
        log(`Pruned ${result.rowCount} old alerts created before ${cutoffDate.toISOString()}`);
      }
    } catch (err: unknown) {
      error(`Failed to prune old alerts: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  initialTimer = setTimeout(
    () => {
      pruneNow().catch(() => {
        // pruneNow handles logging.
      });
    },
    Math.max(1, Math.floor(initialDelayMs)),
  );

  intervalTimer = setInterval(
    () => {
      pruneNow().catch(() => {
        // pruneNow handles logging.
      });
    },
    Math.max(1, Math.floor(checkIntervalMs)),
  );

  if (typeof initialTimer.unref === 'function') initialTimer.unref();
  if (typeof intervalTimer.unref === 'function') intervalTimer.unref();

  const stop = () => {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  };

  return { stop, pruneNow };
}
