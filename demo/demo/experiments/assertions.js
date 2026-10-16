function assertion(id, name, result, expected, observed, detail) {
  return { id, name, result, expected, observed, detail };
}

function compareNumber({ id, name, observed, maximum, unavailableDetail }) {
  if (observed == null || !Number.isFinite(observed)) {
    return assertion(id, name, "INCONCLUSIVE", `<= ${maximum}`, null, unavailableDetail);
  }
  const passed = observed <= maximum;
  return assertion(
    id,
    name,
    passed ? "PASSED" : "FAILED",
    `<= ${maximum}`,
    observed,
    passed ? "Observed value is within the threshold." : "Observed value is above the threshold.",
  );
}

function evaluateMeasured({ faultType, phases, container, cleanup, thresholds }) {
  const results = [];
  const baseline = phases.baseline?.metrics;
  const fault = phases.fault?.metrics;
  const recovery = phases.recovery?.metrics;

  if (faultType === "measure") {
    if (!baseline || baseline.totalRequests === 0) {
      results.push(assertion(
        "samples",
        "Baseline collected requests",
        "INCONCLUSIVE",
        "> 0",
        baseline?.totalRequests ?? 0,
        "No HTTP samples were collected.",
      ));
    } else {
      results.push(assertion(
        "samples",
        "Baseline collected requests",
        "PASSED",
        "> 0",
        baseline.totalRequests,
        "Requests were recorded from the probe.",
      ));
      results.push(compareNumber({
        id: "error_rate",
        name: "Baseline error rate",
        observed: baseline.errorRatePercent,
        maximum: thresholds.maxErrorRatePercent,
        unavailableDetail: "Error rate is unavailable because no requests were recorded.",
      }));
      results.push(compareNumber({
        id: "p95",
        name: "Baseline p95 latency",
        observed: baseline.latencyMs?.p95,
        maximum: thresholds.maxP95Ms,
        unavailableDetail: baseline.notes?.find((note) => note.startsWith("p95"))
          || "p95 latency is unavailable.",
      }));
    }
    return results;
  }

  if (faultType === "stop" || faultType === "restart" || faultType === "cpu" || faultType === "memory" || faultType === "latency" || faultType === "packet_loss") {
    const verified = phases.fault?.execution?.verified === true;
    const name = faultType === "cpu"
      ? "CPU quota throttling was verified by inspect"
      : faultType === "memory"
        ? "Memory pressure file size was verified"
        : faultType === "latency" || faultType === "packet_loss"
          ? "Netem rule was verified with tc qdisc show"
          : "Fault was independently verified";
    results.push(assertion(
      "fault_verified",
      name,
      verified ? "PASSED" : "FAILED",
      "verified",
      phases.fault?.execution?.observed ?? null,
      phases.fault?.execution?.detail || "The fault was not verified.",
    ));
  }

  if (faultType === "stop") {
    const baseRate = baseline?.errorRatePercent;
    const faultRate = fault?.errorRatePercent;
    if (baseRate == null || faultRate == null) {
      results.push(assertion(
        "impact",
        "Probe error rate rose during the stop",
        "INCONCLUSIVE",
        "fault error rate > baseline error rate",
        null,
        "One of the measurement windows has no requests.",
      ));
    } else if (faultRate > baseRate) {
      results.push(assertion(
        "impact",
        "Probe error rate rose during the stop",
        "PASSED",
        "fault error rate > baseline error rate",
        `${baseRate}% -> ${faultRate}%`,
        "The probe observed a higher error rate while the container was stopped.",
      ));
    } else {
      results.push(assertion(
        "impact",
        "Probe error rate rose during the stop",
        "FAILED",
        "fault error rate > baseline error rate",
        `${baseRate}% -> ${faultRate}%`,
        "Stopping the container did not change the probed error rate.",
      ));
    }
  }

  if (faultType === "memory") {
    const before = phases.baseline?.memoryBytes;
    const during = phases.fault?.memoryBytes;
    if (before == null || during == null) {
      results.push(assertion(
        "memory_sample",
        "Memory sample increased during the fault",
        "INCONCLUSIVE",
        "fault memory bytes > baseline memory bytes",
        null,
        "A memory sample was missing, so no memory impact was claimed.",
      ));
    } else if (during > before) {
      results.push(assertion(
        "memory_sample",
        "Memory sample increased during the fault",
        "PASSED",
        "fault memory bytes > baseline memory bytes",
        `${before} -> ${during}`,
        "docker stats memory was higher while the pressure file was present. This is one sample, not a capacity test.",
      ));
    } else {
      results.push(assertion(
        "memory_sample",
        "Memory sample increased during the fault",
        "INCONCLUSIVE",
        "fault memory bytes > baseline memory bytes",
        `${before} -> ${during}`,
        "The memory sample did not increase, so no memory impact was claimed.",
      ));
    }
  }

  if (faultType === "latency") {
    const before = baseline?.latencyMs?.p95;
    const during = fault?.latencyMs?.p95;
    if (phases.fault?.execution?.verified !== true) {
      results.push(assertion(
        "latency_impact",
        "Fault-window p95 was higher than baseline",
        "INCONCLUSIVE",
        "verified netem delay and fault p95 > baseline p95",
        before != null && during != null ? `${before} -> ${during}` : null,
        "The p95 change was not attributed to the fault because tc qdisc show did not confirm the requested delay.",
      ));
    } else if (before == null || during == null) {
      results.push(assertion(
        "latency_impact",
        "Fault-window p95 was higher than baseline",
        "INCONCLUSIVE",
        "fault p95 > baseline p95",
        null,
        "p95 was unavailable for a window, so no latency impact was claimed.",
      ));
    } else if (during > before) {
      results.push(assertion(
        "latency_impact",
        "Fault-window p95 was higher than baseline",
        "PASSED",
        "fault p95 > baseline p95",
        `${before} -> ${during}`,
        "The requested delay was visible on the egress interface, and the measured p95 was higher in that window.",
      ));
    } else {
      results.push(assertion(
        "latency_impact",
        "Fault-window p95 was higher than baseline",
        "INCONCLUSIVE",
        "fault p95 > baseline p95",
        `${before} -> ${during}`,
        "p95 did not rise, so no latency impact was claimed.",
      ));
    }
  }

  if (faultType === "packet_loss") {
    const baseRate = baseline?.errorRatePercent;
    const faultRate = fault?.errorRatePercent;
    if (phases.fault?.execution?.verified !== true) {
      results.push(assertion(
        "loss_impact",
        "Probe error rate rose during packet loss",
        "INCONCLUSIVE",
        "verified netem loss and fault error rate > baseline error rate",
        baseRate != null && faultRate != null ? `${baseRate}% -> ${faultRate}%` : null,
        "The error-rate change was not attributed to the fault because tc qdisc show did not confirm the requested loss.",
      ));
    } else if (baseRate == null || faultRate == null) {
      results.push(assertion(
        "loss_impact",
        "Probe error rate rose during packet loss",
        "INCONCLUSIVE",
        "fault error rate > baseline error rate",
        null,
        "One of the measurement windows has no requests, so no packet-loss impact was claimed.",
      ));
    } else if (faultRate > baseRate) {
      results.push(assertion(
        "loss_impact",
        "Probe error rate rose during packet loss",
        "PASSED",
        "fault error rate > baseline error rate",
        `${baseRate}% -> ${faultRate}%`,
        "The probe observed a higher error rate while the loss rule was active.",
      ));
    } else {
      results.push(assertion(
        "loss_impact",
        "Probe error rate rose during packet loss",
        "INCONCLUSIVE",
        "fault error rate > baseline error rate",
        `${baseRate}% -> ${faultRate}%`,
        "The error rate did not rise, so no packet-loss impact was claimed.",
      ));
    }
  }

  if (faultType === "cpu") {
    const workloadStarted = container?.workload?.started === true;
    results.push(assertion(
      "cpu_workload",
      "Controlled CPU workload ran",
      workloadStarted ? "PASSED" : "INCONCLUSIVE",
      "workload running",
      workloadStarted ? "running" : null,
      container?.workload?.detail || "The CPU workload was not observed.",
    ));
    const baselineRequests = baseline?.totalRequests;
    const faultRequests = fault?.totalRequests;
    const probesRecorded = baselineRequests > 0 && faultRequests > 0;
    results.push(assertion(
      "probe_windows",
      "Probe windows recorded requests",
      probesRecorded ? "PASSED" : "INCONCLUSIVE",
      "baseline and fault requests > 0",
      probesRecorded ? `${baselineRequests} then ${faultRequests}` : null,
      probesRecorded
        ? "Probe completion rate is the configured send rate. It is not service capacity."
        : "A probe window recorded no requests. Rates and latency are unavailable and were not stored as zero.",
    ));
    if (workloadStarted) {
      const baselineCpu = container?.cpuComparison?.baseline?.cpuPercent;
      const faultCpu = container?.cpuComparison?.fault?.cpuPercent;
      if (baselineCpu == null || faultCpu == null) {
        results.push(assertion(
          "cpu_sample",
          "CPU percentage sample",
          "INCONCLUSIVE",
          "one sample per phase",
          null,
          "A CPU sample was unavailable. No percentage was invented. The quota check is separate from this sample.",
        ));
      }
    }
  }

  if (recovery) {
    results.push(compareNumber({
      id: "recovery_error_rate",
      name: "Recovery error rate",
      observed: recovery.errorRatePercent,
      maximum: thresholds.maxErrorRatePercent,
      unavailableDetail: "Recovery error rate is unavailable.",
    }));
  }

  if (faultType === "restart") {
    results.push(assertion(
      "recovery_time",
      "Container returned to running",
      container?.recoveryTimeMs != null && container.recoveryTimeMs <= thresholds.recoveryTimeoutMs
        ? "PASSED"
        : container?.recoveryTimeMs == null ? "FAILED" : "FAILED",
      `<= ${thresholds.recoveryTimeoutMs} ms`,
      container?.recoveryTimeMs ?? null,
      container?.recoveryTimeMs == null
        ? "The container was not observed running again."
        : "Recovery time is the gap between the restart command and a running inspect.",
    ));
  }

  results.push(assertion(
    "cleanup",
    "Cleanup restored the target",
    cleanup?.status === "restored" || cleanup?.status === "not_required"
      ? "PASSED"
      : cleanup?.status === "failed" ? "FAILED" : "INCONCLUSIVE",
    "restored or not_required",
    cleanup?.status ?? null,
    cleanup?.detail || "Cleanup status was not recorded.",
  ));

  return results;
}

function verdictFrom(assertions, status) {
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "ERROR") return "ERROR";
  if (assertions.some((item) => item.result === "FAILED")) return "FAILED";
  if (assertions.some((item) => item.result === "INCONCLUSIVE")) return "INCONCLUSIVE";
  if (assertions.length && assertions.every((item) => item.result === "PASSED")) return "PASSED";
  return "INCONCLUSIVE";
}

module.exports = { evaluateMeasured, verdictFrom };
