const { setGlobalDispatcher, Agent } = require("undici");

async function runWithAbortAndTimeout(task, options = {}) {
  const label = String(options.label || 'Task').trim() || 'Task';
  const parentSignal = options.signal || null;
  const timeoutMs = Math.max(0, Math.floor(Number(options.timeoutMs) || 0));
  if (timeoutMs <= 0) {
    return task(parentSignal);
  }
  if (parentSignal && parentSignal.aborted) {
    throw new Error(`${label} aborted`);
  }

  const controller = new AbortController();
  // Simplified link logic for repro
  if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener('abort', () => controller.abort());
  }

  let timeoutTimer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      console.log('Timeout fired!');
      try {
        controller.abort();
      } catch {
        // Ignore duplicate abort calls.
      }
      reject(new Error(`Task timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    });

  try {
    return await Promise.race([
      task(controller.signal),
      timeoutPromise
    ]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

async function hangForever(signal) {
    console.log('Worker started. Ignoring signal...');
    return new Promise(() => {}); // Never resolves
}

const timeoutMs = 2000;
console.log(`Starting hung task with ${timeoutMs}ms timeout...`);
runWithAbortAndTimeout(hangForever, { timeoutMs, label: 'HungTask' })
    .then(() => console.log('Task finished (unexpected)'))
    .catch(err => console.error('Task failed:', err.message));

console.log('Waiting for timeout...');
