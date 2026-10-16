import assert from "node:assert/strict";
import test from "node:test";
import type { ExperimentRecord } from "../src/lib/api";
import {
  dashboardMode,
  formatMetric,
  phaseSnapshots,
  timelineEvents,
} from "../src/lib/experimentDashboard";

function record(patch: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    id: "exp-1",
    name: "cpu",
    status: "PASSED",
    verdict: "PASSED",
    targetService: "mmcpu-check",
    faultType: "cpu",
    mode: "measured",
    error: null,
    cleanupStatus: "restored",
    createdAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T00:00:08.000Z",
    evidence: {
      mode: "measured",
      provenance: "observed",
      cleanup: { status: "restored", detail: "docker inspect showed CPU quota -1 after restore." },
      phases: {
        baseline: {
          startedAt: "2026-10-14T00:00:00.000Z",
          metrics: {
            totalRequests: 10,
            successfulRequests: 10,
            failedRequests: 0,
            errorRatePercent: 0,
            requestsPerSecond: 5,
            latencyMs: { average: 8, p50: 4, p95: 20, p99: null },
          },
          cpuPercent: 100,
        },
        fault: {
          metrics: {
            totalRequests: 10,
            successfulRequests: 10,
            failedRequests: 0,
            errorRatePercent: 0,
            requestsPerSecond: 5,
            latencyMs: { average: 12, p50: 7, p95: null, p99: null },
          },
          cpuPercent: null,
          execution: { verified: true, detail: "docker inspect showed the CPU quota was 5000 after the update." },
        },
      },
      assertions: [{ id: "fault_verified", name: "CPU quota throttling was verified by inspect", result: "PASSED", expected: "verified", observed: "cpu quota 5000", detail: "ok" }],
    },
    ...patch,
  };
}

test("dashboard states distinguish empty, running, and finished experiments", () => {
  assert.equal(dashboardMode(null, true, false), "loading");
  assert.equal(dashboardMode(null, false, false), "empty");
  assert.equal(dashboardMode(null, false, true), "running");
  assert.equal(dashboardMode(record({ status: "RUNNING", verdict: null }), false, false), "running");
  assert.equal(dashboardMode(record({ status: "ERROR", verdict: "ERROR", error: "Real chaos is disabled." }), false, false), "error");
  assert.equal(dashboardMode(record(), false, false), "completed");
});

test("missing metrics stay unavailable and cleanup is an event", () => {
  assert.equal(formatMetric(null), "unavailable");
  assert.equal(formatMetric(undefined), "unavailable");
  assert.equal(formatMetric(0), "0");
  const rows = phaseSnapshots(record());
  assert.equal(rows[1].p95, null);
  assert.equal(rows[1].cpu, null);
  assert.equal(rows[1].cpuKnown, true);
  assert.equal(rows[1].ran, true);
  assert.equal(rows[2].ran, false);
  assert.equal(rows[2].requests, null);
  assert.equal(formatMetric(rows[1].p95), "unavailable");
  const events = timelineEvents(record());
  assert.equal(events.some((event) => event.label === "Cleanup" && event.detail.includes("restored")), true);
  assert.equal(events.some((event) => event.detail.includes("CPU quota throttling")), true);
  assert.equal(JSON.stringify(rows).includes("\"p95\":0"), false);
});
