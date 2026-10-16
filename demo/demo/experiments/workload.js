// Bounded HTTP probe. Concurrency, rate, duration, and per-request timeout are capped
// by the caller. Cancellation stops new requests and aborts the one in flight.

const MAX_OBSERVATIONS = 200;

async function runWorkload({
  url,
  durationMs,
  ratePerSecond,
  concurrency,
  timeoutMs,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  signal,
}) {
  const started = now();
  const deadline = started + durationMs;
  const intervalMs = Math.max(1, Math.round(1000 / ratePerSecond));
  const observations = [];
  const measurementErrors = [];
  const pending = new Set();

  async function issue() {
    if (signal?.aborted || observations.length >= MAX_OBSERVATIONS) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
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
      if (!aborted) {
        measurementErrors.push("A probe failed before an HTTP status was received.");
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  while (now() < deadline) {
    if (signal?.aborted) break;
    if (pending.size < concurrency && observations.length < MAX_OBSERVATIONS) {
      const task = issue().finally(() => pending.delete(task));
      pending.add(task);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  await Promise.all([...pending]);
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    windowMs: Math.max(0, now() - started),
    observations,
    measurementErrors: measurementErrors.slice(0, 5),
  };
}

module.exports = { runWorkload, MAX_OBSERVATIONS };
