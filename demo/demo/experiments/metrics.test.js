const assert = require("node:assert/strict");
const test = require("node:test");
const { percentile, summarizeHttp } = require("./metrics");

test("nearest-rank percentiles and rates use the documented formulas", () => {
  const samples = [10, 20, 30, 40];
  assert.equal(percentile(samples, 50), 20);
  assert.equal(percentile([], 95), null);

  const observations = samples.map((latencyMs, index) => ({
    status: index === 3 ? 500 : 200,
    ok: index !== 3,
    latencyMs,
  }));
  const summary = summarizeHttp(observations, 2000);
  assert.equal(summary.totalRequests, 4);
  assert.equal(summary.failedRequests, 1);
  assert.equal(summary.errorRatePercent, 25);
  assert.equal(summary.requestsPerSecond, 2);
  assert.equal(summary.latencyMs.average, 25);
  assert.equal(summary.latencyMs.p50, 20);
  assert.equal(summary.latencyMs.p95, null);
  assert.equal(summary.latencyMs.p99, null);
  assert.equal(summary.statusCodes["500"], 1);
});

test("empty measurements stay unavailable instead of zero", () => {
  const summary = summarizeHttp([], 1000);
  assert.equal(summary.errorRatePercent, null);
  assert.equal(summary.requestsPerSecond, null);
  assert.equal(summary.latencyMs.average, null);
  assert.equal(summary.notes[0].includes("No requests"), true);
});

test("timeouts stay distinct from network failures and do not satisfy p95", () => {
  const timedOut = summarizeHttp([
    { status: null, ok: false, error: "timeout", latencyMs: 3000 },
  ], 1000);
  assert.equal(timedOut.successfulRequests, 0);
  assert.equal(timedOut.failedRequests, 1);
  assert.equal(timedOut.statusCodes.timeout, 1);
  assert.equal(timedOut.statusCodes.network, undefined);
  assert.equal(timedOut.latencyMs.p95, null);

  const unreachable = summarizeHttp([
    { status: null, ok: false, error: "network", latencyMs: 3000 },
    { status: null, ok: false, error: "network", latencyMs: 3001 },
  ], 1000);
  assert.equal(unreachable.successfulRequests, 0);
  assert.equal(unreachable.statusCodes.network, 2);
  assert.equal(unreachable.latencyMs.p95, null);
  assert.equal(unreachable.errorRatePercent, 100);
});

test("p95 and p99 appear only after enough samples", () => {
  const observations = Array.from({ length: 20 }, (_, index) => ({
    status: 200,
    ok: true,
    latencyMs: (index + 1) * 10,
  }));
  const summary = summarizeHttp(observations, 1000);
  assert.equal(summary.latencyMs.p95, 190);
  assert.equal(summary.latencyMs.p99, 200);
  assert.equal(summary.errorRatePercent, 0);
});
