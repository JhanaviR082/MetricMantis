const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateMeasured, verdictFrom } = require("./assertions");

function metrics(errorRatePercent, total = 10, p95 = 100) {
  return {
    totalRequests: total,
    errorRatePercent,
    latencyMs: { p95 },
    notes: [],
  };
}

test("thresholds pass on the boundary and fail just above it", () => {
  const atLimit = evaluateMeasured({
    faultType: "measure",
    phases: { baseline: { metrics: metrics(5, 10, 1000) } },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000 },
  });
  assert.equal(atLimit.find((item) => item.id === "error_rate").result, "PASSED");
  assert.equal(atLimit.find((item) => item.id === "p95").result, "PASSED");
  assert.equal(verdictFrom(atLimit, "RUNNING"), "PASSED");

  const over = evaluateMeasured({
    faultType: "measure",
    phases: { baseline: { metrics: metrics(5.01, 10, 1001) } },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000 },
  });
  assert.equal(over.find((item) => item.id === "error_rate").result, "FAILED");
  assert.equal(verdictFrom(over, "RUNNING"), "FAILED");
});

test("an unverified latency change is not attributed to netem", () => {
  const result = evaluateMeasured({
    faultType: "latency",
    phases: {
      baseline: { metrics: metrics(0, 10, 1289) },
      fault: {
        metrics: metrics(0, 10, 2093),
        execution: { attempted: true, verified: false, detail: "tc qdisc show dev eth0 did not report delay 100ms." },
      },
    },
    cleanup: { status: "restored", detail: "tc qdisc show no longer reported netem." },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  const impact = result.find((item) => item.id === "latency_impact");
  assert.equal(impact.result, "INCONCLUSIVE");
  assert.match(impact.detail, /not attributed/);
  assert.equal(result.find((item) => item.id === "fault_verified").result, "FAILED");
  assert.equal(verdictFrom(result, "RUNNING"), "FAILED");
});

test("an unverified packet-loss change is not attributed to netem", () => {
  const result = evaluateMeasured({
    faultType: "packet_loss",
    phases: {
      baseline: { metrics: metrics(0, 10, 40) },
      fault: {
        metrics: metrics(40, 10, 40),
        execution: { attempted: true, verified: false, detail: "tc qdisc show dev eth0 did not report loss 5%." },
      },
    },
    cleanup: { status: "restored", detail: "tc qdisc show no longer reported netem." },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  const impact = result.find((item) => item.id === "loss_impact");
  assert.equal(impact.result, "INCONCLUSIVE");
  assert.match(impact.detail, /not attributed/);
  assert.equal(result.find((item) => item.id === "fault_verified").result, "FAILED");
  assert.equal(verdictFrom(result, "RUNNING"), "FAILED");
});

test("missing samples are inconclusive and an executor success flag is not a verdict", () => {
  const empty = evaluateMeasured({
    faultType: "measure",
    phases: { baseline: { metrics: { totalRequests: 0, errorRatePercent: null, latencyMs: {} } } },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000 },
  });
  assert.equal(empty[0].result, "INCONCLUSIVE");
  assert.equal(verdictFrom(empty, "RUNNING"), "INCONCLUSIVE");

  const commandOnly = evaluateMeasured({
    faultType: "stop",
    phases: {
      baseline: { metrics: metrics(0) },
      fault: { metrics: metrics(0), execution: { verified: false, observed: "running" } },
      recovery: { metrics: metrics(0) },
    },
    cleanup: { status: "not_required", detail: "unchanged" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 1000 },
  });
  assert.equal(commandOnly.find((item) => item.id === "fault_verified").result, "FAILED");
  assert.equal(verdictFrom(commandOnly, "RUNNING"), "FAILED");
});

test("stop impact uses the fault window, and recovery time uses the deadline", () => {
  const separated = evaluateMeasured({
    faultType: "stop",
    phases: {
      baseline: { metrics: metrics(0) },
      fault: { metrics: metrics(80), execution: { verified: true, observed: "exited" } },
      recovery: { metrics: metrics(0) },
    },
    cleanup: { status: "restored", detail: "running" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 1000 },
  });
  assert.equal(separated.find((item) => item.id === "impact").observed, "0% -> 80%");
  assert.equal(verdictFrom(separated, "RUNNING"), "PASSED");

  const late = evaluateMeasured({
    faultType: "restart",
    phases: {
      fault: { execution: { verified: true, observed: "running" } },
      recovery: { metrics: metrics(0) },
    },
    container: { recoveryTimeMs: 1001 },
    cleanup: { status: "restored", detail: "running" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 1000 },
  });
  assert.equal(late.find((item) => item.id === "recovery_time").result, "FAILED");
  const onTime = evaluateMeasured({
    faultType: "restart",
    phases: {
      fault: { execution: { verified: true, observed: "running" } },
      recovery: { metrics: metrics(0) },
    },
    container: { recoveryTimeMs: 1000 },
    cleanup: { status: "restored", detail: "running" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 1000 },
  });
  assert.equal(onTime.find((item) => item.id === "recovery_time").result, "PASSED");
});

test("cpu verdict follows quota, workload, probes, and cleanup", () => {
  const passed = evaluateMeasured({
    faultType: "cpu",
    phases: {
      baseline: { metrics: metrics(0) },
      fault: { execution: { verified: true, observed: "cpu quota 5000" }, metrics: metrics(0) },
      recovery: { metrics: metrics(0) },
    },
    container: {
      workload: { started: true, detail: "running" },
      cpuComparison: {
        baseline: { cpuPercent: 100 },
        fault: { cpuPercent: 5 },
        faultVersusBaseline: { latencyIncreased: true, probeCompletionDecreased: true, cpuDecreased: true },
      },
    },
    cleanup: { status: "restored", detail: "quota -1" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  assert.equal(passed.find((item) => item.id === "fault_verified").result, "PASSED");
  assert.equal(passed.find((item) => item.id === "probe_windows").result, "PASSED");
  assert.equal(passed.some((item) => item.id === "cpu_impact"), false);
  assert.equal(verdictFrom(passed, "RUNNING"), "PASSED");

  const missingSample = evaluateMeasured({
    faultType: "cpu",
    phases: {
      baseline: { metrics: metrics(0) },
      fault: { execution: { verified: true, observed: "cpu quota 5000" }, metrics: metrics(0) },
      recovery: { metrics: metrics(0) },
    },
    container: {
      workload: { started: true, detail: "running" },
      cpuComparison: { baseline: { cpuPercent: null }, fault: { cpuPercent: null } },
    },
    cleanup: { status: "restored", detail: "quota -1" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  assert.equal(missingSample.find((item) => item.id === "cpu_sample").result, "INCONCLUSIVE");
  assert.equal(verdictFrom(missingSample, "RUNNING"), "INCONCLUSIVE");

  const noProbes = evaluateMeasured({
    faultType: "cpu",
    phases: { fault: { execution: { verified: true, observed: "cpu quota 5000" } } },
    container: { workload: { started: true, detail: "running" }, cpuComparison: { baseline: { cpuPercent: 10 }, fault: { cpuPercent: 5 } } },
    cleanup: { status: "restored", detail: "quota -1" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  assert.equal(noProbes.find((item) => item.id === "probe_windows").result, "INCONCLUSIVE");
  assert.equal(verdictFrom(noProbes, "RUNNING"), "INCONCLUSIVE");

  const noWorkload = evaluateMeasured({
    faultType: "cpu",
    phases: {
      baseline: { metrics: metrics(0) },
      fault: { execution: { verified: true, observed: "cpu quota 5000" }, metrics: metrics(0) },
      recovery: { metrics: metrics(0) },
    },
    container: { workload: { started: false, detail: "not observed" }, cpuComparison: { baseline: { cpuPercent: 1 }, fault: { cpuPercent: 1 } } },
    cleanup: { status: "restored", detail: "quota -1" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  assert.equal(noWorkload.find((item) => item.id === "cpu_workload").result, "INCONCLUSIVE");
  assert.equal(verdictFrom(noWorkload, "RUNNING"), "INCONCLUSIVE");

  const dirty = evaluateMeasured({
    faultType: "cpu",
    phases: {
      baseline: { metrics: metrics(0) },
      fault: { execution: { verified: true, observed: "cpu quota 5000" }, metrics: metrics(0) },
      recovery: { metrics: metrics(0) },
    },
    container: { workload: { started: true, detail: "running" }, cpuComparison: { baseline: { cpuPercent: 90 }, fault: { cpuPercent: 5 } } },
    cleanup: { status: "failed", detail: "quota still 5000" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  assert.equal(dirty.find((item) => item.id === "cleanup").result, "FAILED");
  assert.equal(verdictFrom(dirty, "RUNNING"), "FAILED");

  const probeErrors = evaluateMeasured({
    faultType: "cpu",
    phases: {
      baseline: { metrics: metrics(0) },
      fault: { execution: { verified: true, observed: "cpu quota 5000" }, metrics: metrics(0) },
      recovery: { metrics: metrics(100) },
    },
    container: { workload: { started: true, detail: "running" }, cpuComparison: { baseline: { cpuPercent: 90 }, fault: { cpuPercent: 5 } } },
    cleanup: { status: "restored", detail: "quota -1" },
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  });
  assert.equal(probeErrors.find((item) => item.id === "recovery_error_rate").result, "FAILED");
  assert.equal(verdictFrom(probeErrors, "RUNNING"), "FAILED");
});
