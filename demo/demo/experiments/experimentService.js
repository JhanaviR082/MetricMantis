const { summarizeHttp } = require("./metrics");
const { runWorkload } = require("./workload");
const { compareCpuPhases } = require("./cpuComparison");
const { evaluateMeasured, verdictFrom } = require("./assertions");
const { isSafeServiceName } = require("./dockerExecutor");
const { parseProbeUrl, prepareProbe } = require("./probeTarget");
const sandboxRepository = require("../database/sandboxRepository");
const sandboxRuntime = require("../sandboxes/sandboxRuntime");
const { probeEndpoint, runSandboxProbe } = require("./sandboxProbe");
const faultLease = require("./faultLease");

const SANDBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const MEASURE_LIMIT = "Measure only cannot probe this sandbox. The approved sample does not publish a host port, so no HTTP request was sent.";
const SANDBOX_PROBE_LIMIT = "HTTP probes use the supplied URL. They are not requests to the sandbox container, because the approved sample does not publish a host port.";

const FAULTS = new Set(["measure", "stop", "restart", "latency", "cpu", "packet_loss", "memory"]);

function probeAllowlist(env = process.env) {
  const raw = env.METRICMANTIS_PROBE_ALLOWLIST || "127.0.0.1,localhost";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function validateExperiment(body, env = process.env) {
  const mode = body?.mode === "simulation" ? "simulation" : body?.mode === "measured" ? "measured" : null;
  const faultType = body?.faultType;
  const targetService = typeof body?.targetService === "string" ? body.targetService.trim() : "";
  if (!mode) return { error: "mode must be measured or simulation." };
  if (!FAULTS.has(faultType)) return { error: "faultType is not supported." };
  if (!isSafeServiceName(targetService)) return { error: "targetService must be a single container name." };

  const hypothesis = typeof body?.hypothesis === "string" ? body.hypothesis.trim().slice(0, 300) : "";
  const edges = Array.isArray(body?.edges)
    ? body.edges.filter((edge) => isSafeServiceName(edge?.from) && isSafeServiceName(edge?.to)).slice(0, 100)
    : [];

  if (mode === "simulation") {
    return {
      value: {
        mode,
        faultType,
        targetService,
        hypothesis,
        edges,
        name: `${faultType} simulation on ${targetService}`,
      },
    };
  }

  const durations = {
    baselineMs: clampInt(body?.baselineMs, 200, 10000, 2000),
    faultDurationMs: clampInt(body?.faultDurationMs, 200, 15000, 2000),
    recoveryMs: clampInt(body?.recoveryMs, 200, 10000, 2000),
    ratePerSecond: clampInt(body?.ratePerSecond, 1, 20, 5),
    concurrency: clampInt(body?.concurrency, 1, 4, 2),
    timeoutMs: clampInt(body?.timeoutMs, 200, 5000, 1000),
  };
  const thresholds = {
    maxErrorRatePercent: clampNumber(body?.thresholds?.maxErrorRatePercent, 0, 100, 5),
    maxP95Ms: clampNumber(body?.thresholds?.maxP95Ms, 1, 30000, 1000),
    recoveryTimeoutMs: clampNumber(body?.thresholds?.recoveryTimeoutMs, 200, 20000, 5000),
  };

  let probeUrl = "";
  let fetchUrl = "";
  if (typeof body?.probeUrl === "string" && body.probeUrl.trim()) {
    const parsed = parseProbeUrl(body.probeUrl, probeAllowlist(env));
    if (parsed.error) return parsed;
    probeUrl = parsed.url;
    fetchUrl = parsed.url;
  } else {
    probeUrl = probeEndpoint(targetService) || "";
    fetchUrl = probeUrl;
  }
  if (!SANDBOX_ID.test(body?.sandboxId || "")) {
    return { error: "A running sandbox is required." };
  }

  return {
    value: {
      mode,
      faultType,
      targetService,
      hypothesis,
      edges,
      probeUrl,
      fetchUrl,
      ...durations,
      thresholds,
      memoryMib: [4, 8, 12].includes(Number(body?.memoryMib)) ? Number(body.memoryMib) : 8,
      latencyMs: clampInt(body?.latencyMs, 20, 500, 100),
      lossPercent: clampInt(body?.lossPercent, 1, 20, 5),
      sandboxId: body.sandboxId,
      name: `${faultType} measured on ${targetService}`,
    },
  };
}

function verifiedTarget(config) {
  const container = config?.verifiedContainer;
  if (!container || typeof container !== "object") return null;
  if (!CONTAINER_ID.test(container.id) || !sandboxRuntime.isValidProjectName(container.projectName)) return null;
  if (container.service !== config.targetService || !isSafeServiceName(container.service)) return null;
  return container;
}

function dockerExpect(container) {
  return { id: container.id, project: container.projectName, service: container.service };
}

async function resolveSandboxTarget(userId, sandboxId, serviceName, deps = {}) {
  if (!isSafeServiceName(serviceName)) {
    return { error: "targetService must be a single container name.", status: 400 };
  }
  if (!SANDBOX_ID.test(sandboxId || "")) {
    return { error: "A running sandbox is required.", status: 409 };
  }
  const sandbox = sandboxRepository.getSandbox(sandboxId, userId);
  if (!sandbox) return { error: "Sandbox not found.", status: 404 };
  if (sandbox.status !== "running") {
    return { error: "The sandbox is not running, so the experiment was not started.", status: 409 };
  }
  if (!sandboxRuntime.isValidProjectName(sandbox.projectName)) {
    return { error: "The sandbox project name is invalid, so the experiment was not started.", status: 409 };
  }
  const execFileImpl = deps.execFileImpl || sandboxRuntime.defaultExec;
  const observed = await sandboxRuntime.readProjectRuntime(execFileImpl, sandbox.projectName, sandbox.services);
  if (!observed.services || observed.error) {
    return { error: observed.error || "The sandbox runtime could not be verified.", status: 409 };
  }
  const row = observed.services.find((item) => item.service === serviceName && item.verified && CONTAINER_ID.test(item.containerId));
  if (!row) {
    return { error: "The selected service is not a verified container in this sandbox.", status: 409 };
  }
  const identity = await sandboxRuntime.inspectContainer(execFileImpl, row.containerId);
  if (identity.error || identity.id !== row.containerId || identity.project !== sandbox.projectName || identity.service !== serviceName) {
    return { error: "Container labels do not match this sandbox.", status: 409 };
  }
  return {
    container: {
      id: identity.id,
      projectName: sandbox.projectName,
      service: serviceName,
    },
    status: 200,
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function reportProgress(deps, config, partial) {
  includeWarmup(partial.limitations, partial.phases);
  if (typeof deps.onProgress !== "function") return;
  try {
    await deps.onProgress({
      mode: "measured",
      provenance: "observed",
      targetService: config.targetService,
      faultType: config.faultType,
      hypothesis: config.hypothesis,
      probeUrl: config.probeUrl,
      parameters: {
        baselineMs: config.baselineMs,
        faultDurationMs: config.faultDurationMs,
        recoveryMs: config.recoveryMs,
        ratePerSecond: config.ratePerSecond,
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        thresholds: config.thresholds,
      },
      phases: partial.phases || {},
      cleanup: partial.cleanup || null,
      limitations: [
        ...(partial.limitations || []),
        "Partial measurements saved while the run is still in progress. The verdict is not final.",
      ],
      assertions: [],
      measurementErrors: partial.measurementErrors || [],
    });
  } catch {
    // A progress write must not change the experiment result.
  }
}

function declaredDependents(edges, target) {
  return edges.filter((edge) => edge.to === target).map((edge) => edge.from);
}

function simulationEvidence(config) {
  return {
    mode: "simulation",
    provenance: "predicted",
    targetService: config.targetService,
    faultType: config.faultType,
    hypothesis: config.hypothesis,
    declaredDependents: declaredDependents(config.edges, config.targetService),
    observedImpact: null,
    phases: { baseline: null, fault: null, recovery: null },
    assertions: [],
    limitations: [
      "This run is a simulation. No container was changed and no HTTP measurements were collected.",
      "Dependents listed here come from the Compose graph. They were not observed at runtime.",
    ],
    measurementErrors: [],
  };
}

function startedLater(before, after) {
  if (typeof before !== "string" || typeof after !== "string" || before === after) return false;
  const left = Date.parse(before.replace(/(\.\d{3})\d+/, "$1"));
  const right = Date.parse(after.replace(/(\.\d{3})\d+/, "$1"));
  if (Number.isFinite(left) && Number.isFinite(right)) return right > left;
  return after > before;
}

async function executeSandboxMeasurement(config, deps, now, signal) {
  const target = verifiedTarget(config);
  if (!target) {
    return errorResult(config, "No verified sandbox container was selected, so nothing was measured.", now, { provenance: "unavailable" });
  }
  if (!probeEndpoint(config.targetService)) {
    return errorResult(config, "This sandbox service has no approved HTTP health endpoint.", now, { provenance: "unavailable" });
  }
  const runProbe = deps.runSandboxProbe || runSandboxProbe;
  const limitations = [
    "Probes run on the sandbox network against the approved health endpoint. No host port is used.",
    "No fault was injected. Baseline, fault, and recovery are observation phases only.",
  ];
  const measurementErrors = [];
  const phases = { baseline: null, fault: null, recovery: null };
  const windows = [
    ["baseline", config.baselineMs],
    ["fault", config.faultDurationMs],
    ["recovery", config.recoveryMs],
  ];
  for (const [name, durationMs] of windows) {
    if (signal?.aborted) {
      return cancelledResult(config, now, "not_required", phases);
    }
    const run = await runProbe({
      projectName: target.projectName,
      service: config.targetService,
      durationMs,
      ratePerSecond: config.ratePerSecond,
      concurrency: config.concurrency,
      timeoutMs: config.timeoutMs,
      signal,
    });
    measurementErrors.push(...(run.measurementErrors || []));
    if (run.aborted || signal?.aborted) {
      if (run.observations?.length) phases[name] = phase(run);
      return cancelledResult(config, now, "not_required", phases);
    }
    if (run.error && !(run.observations || []).length) {
      return errorResult(config, run.error, now, { baseline: phases.baseline, provenance: "observed" });
    }
    phases[name] = phase(run);
    if (name === "fault") {
      phases.fault = {
        ...phases.fault,
        execution: { attempted: false, verified: false, observed: null, detail: "No fault was injected." },
      };
    }
    await reportProgress(deps, config, { phases, limitations, measurementErrors });
  }
  const cleanup = { status: "not_required", detail: "Measurement did not change a sandbox container." };
  const assertions = evaluateMeasured({
    faultType: "measure",
    phases,
    container: {},
    cleanup,
    thresholds: config.thresholds,
  });
  const verdict = verdictFrom(assertions, "RUNNING");
  return {
    status: verdict,
    verdict,
    cleanupStatus: cleanup.status,
    error: null,
    finishedAt: new Date(now()).toISOString(),
    evidence: {
      mode: "measured",
      provenance: "observed",
      targetService: config.targetService,
      faultType: config.faultType,
      hypothesis: config.hypothesis,
      probeUrl: probeEndpoint(config.targetService),
      parameters: {
        baselineMs: config.baselineMs,
        faultDurationMs: config.faultDurationMs,
        recoveryMs: config.recoveryMs,
        ratePerSecond: config.ratePerSecond,
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        thresholds: config.thresholds,
      },
      declaredDependents: declaredDependents(config.edges, config.targetService),
      observedImpact: impactText("measure", phases),
      phases,
      assertions,
      cleanup,
      limitations,
      measurementErrors: [...new Set(measurementErrors)].slice(0, 8),
    },
  };
}

async function sampleResource(deps, id, expected, measurementErrors) {
  if (typeof deps.docker.stats !== "function") return {};
  const sample = await deps.docker.stats(id, expected);
  if (!sample?.ok) {
    measurementErrors.push(sample?.detail || "docker stats did not return a sample.");
    return {};
  }
  return {
    cpuPercent: Number.isFinite(sample.cpuPercent) ? sample.cpuPercent : null,
    memoryBytes: Number.isFinite(sample.memoryBytes) ? sample.memoryBytes : null,
  };
}

async function executeRestoredFault(config, deps, now, signal) {
  const target = verifiedTarget(config);
  const expect = dockerExpect(target);
  const limitations = [deps.sandboxProbe === true
    ? "HTTP probes run inside the sandbox network against the approved health endpoint."
    : SANDBOX_PROBE_LIMIT];
  if (!probeEndpoint(config.targetService)) {
    limitations.push("This service has no approved HTTP endpoint. Request counts and latency stay unavailable.");
  }
  if (config.faultType === "latency" || config.faultType === "packet_loss") {
    limitations.push("The netem rule is on the verified container's egress interface. It is removed before the recovery window.");
  }
  const measurementErrors = [];
  const baselineRun = await probe(config, config.baselineMs, deps);
  measurementErrors.push(...(baselineRun.measurementErrors || []));
  const baseline = { ...phase(baselineRun), ...(await sampleResource(deps, target.id, expect, measurementErrors)) };
  await reportProgress(deps, config, { phases: { baseline }, limitations, measurementErrors });
  if (signal?.aborted) return cancelledResult(config, now, "not_required", { baseline });

  let faultExecution = { attempted: false, verified: false, observed: null, detail: "The fault was not applied." };
  let cleanup = { status: "not_required", detail: "The fault was not applied." };
  let sidecarId = null;
  let faultRun = null;
  let faultSample = {};
  let applied = false;
  try {
    if (config.faultType === "memory") {
      faultLease.writeLease({ fault: "memory", id: target.id, expected: expect });
      const result = await deps.docker.applyMemory(target.id, expect, config.memoryMib);
      applied = result?.verified === true;
      faultExecution = {
        attempted: true,
        verified: applied,
        observed: result?.bytes ?? null,
        detail: result?.detail || "Memory pressure was not verified.",
      };
    } else {
      const spec = config.faultType === "latency"
        ? { delayMs: config.latencyMs }
        : { lossPercent: config.lossPercent };
      const result = await deps.docker.applyNetem(target.id, expect, spec);
      sidecarId = result?.sidecarId || null;
      if (sidecarId) {
        faultLease.writeLease({ fault: config.faultType, id: target.id, expected: expect, sidecarId });
      }
      applied = result?.verified === true;
      faultExecution = {
        attempted: true,
        verified: applied,
        observed: result?.detail || null,
        detail: result?.detail || "The network rule was not verified.",
      };
    }
    if (!signal?.aborted) {
      faultRun = await probe(config, config.faultDurationMs, deps);
      measurementErrors.push(...(faultRun.measurementErrors || []));
      faultSample = await sampleResource(deps, target.id, expect, measurementErrors);
      const faultPhase = {
        ...phase(faultRun),
        execution: faultExecution,
        ...faultSample,
      };
      await reportProgress(deps, config, {
        phases: { baseline, fault: faultPhase },
        limitations,
        measurementErrors,
        cleanup: { status: "pending", detail: "The fault is still applied. Cleanup has not been verified." },
      });
    }
  } catch (error) {
    measurementErrors.push(error.message || "Experiment failed.");
  } finally {
    try {
      if (config.faultType === "memory") {
        const cleared = await deps.docker.clearMemory(target.id, expect);
        cleanup = { status: cleared?.ok ? "restored" : "failed", detail: cleared?.detail || "Memory cleanup did not report a result." };
      } else if (applied || sidecarId) {
        const cleared = await deps.docker.clearNetem(target.id, expect, sidecarId);
        cleanup = { status: cleared?.ok ? "restored" : "failed", detail: cleared?.detail || "Network cleanup did not report a result." };
      }
    } catch {
      cleanup = { status: "failed", detail: "Cleanup threw before the fault could be removed." };
    }
    if (cleanup.status === "restored" || cleanup.status === "not_required") faultLease.clearLease();
  }

  if (signal?.aborted) {
    return cancelledResult(config, now, cleanup.status, {
      baseline,
      fault: faultRun ? { ...phase(faultRun), execution: faultExecution } : null,
      cleanup,
    });
  }

  const recoveryRun = await probe(config, config.recoveryMs, deps);
  measurementErrors.push(...(recoveryRun.measurementErrors || []));
  const phases = {
    baseline,
    fault: faultRun ? { ...phase(faultRun), execution: faultExecution, ...faultSample } : null,
    recovery: { ...phase(recoveryRun), ...(await sampleResource(deps, target.id, expect, measurementErrors)) },
  };
  const assertions = evaluateMeasured({
    faultType: config.faultType,
    phases,
    container: { memoryMib: config.memoryMib, latencyMs: config.latencyMs, lossPercent: config.lossPercent },
    cleanup,
    thresholds: config.thresholds,
  });
  const verdict = verdictFrom(assertions, "RUNNING");
  return {
    status: verdict,
    verdict,
    cleanupStatus: cleanup.status,
    error: null,
    finishedAt: new Date(now()).toISOString(),
    evidence: {
      mode: "measured",
      provenance: "observed",
      targetService: config.targetService,
      faultType: config.faultType,
      hypothesis: config.hypothesis,
      probeUrl: probeEndpoint(config.targetService) || "",
      parameters: {
        baselineMs: config.baselineMs,
        faultDurationMs: config.faultDurationMs,
        recoveryMs: config.recoveryMs,
        ratePerSecond: config.ratePerSecond,
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        memoryMib: config.memoryMib,
        latencyMs: config.latencyMs,
        lossPercent: config.lossPercent,
        thresholds: config.thresholds,
      },
      declaredDependents: declaredDependents(config.edges, config.targetService),
      observedImpact: impactText(config.faultType, phases),
      phases,
      assertions,
      cleanup,
      limitations,
      measurementErrors: [...new Set(measurementErrors)].slice(0, 8),
    },
  };
}

async function executeExperiment(config, deps) {
  const now = deps.now || Date.now;
  const signal = deps.signal;
  if (config.mode === "simulation") {
    return {
      status: "INCONCLUSIVE",
      verdict: "INCONCLUSIVE",
      cleanupStatus: "not_required",
      error: null,
      finishedAt: new Date(now()).toISOString(),
      evidence: simulationEvidence(config),
    };
  }

  if (config.faultType !== "measure") {
    const caps = await deps.docker.capabilities();
    if (!caps.dockerAvailable) return errorResult(config, "Docker is not available, so the fault was not applied.", now);
    if (!caps.chaosEnabled) {
      return errorResult(config, "Real chaos is disabled. Set METRICMANTIS_CHAOS_ENABLED=true to allow approved containers.", now);
    }
    if (!caps.allowlist.includes(config.targetService)) {
      return errorResult(config, `${config.targetService} is not in METRICMANTIS_CHAOS_ALLOWLIST.`, now);
    }
    if (!verifiedTarget(config)) {
      return errorResult(config, "No verified sandbox container was selected, so the fault was not applied.", now);
    }
  }

  if (config.faultType === "measure") {
    return executeSandboxMeasurement(config, deps, now, signal);
  }
  if (config.faultType === "memory" || config.faultType === "latency" || config.faultType === "packet_loss") {
    return executeRestoredFault(config, deps, now, signal);
  }

  if (signal?.aborted) return cancelledResult(config, now, "not_required");

  let measured = config;
  if (deps.sandboxProbe === true) {
    measured = { ...config, probeUrl: probeEndpoint(config.targetService) || "" };
  } else {
    const prepared = await prepareProbe(config.probeUrl, probeAllowlist(deps.env), deps.lookup);
    if (prepared.error) return errorResult(config, prepared.error, now);
    measured = { ...config, fetchUrl: prepared.fetchUrl, probeUrl: prepared.url };
  }

  const limitations = [deps.sandboxProbe === true
    ? "HTTP probes run inside the sandbox network against the approved health endpoint."
    : SANDBOX_PROBE_LIMIT];
  const measurementErrors = [];
  const target = verifiedTarget(config);
  const expect = dockerExpect(target);
  const dependents = declaredDependents(config.edges, config.targetService);
  if (dependents.length) {
    limitations.push(
      `Declared dependents from Compose: ${dependents.join(", ")}. They are predicted relationships, not observed failures.`,
    );
  }

  if (config.faultType === "cpu") {
    return executeCpuExperiment(measured, deps, { now, signal, limitations, measurementErrors, dependents });
  }

  const baselineRun = await probe(measured, measured.baselineMs, deps);
  measurementErrors.push(...baselineRun.measurementErrors);
  const baseline = phase(baselineRun);
  await reportProgress(deps, measured, { phases: { baseline }, limitations, measurementErrors });

  if (signal?.aborted) return cancelledResult(config, now, "not_required", { baseline });

  let faultExecution = { attempted: false, verified: false, observed: null, detail: "No fault was requested." };
  let container = {};
  let cleanup = { status: "not_required", detail: "This experiment did not change a container." };
  let faultRun = null;

  try {
    if (config.faultType === "stop") {
      faultLease.writeLease({ fault: "stop", id: target.id, expected: expect });
      container.before = await deps.docker.inspect(target.id);
      const stopped = await deps.docker.stop(target.id, expect);
      container.during = await deps.docker.inspect(target.id);
      const verified = container.before?.status === "running"
        && container.during?.ok
        && container.during.status !== "running";
      faultExecution = {
        attempted: true,
        verified,
        observed: container.during?.status || null,
        detail: verified
          ? "docker inspect showed the container leave the running state."
          : stopped.detail || container.during?.detail || "The stop was not observed.",
      };
      faultRun = await probe(measured, measured.faultDurationMs, deps);
    } else if (config.faultType === "restart") {
      const before = await deps.docker.inspect(target.id);
      const started = now();
      const restarted = await deps.docker.restart(target.id, expect);
      container.afterRestart = await deps.docker.inspect(target.id);
      container.before = before;
      const startMoved = startedLater(before.startedAt, container.afterRestart.startedAt);
      if (container.afterRestart.status === "running") {
        container.recoveryTimeMs = Math.max(0, now() - started);
      }
      const verified = Boolean(
        before.ok
        && container.afterRestart.ok
        && before.status === "running"
        && container.afterRestart.status === "running"
        && startMoved,
      );
      faultExecution = {
        attempted: true,
        verified,
        observed: container.afterRestart.status || null,
        detail: verified
          ? "docker inspect showed the container running with a newer start time."
          : startMoved
            ? (restarted.detail || "The restart was not observed.")
            : "docker inspect did not show a newer container start time.",
      };
      faultRun = await probe(measured, measured.faultDurationMs, deps);
      cleanup = {
        status: container.afterRestart.status === "running" ? "restored" : "failed",
        detail: container.afterRestart.status === "running"
          ? "docker inspect showed the container running after restart."
          : "The container was not running after restart.",
      };
    }
  } catch (error) {
    cleanup = await restoreStopped(config, deps, cleanup);
    return errorResult(config, error.message || "Experiment failed.", now, { baseline, cleanup });
  }

  if (config.faultType === "stop") {
    const stillRunning = container.during?.ok === true && container.during.status === "running";
    if (faultExecution.attempted && !stillRunning) {
      const started = await deps.docker.start(target.id, expect);
      container.after = await deps.docker.inspect(target.id);
      cleanup = {
        status: started.ok && container.after.status === "running" ? "restored" : "failed",
        detail: started.ok && container.after.status === "running"
          ? "docker start restored the container and inspect confirmed it is running."
          : started.detail || "Cleanup could not confirm the container is running.",
      };
      if (cleanup.status === "restored") faultLease.clearLease();
    } else {
      cleanup = { status: "not_required", detail: "The container was still running, so cleanup did not start it." };
    }
  }

  await reportProgress(deps, measured, {
    phases: {
      baseline,
      fault: faultRun ? { ...phase(faultRun), execution: faultExecution } : null,
    },
    cleanup,
    limitations,
    measurementErrors,
  });

  if (signal?.aborted) {
    return cancelledResult(config, now, cleanup.status, { baseline, fault: faultRun && phase(faultRun), cleanup });
  }

  const recoveryRun = config.faultType === "measure" ? null : await probe(measured, measured.recoveryMs, deps);
  if (recoveryRun) measurementErrors.push(...recoveryRun.measurementErrors);
  if (faultRun) measurementErrors.push(...faultRun.measurementErrors);

  const phases = {
    baseline,
    fault: faultRun ? { ...phase(faultRun), execution: faultExecution } : null,
    recovery: recoveryRun ? phase(recoveryRun) : null,
  };
  const assertions = evaluateMeasured({
    faultType: config.faultType,
    phases,
    container,
    cleanup,
    thresholds: config.thresholds,
  });
  const verdict = verdictFrom(assertions, "RUNNING");
  return {
    status: verdict,
    verdict,
    cleanupStatus: cleanup.status,
    error: null,
    finishedAt: new Date(now()).toISOString(),
    evidence: {
      mode: "measured",
      provenance: "observed",
      targetService: config.targetService,
      faultType: config.faultType,
      hypothesis: config.hypothesis,
      probeUrl: config.probeUrl,
      parameters: {
        baselineMs: config.baselineMs,
        faultDurationMs: config.faultDurationMs,
        recoveryMs: config.recoveryMs,
        ratePerSecond: config.ratePerSecond,
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        thresholds: config.thresholds,
      },
      declaredDependents: dependents,
      observedImpact: impactText(config.faultType, phases),
      container,
      phases,
      assertions,
      cleanup,
      limitations,
      measurementErrors: [...new Set(measurementErrors)].slice(0, 8),
    },
  };
}

async function sampleCpu(docker, name, measurementErrors, expected) {
  if (typeof docker.stats !== "function") {
    measurementErrors.push("docker stats is unavailable. No CPU percentage was invented.");
    return null;
  }
  const sample = await docker.stats(name, expected);
  if (!sample?.ok || !Number.isFinite(sample.cpuPercent)) {
    measurementErrors.push(sample?.detail || "docker stats did not return a CPU percentage.");
    return null;
  }
  return sample.cpuPercent;
}

async function executeCpuExperiment(config, deps, context) {
  const now = context.now;
  const signal = context.signal;
  const measurementErrors = context.measurementErrors;
  const target = verifiedTarget(config);
  const expect = dockerExpect(target);
  const name = target.id;
  const durationMs = config.baselineMs + config.faultDurationMs + config.recoveryMs + 12000;
  const container = {};
  const cpu = { baseline: null, fault: null, recovery: null };
  let before = null;
  let cleanup = { status: "not_required", detail: "CPU quota was not changed." };
  let baseline = null;
  let faultRun = null;
  let recoveryRun = null;
  let failure = null;
  let cancelled = false;
  let faultExecution = { attempted: false, verified: false, observed: null, detail: "The CPU quota was not changed." };

  try {
    const started = await deps.docker.startCpuWorkload(name, durationMs, expect);
    container.workload = {
      started: started?.ok === true,
      detail: started?.detail || "CPU workload did not start.",
    };
    if (!container.workload.started) measurementErrors.push(container.workload.detail);

    if (signal?.aborted) {
      cancelled = true;
    } else {
      const baselineRun = await probe(config, config.baselineMs, deps);
      measurementErrors.push(...baselineRun.measurementErrors);
      cpu.baseline = await sampleCpu(deps.docker, name, measurementErrors, expect);
      baseline = { ...phase(baselineRun), cpuPercent: cpu.baseline };
      await reportProgress(deps, config, {
        phases: { baseline },
        limitations: context.limitations,
        measurementErrors,
      });
    }

    if (!cancelled && signal?.aborted) cancelled = true;
    if (!cancelled) {
      const limited = await deps.docker.constrainCpu(name, expect);
      before = limited.before || null;
      if (before) faultLease.writeLease({ fault: "cpu", id: name, expected: expect, before });
      container.before = before;
      const afterLimit = await deps.docker.inspect(name);
      const nanoApplied = afterLimit.nanoCpus === 50_000_000;
      const quotaApplied = afterLimit.cpuQuota === 5000;
      const limitApplied = Boolean(limited.ok && afterLimit.ok && (nanoApplied || quotaApplied));
      container.during = afterLimit;
      faultExecution = {
        attempted: true,
        verified: limitApplied,
        observed: !afterLimit.ok
          ? null
          : nanoApplied
            ? "nanoCpus 50000000"
            : `cpu quota ${afterLimit.cpuQuota}`,
        detail: nanoApplied
          ? "docker inspect showed HostConfig.NanoCpus 50000000 after the update."
          : quotaApplied
            ? "docker inspect showed the CPU quota was 5000 after the update."
            : "The requested CPU limit was not observed on the container.",
      };
      faultRun = await probe(config, config.faultDurationMs, deps);
      measurementErrors.push(...faultRun.measurementErrors);
      cpu.fault = await sampleCpu(deps.docker, name, measurementErrors, expect);
      await reportProgress(deps, config, {
        phases: {
          baseline,
          fault: faultRun ? { ...phase(faultRun), execution: faultExecution, cpuPercent: cpu.fault } : null,
        },
        cleanup: { status: "pending", detail: "The CPU quota is still applied. Cleanup has not been verified." },
        limitations: context.limitations,
        measurementErrors,
      });
      if (before) {
        const restored = await deps.docker.restoreCpu(name, before, expect);
        container.after = restored.after || null;
        cleanup = {
          status: restored.ok ? "restored" : "failed",
          detail: restored.detail,
        };
      }
      if (signal?.aborted) {
        cancelled = true;
      } else {
        recoveryRun = await probe(config, config.recoveryMs, deps);
        measurementErrors.push(...recoveryRun.measurementErrors);
        cpu.recovery = await sampleCpu(deps.docker, name, measurementErrors, expect);
      }
    }
  } catch (error) {
    failure = error.message || "Experiment failed.";
  } finally {
    if (typeof deps.docker.stopCpuWorkload === "function") {
      try {
        const stopped = await deps.docker.stopCpuWorkload(name, expect);
        container.workload = {
          ...container.workload,
          stopped: stopped?.ok === true,
          stopDetail: stopped?.detail || "CPU workload stop did not report a result.",
        };
      } catch {
        container.workload = {
          ...container.workload,
          stopped: false,
          stopDetail: "CPU workload stop threw before it finished.",
        };
      }
    }
    if (before && cleanup.status !== "restored") {
      try {
        const restored = await deps.docker.restoreCpu(name, before, expect);
        container.after = restored.after || container.after || null;
        cleanup = {
          status: restored.ok ? "restored" : "failed",
          detail: restored.detail,
        };
      } catch {
        cleanup = { status: "failed", detail: "Cleanup could not restore the CPU quota." };
      }
    }
    if (cleanup.status === "restored" || cleanup.status === "not_required") faultLease.clearLease();
  }

  if (failure) return errorResult(config, failure, now, { baseline, cleanup });
  if (cancelled || signal?.aborted) {
    return cancelledResult(config, now, cleanup.status, { baseline, cleanup });
  }

  const phases = {
    baseline,
    fault: faultRun ? { ...phase(faultRun), execution: faultExecution, cpuPercent: cpu.fault } : null,
    recovery: recoveryRun ? { ...phase(recoveryRun), cpuPercent: cpu.recovery } : null,
  };
  context.limitations.push(
    "A pass means the CPU quota was verified by inspect, the workload was observed, cleanup restored the quota, and the recovery error rate stayed within its threshold. It does not treat one CPU sample or one p95 window as a confirmed effect.",
    "Probe req/s is the rate of completed probes at the configured send rate. It is not a measurement of service capacity.",
    "Each CPU figure is one docker stats sample, not an average or a significance test.",
    "p95 is reported separately from verified CPU throttling. One comparison is not a consistent latency effect.",
  );
  const cpuComparison = compareCpuPhases({
    baseline: phases.baseline?.metrics,
    fault: phases.fault?.metrics,
    recovery: phases.recovery?.metrics,
    cpu,
  });
  container.baselineCpuPercent = cpu.baseline;
  container.duringCpuPercent = cpu.fault;
  container.recoveryCpuPercent = cpu.recovery;
  container.cpuComparison = cpuComparison;
  const assertions = evaluateMeasured({
    faultType: "cpu",
    phases,
    container,
    cleanup,
    thresholds: config.thresholds,
  });
  const verdict = verdictFrom(assertions, "RUNNING");
  return {
    status: verdict,
    verdict,
    cleanupStatus: cleanup.status,
    error: null,
    finishedAt: new Date(now()).toISOString(),
    evidence: {
      mode: "measured",
      provenance: "observed",
      targetService: config.targetService,
      faultType: "cpu",
      hypothesis: config.hypothesis,
      probeUrl: config.probeUrl,
      parameters: {
        baselineMs: config.baselineMs,
        faultDurationMs: config.faultDurationMs,
        recoveryMs: config.recoveryMs,
        ratePerSecond: config.ratePerSecond,
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        thresholds: config.thresholds,
      },
      declaredDependents: context.dependents,
      observedImpact: cpuComparison.summary,
      container,
      phases,
      cpuComparison,
      assertions,
      cleanup,
      limitations: context.limitations,
      measurementErrors: [...new Set(measurementErrors)].slice(0, 8),
    },
  };
}

async function restoreStopped(config, deps, cleanup) {
  if (config.faultType !== "stop") return cleanup;
  try {
    const target = verifiedTarget(config);
    const started = await deps.docker.start(target.id, dockerExpect(target));
    if (started?.ok !== false) faultLease.clearLease();
    return { status: "restored", detail: "Cleanup started the container after an error." };
  } catch {
    return { status: "failed", detail: "Cleanup could not start the container after an error." };
  }
}

async function observeSandbox(config, durationMs, deps) {
  const target = verifiedTarget(config);
  if (!probeEndpoint(config.targetService) || !target) {
    const stamp = new Date().toISOString();
    return {
      startedAt: stamp,
      finishedAt: stamp,
      windowMs: 0,
      observations: [],
      measurementErrors: ["This sandbox service has no approved HTTP health endpoint. HTTP metrics are unavailable."],
    };
  }
  return (deps.runSandboxProbe || runSandboxProbe)({
    projectName: target.projectName,
    service: config.targetService,
    durationMs,
    ratePerSecond: config.ratePerSecond,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    signal: deps.signal,
  });
}

async function probe(config, durationMs, deps) {
  if (deps.sandboxProbe === true) return observeSandbox(config, durationMs, deps);
  const run = await runWorkload({
    url: config.fetchUrl || config.probeUrl,
    durationMs,
    ratePerSecond: config.ratePerSecond,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    now: deps.now,
    signal: deps.signal,
  });
  return run;
}

const WARMUP_LIMIT = "One warmup request is sent before each timed window and is not counted as a sample.";

function includeWarmup(limitations, phases) {
  if (!Array.isArray(limitations) || !phases) return;
  const warmed = Object.values(phases).some((item) => item && item.warmupExcluded);
  if (warmed && !limitations.includes(WARMUP_LIMIT)) limitations.push(WARMUP_LIMIT);
}

function phase(run) {
  return {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    windowMs: run.windowMs,
    metrics: summarizeHttp(run.observations, run.windowMs),
    samples: (run.observations || []).slice(0, 200),
    warmupExcluded: run.warmupExcluded === 1 ? 1 : 0,
  };
}

function impactText(faultType, phases) {
  if (faultType === "measure") {
    const rate = phases.baseline?.metrics?.errorRatePercent;
    return rate == null
      ? "Baseline measurements were not available."
      : `Baseline error rate was ${rate}%.`;
  }
  const before = phases.baseline?.metrics?.errorRatePercent;
  const during = phases.fault?.metrics?.errorRatePercent;
  if (before == null || during == null) return "Fault-window measurements were incomplete.";
  return `Probe error rate moved from ${before}% to ${during}% during the ${faultType} window.`;
}

function errorResult(config, message, now, extra = {}) {
  return {
    status: "ERROR",
    verdict: "ERROR",
    cleanupStatus: extra.cleanup?.status || "not_required",
    error: message,
    finishedAt: new Date(now()).toISOString(),
    evidence: {
      mode: "measured",
      provenance: extra.provenance || "observed",
      targetService: config.targetService,
      faultType: config.faultType,
      hypothesis: config.hypothesis,
      declaredDependents: declaredDependents(config.edges, config.targetService),
      phases: { baseline: extra.baseline || null, fault: null, recovery: null },
      assertions: [],
      limitations: [message],
      measurementErrors: [],
      cleanup: extra.cleanup || { status: "not_required", detail: "No container change was made." },
    },
  };
}

function cancelledResult(config, now, cleanupStatus, extra = {}) {
  return {
    status: "CANCELLED",
    verdict: "CANCELLED",
    cleanupStatus,
    error: "Cancelled.",
    finishedAt: new Date(now()).toISOString(),
    evidence: {
      mode: "measured",
      provenance: "observed",
      targetService: config.targetService,
      faultType: config.faultType,
      phases: {
        baseline: extra.baseline || null,
        fault: extra.fault || null,
        recovery: extra.recovery || null,
      },
      cleanup: extra.cleanup || {
        status: cleanupStatus,
        detail: "Cancellation happened before a container change.",
      },
      assertions: [],
      limitations: ["The experiment was cancelled before it finished."],
      measurementErrors: [],
    },
  };
}

module.exports = {
  validateExperiment,
  executeExperiment,
  resolveSandboxTarget,
  MEASURE_LIMIT,
  parseProbeUrl,
  probeAllowlist,
};
