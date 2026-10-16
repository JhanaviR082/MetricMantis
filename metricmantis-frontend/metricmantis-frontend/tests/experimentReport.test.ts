import assert from "node:assert/strict";
import test from "node:test";
import { buildMeasuredSection } from "../src/lib/experimentReport";
import type { ExperimentRecord } from "../src/lib/api";

const experiment = {
  id: "exp-1",
  name: "measure",
  status: "PASSED",
  verdict: "PASSED",
  targetService: "api",
  faultType: "measure",
  mode: "measured",
  error: null,
  cleanupStatus: "not_required",
  createdAt: "2026-10-14T00:00:00.000Z",
  finishedAt: "2026-10-14T00:00:01.000Z",
  evidence: {
    mode: "measured",
    provenance: "observed",
    hypothesis: "Health stays available.",
    observedImpact: "Baseline error rate was 0%.",
    declaredDependents: ["web-app"],
    phases: {
      baseline: {
        metrics: {
          totalRequests: 8,
          successfulRequests: 8,
          failedRequests: 0,
          errorRatePercent: 0,
          requestsPerSecond: 4,
          latencyMs: { average: 12, p50: 10, p95: 20, p99: null },
        },
      },
    },
    assertions: [{ id: "error_rate", name: "Baseline error rate", result: "PASSED", expected: "<= 5", observed: 0, detail: "ok" }],
    limitations: [],
    cleanup: { status: "not_required", detail: "No container change." },
  },
} as ExperimentRecord;

test("measured report section keeps observed numbers and does not invent p99", () => {
  const section = buildMeasuredSection(experiment);
  assert.equal(section?.title, "Measured Experiment");
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("Experiment exp-1")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("error rate 0%")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("p99 n/a")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("PASSED")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("not observed")), true);
});

test("cpu comparison keeps unavailable samples out of the report and PDF", async () => {
  const section = buildMeasuredSection({
    ...experiment,
    id: "cpu-1",
    faultType: "cpu",
    evidence: {
      ...experiment.evidence!,
      observedImpact: "Baseline: 10 requests, probe completion 5 req/s, error 0%, p50 10 ms, p95 20 ms, CPU 80%. CPU-limited: 10 requests, probe completion 2 req/s, error 0%, p50 40 ms, p95 90 ms, CPU 5%. Recovery: 10 requests, probe completion 4 req/s, error 0%, p50 12 ms, p95 25 ms, CPU unavailable. Verified CPU throttling is the docker inspect quota result, separate from latency. CPU percentage: one sample per phase. A single docker stats sample is not a significance test and is not a pass. p95 latency: one window is not a consistent latency effect. Probe completion req/s follows the configured send rate. It is not service capacity.",
      cpuComparison: {
        summary: "Baseline: 10 requests, probe completion 5 req/s, error 0%, p50 10 ms, p95 20 ms, CPU 80%. CPU-limited: 10 requests, probe completion 2 req/s, error 0%, p50 40 ms, p95 90 ms, CPU 5%. Recovery: 10 requests, probe completion 4 req/s, error 0%, p50 12 ms, p95 25 ms, CPU unavailable. Verified CPU throttling is the docker inspect quota result, separate from latency. CPU percentage: one sample per phase. A single docker stats sample is not a significance test and is not a pass. p95 latency: one window is not a consistent latency effect. Probe completion req/s follows the configured send rate. It is not service capacity.",
      },
      limitations: [
        "A pass means the CPU quota was verified by inspect, the workload was observed, cleanup restored the quota, and the recovery error rate stayed within its threshold. It does not treat one CPU sample or one p95 window as a confirmed effect.",
        "Probe req/s is the rate of completed probes at the configured send rate. It is not a measurement of service capacity.",
      ],
      assertions: [
        { id: "fault_verified", name: "CPU quota throttling was verified by inspect", result: "PASSED", expected: "verified", observed: "cpu quota 5000", detail: "docker inspect showed the CPU quota was 5000 after the update." },
      ],
      phases: {
        baseline: {
          cpuPercent: 80,
          metrics: experiment.evidence!.phases!.baseline!.metrics,
        },
        fault: {
          cpuPercent: null,
          metrics: {
            totalRequests: 8,
            successfulRequests: 8,
            failedRequests: 0,
            errorRatePercent: 0,
            requestsPerSecond: 4,
            latencyMs: { average: 12, p50: 10, p95: 20, p99: null },
          },
        },
      },
    },
  });
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("CPU sample 80%")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("CPU sample unavailable")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("probe completion")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("not a measurement of service capacity")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("CPU quota throttling was verified by inspect")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("not a consistent latency effect")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("not a significance test")), true);
  assert.equal(section?.bullets?.some((bullet) => bullet.includes("CPU 0%")), false);
  const { downloadReportPdf } = await import("../src/lib/reportPdf");
  const captured: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    captured.push(blob);
    return "blob:cpu-report";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  const anchor = { href: "", download: "", rel: "", click() {}, remove() {} };
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => anchor,
    body: { appendChild() {}, removeChild() {} },
  } as unknown as Document;
  try {
    downloadReportPdf({
      composeFileName: "cpu.yml",
      sections: [section!],
      scores: { overall: 1, dependencySafety: 1, faultTolerance: 1, recoveryCapability: 1, monitoringVisibility: 1 },
      criticalCount: 0,
      warningCount: 0,
    });
    const text = Buffer.from(await captured[0].arrayBuffer()).toString("latin1");
    assert.match(text, /cpu-1/);
    assert.match(text, /sample unavailable/);
    assert.match(text, /CPU 5%/);
    assert.match(text, /probe completion/);
    assert.match(text, /not a measurement of service/);
    assert.match(text, /capacity/);
    assert.match(text, /Verified CPU throttling/);
    assert.match(text, /significance test/);
    assert.match(text, /consistent latency/);
    assert.equal(text.includes("CPU 0%"), false);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    globalThis.document = previousDocument;
  }
});

test("a simulation record is labeled as not measured", () => {
  const section = buildMeasuredSection({
    ...experiment,
    mode: "simulation",
    verdict: "INCONCLUSIVE",
    evidence: { ...experiment.evidence!, provenance: "predicted", phases: { baseline: null } },
  });
  assert.equal(section?.title, "Simulated Experiment Record");
  assert.equal(section?.paragraphs[1].includes("does not contain live measurements"), true);
});
