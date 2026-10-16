// Latency percentiles use the nearest-rank method:
// rank = ceil((percentile / 100) * sampleCount), then pick that 1-based sample.
// Error rate = failedRequests / totalRequests * 100.
// Throughput = totalRequests / (windowMs / 1000).
// A missing sample is null. It is never reported as zero.

const P95_MIN_SAMPLES = 5;
const P99_MIN_SAMPLES = 20;

function round2(value) {
  return Math.round(value * 100) / 100;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index];
}

function summarizeHttp(observations, windowMs) {
  const samples = Array.isArray(observations) ? observations : [];
  const totalRequests = samples.length;
  if (totalRequests === 0 || !(windowMs > 0)) {
    return {
      totalRequests,
      successfulRequests: 0,
      failedRequests: 0,
      statusCodes: {},
      errorRatePercent: null,
      requestsPerSecond: null,
      latencyMs: { average: null, p50: null, p95: null, p99: null },
      sampleCount: totalRequests,
      notes: [
        totalRequests === 0
          ? "No requests were recorded, so rates and latency are unavailable."
          : "The measurement window was empty, so throughput is unavailable.",
      ],
    };
  }

  const statusCodes = {};
  const latencies = [];
  let successfulRequests = 0;
  let failedRequests = 0;

  for (const sample of samples) {
    const code = sample.status == null
      ? (sample.error === "timeout" ? "timeout" : "network")
      : String(sample.status);
    statusCodes[code] = (statusCodes[code] || 0) + 1;
    if (sample.ok) successfulRequests += 1;
    else failedRequests += 1;
    if (typeof sample.latencyMs === "number" && Number.isFinite(sample.latencyMs)) {
      latencies.push(sample.latencyMs);
    }
  }

  latencies.sort((a, b) => a - b);
  const notes = [];
  const p95 = latencies.length >= P95_MIN_SAMPLES ? percentile(latencies, 95) : null;
  const p99 = latencies.length >= P99_MIN_SAMPLES ? percentile(latencies, 99) : null;
  if (p95 == null) notes.push(`p95 needs at least ${P95_MIN_SAMPLES} latency samples.`);
  if (p99 == null) notes.push(`p99 needs at least ${P99_MIN_SAMPLES} latency samples.`);

  const average = latencies.length
    ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
    : null;

  return {
    totalRequests,
    successfulRequests,
    failedRequests,
    statusCodes,
    errorRatePercent: round2((failedRequests / totalRequests) * 100),
    requestsPerSecond: round2(totalRequests / (windowMs / 1000)),
    latencyMs: {
      average: average == null ? null : round2(average),
      p50: latencies.length ? round2(percentile(latencies, 50)) : null,
      p95: p95 == null ? null : round2(p95),
      p99: p99 == null ? null : round2(p99),
    },
    sampleCount: totalRequests,
    notes,
  };
}

module.exports = {
  P95_MIN_SAMPLES,
  P99_MIN_SAMPLES,
  percentile,
  summarizeHttp,
};
