/** Start application-owned jobs and expose a drainable, idempotent stop function. */
export function startBackgroundJobs({
  config,
  queries,
  api,
  logger = console,
  timers = globalThis,
}) {
  let stopped = false;
  const running = new Set();
  const handles = [];

  const schedule = (label, task, interval, runImmediately = false) => {
    let active = false;
    const run = () => {
      if (stopped || active) return;
      active = true;
      const pending = Promise.resolve()
        .then(task)
        .catch((error) => logger.error(`${label} failed:`, error.message))
        .finally(() => {
          active = false;
          running.delete(pending);
        });
      running.add(pending);
    };
    const handle = timers.setInterval(run, interval);
    handle.unref?.();
    handles.push(handle);
    if (runImmediately) run();
  };

  schedule(
    'Retention cleanup',
    () => queries.applyRetentionPolicies(config.runtime.retention),
    24 * 60 * 60 * 1000,
  );
  schedule('Ticket recovery', () => api.ticketSales.recover(), 60 * 1000, true);

  let stopping;
  return () => {
    if (!stopping) {
      stopped = true;
      handles.forEach((handle) => timers.clearInterval(handle));
      stopping = Promise.allSettled([...running]).then(() => undefined);
    }
    return stopping;
  };
}
