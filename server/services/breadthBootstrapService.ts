interface BreadthSnapshot {
  index: string;
}

interface BreadthBootstrapOptions {
  allIndices: string[];
  delayMs?: number;
  timeoutMs?: number;
  bootstrapDays?: number;
  getLatestBreadthSnapshots: () => Promise<BreadthSnapshot[]>;
  isBreadthMa200Valid: () => Promise<boolean>;
  bootstrapBreadthHistory: (numDays?: number) => Promise<unknown>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface BreadthBootstrapHandle {
  cancel: () => void;
}

export function scheduleBreadthAutoBootstrap(options: BreadthBootstrapOptions): BreadthBootstrapHandle {
  const {
    allIndices,
    delayMs = 15_000,
    timeoutMs = 15 * 60 * 1000,
    bootstrapDays = 300,
    getLatestBreadthSnapshots,
    isBreadthMa200Valid,
    bootstrapBreadthHistory,
    log = (message: string) => console.log(message),
    error = (message: string) => console.error(message),
  } = options;

  const timer = setTimeout(
    () => {
      const timeoutGuard = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Breadth bootstrap timed out after ${Math.round(timeoutMs / 60000)} minutes`)),
          timeoutMs,
        ),
      );

      (async () => {
        try {
          const snapshots = await getLatestBreadthSnapshots();
          const ma200Valid = snapshots.length > 0 ? await isBreadthMa200Valid() : false;
          const indexedSet = new Set(snapshots.map((s) => s.index));
          const missingIndices = allIndices.filter((idx) => !indexedSet.has(idx));
          if (snapshots.length === 0) {
            log('[breadth] No snapshots — auto-bootstrapping 300d in background...');
            await Promise.race([bootstrapBreadthHistory(bootstrapDays), timeoutGuard]);
          } else if (!ma200Valid) {
            log('[breadth] 200d MA zeros detected — re-bootstrapping 300d to fix...');
            await Promise.race([bootstrapBreadthHistory(bootstrapDays), timeoutGuard]);
          } else if (missingIndices.length > 0) {
            log(
              `[breadth] New indices detected (${missingIndices.join(', ')}) — re-bootstrapping 300d to fill gaps...`,
            );
            await Promise.race([bootstrapBreadthHistory(bootstrapDays), timeoutGuard]);
          }
        } catch (err: unknown) {
          error(`[breadth] Auto-bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    Math.max(1, Math.floor(delayMs)),
  );

  if (typeof timer.unref === 'function') timer.unref();

  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}
