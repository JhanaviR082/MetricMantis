function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snapshot(metrics, cpuPercent) {
  return {
    requests: finite(metrics?.totalRequests),
    requestsPerSecond: finite(metrics?.requestsPerSecond),
    errorRatePercent: finite(metrics?.errorRatePercent),
    p50: finite(metrics?.latencyMs?.p50),
    p95: finite(metrics?.latencyMs?.p95),
    cpuPercent: finite(cpuPercent),
  };
}

function changed(before, after, impactWhenHigher) {
  if (before == null || after == null) return null;
  return impactWhenHigher ? after > before : after < before;
}

// One stats sample is too noisy to call a small move an effect.
function cpuMoved(before, after, expectHigher) {
  if (before == null || after == null) return null;
  const delta = expectHigher ? after - before : before - after;
  return delta >= 20 ? true : null;
}

// p95 needs both an absolute and a relative gap before it is counted.
function latencyMoved(before, after, expectHigher) {
  if (before == null || after == null || before <= 0) return null;
  const delta = expectHigher ? after - before : before - after;
  return delta >= 10 && delta / before >= 0.25 ? true : null;
}

function errorMoved(before, after, expectHigher) {
  if (before == null || after == null) return null;
  const delta = expectHigher ? after - before : before - after;
  return delta >= 1 ? true : null;
}

function num(value, suffix) {
  return value == null ? "unavailable" : `${value}${suffix}`;
}

function phaseLine(label, row) {
  return [
    `${label}: ${num(row.requests, "")} requests,`,
    `probe completion ${num(row.requestsPerSecond, "")} req/s,`,
    `error ${num(row.errorRatePercent, "%")},`,
    `p50 ${num(row.p50, " ms")},`,
    `p95 ${num(row.p95, " ms")},`,
    `CPU ${num(row.cpuPercent, "%")}.`,
  ].join(" ");
}

function compareCpuPhases({ baseline, fault, recovery, cpu }) {
  const rows = {
    baseline: snapshot(baseline, cpu?.baseline),
    fault: snapshot(fault, cpu?.fault),
    recovery: snapshot(recovery, cpu?.recovery),
  };
  const faultVersusBaseline = {
    latencyIncreased: latencyMoved(rows.baseline.p95, rows.fault.p95, true),
    probeCompletionDecreased: changed(rows.baseline.requestsPerSecond, rows.fault.requestsPerSecond, false),
    errorRateIncreased: errorMoved(rows.baseline.errorRatePercent, rows.fault.errorRatePercent, true),
    cpuDecreased: cpuMoved(rows.baseline.cpuPercent, rows.fault.cpuPercent, false),
  };
  const recoveryVersusFault = {
    latencyDecreased: latencyMoved(rows.fault.p95, rows.recovery.p95, false),
    probeCompletionIncreased: changed(rows.fault.requestsPerSecond, rows.recovery.requestsPerSecond, true),
    errorRateDecreased: errorMoved(rows.fault.errorRatePercent, rows.recovery.errorRatePercent, false),
    cpuIncreased: cpuMoved(rows.fault.cpuPercent, rows.recovery.cpuPercent, true),
  };
  return {
    ...rows,
    faultVersusBaseline,
    recoveryVersusFault,
    summary: [
      phaseLine("Baseline", rows.baseline),
      phaseLine("CPU-limited", rows.fault),
      phaseLine("Recovery", rows.recovery),
      distinction(rows),
    ].join(" "),
  };
}

function distinction(rows) {
  const cpu = rows.baseline.cpuPercent == null || rows.fault.cpuPercent == null
    ? "CPU percentage: unavailable. No sample was invented."
    : `CPU percentage: one sample per phase, ${rows.baseline.cpuPercent}%, ${rows.fault.cpuPercent}%, ${rows.recovery.cpuPercent == null ? "unavailable" : `${rows.recovery.cpuPercent}%`}.`;
  const latency = rows.baseline.p95 == null || rows.fault.p95 == null
    ? "p95 latency: unavailable."
    : `p95 latency: ${rows.baseline.p95} ms, ${rows.fault.p95} ms, ${rows.recovery.p95 == null ? "unavailable" : `${rows.recovery.p95} ms`}.`;
  return [
    "Verified CPU throttling is the docker inspect quota result, separate from latency.",
    `${cpu} A single docker stats sample is not a significance test and is not a pass.`,
    `${latency} One window is not a consistent latency effect.`,
    "Probe completion req/s follows the configured send rate. It is not service capacity.",
  ].join(" ");
}

module.exports = { compareCpuPhases };
