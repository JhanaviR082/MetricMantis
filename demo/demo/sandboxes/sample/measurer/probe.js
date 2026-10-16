// Fixed probe for the approved sandbox network.
// The service name selects a built-in endpoint. Callers cannot pass a URL or a shell command.

const ENDPOINTS = {
  "web-app": "http://web-app/health",
  api: "http://api:8080/health",
};

const MAX_OBSERVATIONS = 200;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function runProbe({
  service,
  durationMs,
  ratePerSecond,
  concurrency,
  timeoutMs,
  fetchImpl = global.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  signal,
}) {
  const url = ENDPOINTS[service];
  if (!url) {
    return { error: "This sandbox service has no approved HTTP health endpoint.", observations: [], measurementErrors: [] };
  }

  // The first request from a new probe process can take longer than the timed window
  // because it opens a new connection. It is not a sample and does not start the window clock.
  if (!signal?.aborted) {
    const warmupController = new AbortController();
    const warmupTimer = setTimeout(() => warmupController.abort(), timeoutMs);
    try {
      await fetchImpl(url, { signal: warmupController.signal, redirect: "manual" });
    } catch {
      // A failed warmup is not recorded as a sample. The timed window still runs.
    } finally {
      clearTimeout(warmupTimer);
    }
  }
  if (signal?.aborted) {
    return {
      error: "Cancelled.",
      observations: [],
      measurementErrors: [],
      windowMs: 0,
      warmupExcluded: 1,
      aborted: true,
    };
  }

  const started = now();
  const deadline = started + durationMs;
  const intervalMs = Math.max(1, Math.round(1000 / ratePerSecond));
  const observations = [];
  const measurementErrors = [];
  const jobs = new Set();
  const controllers = new Set();
  let active = 0;
  let stop = Boolean(signal?.aborted);
  const onAbort = () => {
    stop = true;
    for (const controller of controllers) controller.abort();
  };
  signal?.addEventListener("abort", onAbort);

  async function issue() {
    if (stop || observations.length >= MAX_OBSERVATIONS) return;
    active += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const sentAt = now();
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
      if (signal?.aborted) return;
      const redirected = response.status >= 300 && response.status < 400;
      observations.push({
        at: new Date(sentAt).toISOString(),
        status: response.status,
        latencyMs: Math.max(0, now() - sentAt),
        ok: !redirected && response.status >= 200 && response.status < 400,
        error: redirected ? "redirect" : undefined,
      });
    } catch (error) {
      if (signal?.aborted) return;
      const aborted = error?.name === "AbortError";
      observations.push({
        at: new Date(sentAt).toISOString(),
        status: null,
        latencyMs: Math.max(0, now() - sentAt),
        ok: false,
        error: aborted ? "timeout" : "network",
      });
      if (!aborted) measurementErrors.push("A probe failed before an HTTP status was received.");
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      active -= 1;
    }
  }

  while (!stop && now() < deadline && observations.length < MAX_OBSERVATIONS) {
    if (active < concurrency) {
      const task = issue();
      jobs.add(task);
      task.finally(() => jobs.delete(task));
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  await Promise.all([...jobs]);
  signal?.removeEventListener("abort", onAbort);
  return {
    service,
    url,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    windowMs: Math.max(0, now() - started),
    observations,
    measurementErrors: measurementErrors.slice(0, 5),
    warmupExcluded: 1,
  };
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const result = await runProbe({
    service: process.env.MM_SERVICE,
    durationMs: clampInt(process.env.MM_DURATION_MS, 200, 15000, 2000),
    ratePerSecond: clampInt(process.env.MM_RATE, 1, 20, 5),
    concurrency: clampInt(process.env.MM_CONCURRENCY, 1, 4, 1),
    timeoutMs: clampInt(process.env.MM_TIMEOUT_MS, 200, 5000, 1000),
    signal: controller.signal,
  });
  process.stdout.write(`MM_RESULT ${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`MM_RESULT ${JSON.stringify({
      error: "The sandbox probe stopped.",
      observations: [],
      measurementErrors: [String(error?.message || "probe failed").slice(0, 180)],
    })}\n`);
    process.exit(1);
  });
}

module.exports = { ENDPOINTS, runProbe };
