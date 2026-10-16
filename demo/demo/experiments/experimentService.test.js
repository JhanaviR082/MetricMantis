const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const dbPath = path.join(os.tmpdir(), `metricmantis-experiments-${process.pid}.db`);
process.env.METRICMANTIS_DB_PATH = dbPath;

const { initDatabase } = require("../database/database");
const repository = require("../database/experimentRepository");
const userRepository = require("../database/userRepository");
const { runWorkload } = require("./workload");
const { validateExperiment, executeExperiment } = require("./experimentService");
const { createDockerExecutor } = require("./dockerExecutor");

function resetDb() {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
  initDatabase();
}

function user(username) {
  return userRepository.createUser({
    username,
    email: `${username}@example.com`,
    passwordHash: "hash",
  });
}

function dockerDisabled() {
  return {
    calls: [],
    async capabilities() {
      return {
        dockerAvailable: true,
        chaosEnabled: false,
        allowlist: [],
        networkFaultReason: "Latency and packet loss need Linux traffic control. This host is darwin, so those faults were not applied.",
      };
    },
    async stop() { this.calls.push("stop"); return { ok: true }; },
    async start() { this.calls.push("start"); return { ok: true }; },
    async inspect() { return { ok: true, status: "running" }; },
  };
}

test("validation rejects bad targets, MetricMantis ports, and unknown faults", () => {
  assert.equal(validateExperiment({ mode: "measured", faultType: "stop", targetService: "api;rm", probeUrl: "http://127.0.0.1:8080" }).error.includes("targetService"), true);
  assert.equal(validateExperiment({ mode: "measured", faultType: "measure", targetService: "api", probeUrl: "http://127.0.0.1:3001/health" }).error.includes("3001"), true);
  assert.equal(validateExperiment({ mode: "measured", faultType: "measure", targetService: "api", probeUrl: "http://evil.example/health" }).error.includes("ALLOWLIST"), true);
  assert.equal(validateExperiment({ mode: "nope", faultType: "measure", targetService: "api" }).error.includes("mode"), true);
});

test("workload records statuses, timeouts, and stops when cancelled", async () => {
  let calls = 0;
  const controller = new AbortController();
  const run = await runWorkload({
    url: "http://127.0.0.1:9/health",
    durationMs: 40,
    ratePerSecond: 50,
    concurrency: 2,
    timeoutMs: 20,
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 2) controller.abort();
      if (options.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return { status: calls === 1 ? 200 : 503 };
    },
  });
  assert.equal(run.observations[0].ok, true);
  assert.equal(run.observations.some((sample) => sample.status === 503), false);
});

test("measure only probes the sandbox service and does not call the host URL", async () => {
  let called = false;
  const probes = [];
  const result = await executeExperiment({
    mode: "measured",
    faultType: "measure",
    targetService: "api",
    hypothesis: "The health endpoint stays available.",
    edges: [{ from: "web-app", to: "api" }],
    probeUrl: "http://127.0.0.1:8080/health",
    baselineMs: 250,
    faultDurationMs: 250,
    recoveryMs: 250,
    ratePerSecond: 5,
    concurrency: 1,
    timeoutMs: 200,
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
    verifiedContainer: {
      id: "a".repeat(64),
      projectName: "mm0123456789abcdef",
      service: "api",
    },
  }, {
    fetchImpl: async () => { called = true; return { status: 204 }; },
    docker: dockerDisabled(),
    runSandboxProbe: async (options) => {
      probes.push(options);
      return {
        startedAt: "2026-10-15T00:00:00.000Z",
        finishedAt: "2026-10-15T00:00:00.250Z",
        windowMs: 250,
        observations: Array.from({ length: 5 }, (_item, index) => ({
          at: "2026-10-15T00:00:00.000Z",
          status: 200,
          latencyMs: 10 + index,
          ok: true,
        })),
        measurementErrors: [],
      };
    },
  });
  assert.equal(called, false);
  assert.equal(probes.length, 3);
  assert.deepEqual(probes.map((item) => item.service), ["api", "api", "api"]);
  assert.equal(probes.every((item) => item.projectName === "mm0123456789abcdef"), true);
  assert.equal(result.evidence.provenance, "observed");
  assert.equal(result.evidence.probeUrl, "http://api:8080/health");
  assert.equal(result.evidence.phases.baseline.metrics.totalRequests, 5);
  assert.equal(result.evidence.phases.baseline.metrics.latencyMs.p95, 14);
  assert.equal(result.evidence.phases.baseline.metrics.latencyMs.p99, null);
  assert.equal(result.evidence.phases.fault.execution.attempted, false);
  assert.equal(result.evidence.phases.recovery.metrics.errorRatePercent, 0);
  assert.match(result.evidence.limitations.join(" "), /No fault was injected/);
  assert.equal(result.verdict, "PASSED");

  let probed = false;
  const blocked = await executeExperiment({
    mode: "measured",
    faultType: "measure",
    targetService: "db",
    hypothesis: "",
    edges: [],
    probeUrl: "http://127.0.0.1:8080/health",
    baselineMs: 200,
    faultDurationMs: 200,
    recoveryMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
    verifiedContainer: {
      id: "b".repeat(64),
      projectName: "mm0123456789abcdef",
      service: "db",
    },
  }, {
    fetchImpl: async () => { throw new Error("host probe"); },
    docker: dockerDisabled(),
    runSandboxProbe: async () => { probed = true; return { observations: [] }; },
  });
  assert.equal(probed, false);
  assert.match(blocked.error, /no approved HTTP health endpoint/);
});

test("disabled chaos does not call docker and reports the reason", async () => {
  const docker = dockerDisabled();
  const result = await executeExperiment({
    mode: "measured",
    faultType: "stop",
    targetService: "api",
    hypothesis: "",
    edges: [],
    probeUrl: "http://127.0.0.1:8080/health",
    baselineMs: 200,
    faultDurationMs: 200,
    recoveryMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  }, { fetchImpl: async () => ({ status: 200 }), docker });
  assert.equal(result.status, "ERROR");
  assert.equal(result.evidence.limitations[0].includes("METRICMANTIS_CHAOS_ENABLED"), true);
  assert.deepEqual(docker.calls, []);
});

test("latency is reported unsupported and is not applied", async () => {
  const docker = dockerDisabled();
  const result = await executeExperiment({
    mode: "measured",
    faultType: "latency",
    targetService: "api",
    hypothesis: "",
    edges: [],
    probeUrl: "http://127.0.0.1:8080/health",
    baselineMs: 200,
    faultDurationMs: 200,
    recoveryMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
  }, { fetchImpl: async () => { throw new Error("should not probe"); }, docker });
  assert.equal(result.status, "ERROR");
  assert.match(result.error, /Real chaos is disabled/);
  assert.equal(docker.calls.length, 0);
});

test("memory pressure is verified from the file size and removed afterward", async () => {
  const calls = [];
  let present = false;
  const result = await executeExperiment({
    mode: "measured",
    faultType: "memory",
    targetService: "api",
    hypothesis: "Memory rises while the file is present.",
    edges: [],
    probeUrl: "http://127.0.0.1:8080/health",
    baselineMs: 200,
    faultDurationMs: 200,
    recoveryMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    memoryMib: 8,
    thresholds: { maxErrorRatePercent: 100, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
    verifiedContainer: {
      id: "c".repeat(64),
      projectName: "mm0123456789abcdef",
      service: "api",
    },
  }, {
    sandboxProbe: true,
    fetchImpl: async () => { throw new Error("host probe"); },
    runSandboxProbe: async () => ({
      startedAt: "2026-10-15T00:00:00.000Z",
      finishedAt: "2026-10-15T00:00:00.200Z",
      windowMs: 200,
      warmupExcluded: 1,
      observations: [{ at: "2026-10-15T00:00:00.000Z", status: 200, latencyMs: 10, ok: true }],
      measurementErrors: [],
    }),
    docker: {
      async capabilities() {
        return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"], memory: true, latency: true, packetLoss: true };
      },
      async stats() {
        calls.push("stats");
        return { ok: true, cpuPercent: 1, memoryBytes: present ? 20_000_000 : 10_000_000 };
      },
      async applyMemory(_id, _expected, mib) {
        calls.push(`memory:${mib}`);
        present = true;
        return { ok: true, verified: true, bytes: 8 * 1024 * 1024, detail: "file present" };
      },
      async clearMemory() {
        calls.push("clear-memory");
        present = false;
        return { ok: true, detail: "removed" };
      },
    },
  });
  assert.deepEqual(calls.filter((call) => call.startsWith("memory") || call === "clear-memory"), ["memory:8", "clear-memory"]);
  assert.equal(result.evidence.phases.fault.execution.verified, true);
  assert.equal(result.evidence.phases.fault.memoryBytes, 20_000_000);
  assert.equal(result.evidence.phases.baseline.memoryBytes, 10_000_000);
  assert.equal(result.evidence.cleanup.status, "restored");
  assert.equal(present, false);
  assert.match(result.evidence.limitations.join(" "), /not counted as a sample/);
});

test("packet loss uses the sandbox probe and does not call the host URL", async () => {
  let fetched = false;
  const calls = [];
  const result = await executeExperiment({
    mode: "measured",
    faultType: "packet_loss",
    targetService: "web-app",
    hypothesis: "",
    edges: [],
    baselineMs: 200,
    faultDurationMs: 200,
    recoveryMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    lossPercent: 5,
    thresholds: { maxErrorRatePercent: 100, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
    verifiedContainer: {
      id: "d".repeat(64),
      projectName: "mm0123456789abcdef",
      service: "web-app",
    },
  }, {
    sandboxProbe: true,
    fetchImpl: async () => { fetched = true; return { status: 200 }; },
    runSandboxProbe: async () => ({
      windowMs: 200,
      observations: [],
      measurementErrors: [],
    }),
    docker: {
      async capabilities() {
        return { dockerAvailable: true, chaosEnabled: true, allowlist: ["web-app"] };
      },
      async stats() { return { ok: false, detail: "no stats" }; },
      async applyNetem(_id, _expected, spec) {
        calls.push(spec);
        return { ok: true, verified: true, sidecarId: "e".repeat(64), detail: "loss 5%" };
      },
      async clearNetem() {
        calls.push("clear");
        return { ok: true, detail: "cleared" };
      },
    },
  });
  assert.equal(fetched, false);
  assert.deepEqual(calls[0], { lossPercent: 5 });
  assert.equal(calls.at(-1), "clear");
  assert.equal(result.evidence.phases.fault.execution.verified, true);
  assert.equal(result.evidence.phases.baseline.metrics.errorRatePercent, null);
  assert.equal(result.verdict, "INCONCLUSIVE");
});

test("an approved stop is verified, measured, and cleaned up", async () => {
  const state = { status: "running" };
  const docker = {
    calls: [],
    async capabilities() {
      return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] };
    },
    async inspect(id) {
      assert.equal(id, "b".repeat(64));
      return { ok: true, status: state.status, restartCount: 0 };
    },
    async stop(id) {
      assert.equal(id, "b".repeat(64));
      state.status = "exited";
      this.calls.push("stop");
      return { ok: true, detail: "stopped" };
    },
    async start(id) {
      assert.equal(id, "b".repeat(64));
      state.status = "running";
      this.calls.push("start");
      return { ok: true, detail: "started" };
    },
  };
  const result = await executeExperiment({
    mode: "measured",
    faultType: "stop",
    targetService: "api",
    hypothesis: "Stopping api increases errors.",
    edges: [{ from: "web", to: "api" }],
    probeUrl: "http://127.0.0.1:8080/health",
    baselineMs: 80,
    faultDurationMs: 80,
    recoveryMs: 80,
    ratePerSecond: 50,
    concurrency: 1,
    timeoutMs: 20,
    thresholds: { maxErrorRatePercent: 1, maxP95Ms: 500, recoveryTimeoutMs: 5000 },
    verifiedContainer: {
      id: "b".repeat(64),
      projectName: "mm0123456789abcdef",
      service: "api",
    },
  }, {
    docker,
    fetchImpl: async () => ({ status: state.status === "running" ? 200 : 500 }),
  });
  assert.deepEqual(docker.calls, ["stop", "start"]);
  assert.equal(result.evidence.phases.fault.execution.verified, true);
  assert.equal(result.evidence.cleanup.status, "restored");
  assert.equal(result.verdict, "PASSED");
  assert.equal(result.evidence.phases.fault.metrics.errorRatePercent > result.evidence.phases.baseline.metrics.errorRatePercent, true);
});

test("simulation stores a predicted result and does not measure", async () => {
  const result = await executeExperiment({
    mode: "simulation",
    faultType: "cpu",
    targetService: "db",
    hypothesis: "",
    edges: [{ from: "api", to: "db" }],
  }, { fetchImpl: async () => { throw new Error("no probe"); }, docker: dockerDisabled() });
  assert.equal(result.verdict, "INCONCLUSIVE");
  assert.equal(result.evidence.provenance, "predicted");
  assert.equal(result.evidence.phases.baseline, null);
});

test("experiment rows are isolated by user", () => {
  resetDb();
  const ada = user("adaexp");
  const bea = user("beaexp");
  const saved = repository.createExperiment({
    id: "exp-1",
    userId: ada.id,
    name: "measure",
    hypothesis: "steady",
    targetService: "api",
    faultType: "measure",
    mode: "measured",
    config: { mode: "measured" },
    createdAt: new Date().toISOString(),
  });
  repository.finishExperiment("exp-1", ada.id, {
    status: "PASSED",
    verdict: "PASSED",
    evidence: { provenance: "observed" },
    error: null,
    cleanupStatus: "not_required",
    finishedAt: new Date().toISOString(),
  });
  assert.equal(repository.getExperiment("exp-1", bea.id), null);
  assert.equal(repository.listExperiments(bea.id).length, 0);
  assert.equal(saved.userId, ada.id);
  assert.equal(repository.getExperiment("exp-1", ada.id).verdict, "PASSED");
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
});

function measuredConfig(faultType) {
  return {
    mode: "measured",
    faultType,
    targetService: "api",
    hypothesis: "",
    edges: [],
    probeUrl: "http://127.0.0.1:8080/health",
    fetchUrl: "http://127.0.0.1:8080/health",
    baselineMs: 40,
    faultDurationMs: 40,
    recoveryMs: 40,
    ratePerSecond: 40,
    concurrency: 1,
    timeoutMs: 30,
    thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
    verifiedContainer: {
      id: "a".repeat(64),
      projectName: "mm0123456789abcdef",
      service: "api",
    },
  };
}

test("redirects are not followed and count as failed probes", async () => {
  let followed = false;
  const result = await executeExperiment(measuredConfig("stop"), {
    docker: {
      async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
      async inspect() { return { ok: true, status: "exited", restartCount: 0, startedAt: "2026-10-14T08:00:00.000000000Z" }; },
      async stop() { return { ok: true, detail: "stopped" }; },
      async start() { return { ok: true, detail: "started" }; },
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      if (init.signal?.aborted) followed = true;
      return { status: 302 };
    },
  });
  assert.equal(followed, false);
  assert.equal(result.evidence.phases.baseline.metrics.errorRatePercent, 100);
  assert.equal(result.verdict, "FAILED");
});

test("restart is verified from a newer start time, not from the docker command", async () => {
  const state = {
    status: "running",
    startedAt: "2026-10-14T08:00:00.000000000Z",
  };
  const docker = {
    calls: [],
    async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
    async inspect() { return { ok: true, status: state.status, startedAt: state.startedAt, restartCount: 0 }; },
    async restart() {
      this.calls.push("restart");
      state.startedAt = "2026-10-14T08:00:01.000000000Z";
      return { ok: true, detail: "docker restart completed." };
    },
  };
  const moved = await executeExperiment(measuredConfig("restart"), {
    docker,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(docker.calls.includes("restart"), true);
  assert.equal(moved.evidence.phases.fault.execution.verified, true);
  assert.equal(moved.verdict, "PASSED");

  const unchanged = {
    async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
    async inspect() { return { ok: true, status: "running", startedAt: "2026-10-14T08:00:00.000000000Z", restartCount: 0 }; },
    async restart() { return { ok: true, detail: "docker restart completed." }; },
  };
  const sameStart = await executeExperiment(measuredConfig("restart"), {
    docker: unchanged,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(sameStart.evidence.phases.fault.execution.verified, false);
  assert.equal(sameStart.verdict, "FAILED");
});

test("a db stop does not send an HTTP probe and restores that container after a failure", async () => {
  const faultLease = require("./faultLease");
  const id = "d".repeat(64);
  const calls = [];
  let probed = false;
  const state = { status: "running" };
  const docker = {
    async capabilities() {
      return { dockerAvailable: true, chaosEnabled: true, allowlist: ["web-app", "api", "db"] };
    },
    async inspect() { return { ok: true, status: state.status }; },
    async stop(name) {
      calls.push(["stop", name]);
      state.status = "exited";
      throw new Error("docker stop failed after the container exited");
    },
    async start(name) {
      calls.push(["start", name]);
      state.status = "running";
      return { ok: true, detail: "started" };
    },
  };
  try {
    const result = await executeExperiment({
      ...measuredConfig("stop"),
      targetService: "db",
      verifiedContainer: { id, projectName: "mm0123456789abcdef", service: "db" },
    }, {
      docker,
      sandboxProbe: true,
      runSandboxProbe: async () => {
        probed = true;
        return { observations: [], measurementErrors: [] };
      },
      fetchImpl: async () => { throw new Error("host fetch"); },
    });
    assert.equal(probed, false);
    assert.deepEqual(calls, [["stop", id], ["start", id]]);
    assert.equal(result.status, "ERROR");
    assert.equal(result.evidence.cleanup.status, "restored");
    assert.equal(calls.some((call) => call[1] !== id), false);
  } finally {
    faultLease.clearLease();
  }
});

test("a stop that leaves the container running is not a pass, and a failed inspect still cleans up", async () => {
  const stillUp = {
    calls: [],
    async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
    async inspect() { return { ok: true, status: "running", restartCount: 1 }; },
    async stop() { this.calls.push("stop"); return { ok: true, detail: "command ok" }; },
    async start() { this.calls.push("start"); return { ok: true, detail: "started" }; },
  };
  const unchanged = await executeExperiment(measuredConfig("stop"), {
    docker: stillUp,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(unchanged.evidence.phases.fault.execution.verified, false);
  assert.equal(unchanged.verdict, "FAILED");
  assert.equal(stillUp.calls.includes("start"), false);

  const state = { status: "running" };
  let inspections = 0;
  const blind = {
    calls: [],
    async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
    async inspect() {
      inspections += 1;
      if (inspections === 2) return { ok: false, detail: "inspect failed" };
      return { ok: true, status: state.status, restartCount: 1 };
    },
    async stop() { state.status = "exited"; this.calls.push("stop"); return { ok: true, detail: "stopped" }; },
    async start() { state.status = "running"; this.calls.push("start"); return { ok: true, detail: "started" }; },
  };
  await executeExperiment(measuredConfig("stop"), {
    docker: blind,
    fetchImpl: async () => ({ status: state.status === "running" ? 200 : 500 }),
  });
  assert.deepEqual(blind.calls, ["stop", "start"]);
});

test("a CPU update is not verified unless inspect shows the new quota", async () => {
  const docker = {
    calls: [],
    async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
    async inspect() { return { ok: true, status: "running", cpuQuota: 0, cpuPeriod: 100000, restartCount: 0 }; },
    async startCpuWorkload() { this.calls.push("workload"); return { ok: true, detail: "running" }; },
    async stopCpuWorkload() { this.calls.push("workload-stop"); return { ok: true, detail: "stopped" }; },
    async constrainCpu() { this.calls.push("update"); return { ok: true, before: { cpuQuota: 0, cpuPeriod: 100000 }, detail: "updated" }; },
    async stats() { return { ok: true, cpuPercent: 1 }; },
    async restoreCpu() { this.calls.push("restore"); return { ok: true, detail: "restored" }; },
  };
  const result = await executeExperiment(measuredConfig("cpu"), {
    docker,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(result.evidence.phases.fault.execution.verified, false);
  assert.equal(result.verdict, "FAILED");
  assert.deepEqual(docker.calls, ["workload", "update", "restore", "workload-stop"]);
});

test("a NanoCPUs limit is reported from inspect instead of a quota that stayed zero", async () => {
  const docker = {
    async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
    async inspect() {
      return { ok: true, status: "running", cpuQuota: 0, cpuPeriod: 0, nanoCpus: 50_000_000 };
    },
    async startCpuWorkload() { return { ok: true, detail: "running" }; },
    async stopCpuWorkload() { return { ok: true, detail: "stopped" }; },
    async constrainCpu() {
      return { ok: true, before: { nanoCpus: 500_000_000, cpuQuota: 0, cpuPeriod: 0 }, detail: "updated" };
    },
    async stats() { return { ok: true, cpuPercent: 1 }; },
    async restoreCpu() { return { ok: true, after: { ok: true, nanoCpus: 500_000_000 }, detail: "restored" }; },
  };
  const result = await executeExperiment(measuredConfig("cpu"), {
    docker,
    fetchImpl: async () => ({ status: 200 }),
  });
  const execution = result.evidence.phases.fault.execution;
  assert.equal(execution.verified, true);
  assert.equal(execution.observed, "nanoCpus 50000000");
  assert.match(execution.detail, /NanoCpus 50000000/);
  assert.doesNotMatch(execution.detail, /quota was 5000/);
});

test("CPU restore uses unlimited quota -1 and checks inspect", async () => {
  const env = { METRICMANTIS_CHAOS_ENABLED: "true", METRICMANTIS_CHAOS_ALLOWLIST: "api" };
  let quota = 5000;
  let applyUpdate = true;
  const calls = [];
  const docker = createDockerExecutor({
    env,
    async execFileImpl(_command, args) {
      calls.push(args.join(" "));
      if (args[0] === "inspect") {
        return { ok: true, stdout: `running 0 ${quota} 100000 2026-10-14T08:00:00.000000000Z` };
      }
      if (args[0] === "update" && applyUpdate && args.includes("-1")) quota = -1;
      return { ok: true, stdout: "api" };
    },
  });
  const restored = await docker.restoreCpu("api", { cpuQuota: 0, cpuPeriod: 0 });
  assert.equal(calls.some((args) => args.includes("--cpu-quota -1")), true);
  assert.equal(restored.ok, true);
  assert.equal(restored.after.cpuQuota, -1);

  applyUpdate = false;
  quota = 5000;
  const stuck = await docker.restoreCpu("api", { cpuQuota: 0, cpuPeriod: 0 });
  assert.equal(stuck.ok, false);
});

test("cpu workload uses a fixed command and stops only the observed process", async () => {
  const env = { METRICMANTIS_CHAOS_ENABLED: "true", METRICMANTIS_CHAOS_ALLOWLIST: "box" };
  const calls = [];
  let running = false;
  const docker = createDockerExecutor({
    env,
    async execFileImpl(_command, args) {
      calls.push(args);
      if (args[0] === "exec" && args[1] === "-d") {
        running = true;
        return { ok: true, stdout: "" };
      }
      if (args[0] === "top") {
        return {
          ok: true,
          stdout: running
            ? "PID COMMAND\n44 timeout 8 dd if=/dev/zero of=/dev/null bs=1M\nnot-a-pid rm -rf /\n"
            : "PID COMMAND\n",
        };
      }
      if (args[0] === "exec" && args[2] === "/bin/sh" && String(args[4]).includes("mm-cpu-burn.pid")) {
        assert.equal(args[4].includes("not-a-pid"), false);
        assert.equal(args[4].includes("44"), false);
        running = false;
        return { ok: true, stdout: "" };
      }
      return { ok: false, stderr: "unexpected" };
    },
  });
  const blocked = await docker.startCpuWorkload("other", 8000);
  assert.equal(blocked.ok, false);
  assert.equal(calls.length, 0);

  const started = await docker.startCpuWorkload("box", 8000);
  assert.equal(started.ok, true);
  assert.deepEqual(calls[0].slice(0, 5), ["exec", "-d", "box", "/bin/sh", "-c"]);
  assert.equal(calls[0][5], "echo $$ >/tmp/mm-cpu-burn.pid; exec timeout 8 dd if=/dev/zero of=/dev/null bs=1M");
  const stopped = await docker.stopCpuWorkload("box");
  assert.equal(stopped.ok, true);
  assert.equal(running, false);

  const unconfirmed = createDockerExecutor({
    env,
    async execFileImpl(_command, args) {
      if (args[0] === "top") return { ok: false, stderr: "top failed" };
      return { ok: true, stdout: "" };
    },
  });
  const missed = await unconfirmed.stopCpuWorkload("box");
  assert.equal(missed.ok, false);
  assert.match(missed.detail, /could not confirm/);
});

test("cpu cleanup retries restore and still stops the workload", async () => {
  const calls = [];
  let quota = 0;
  const docker = {
    async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
    async startCpuWorkload() { calls.push("workload"); return { ok: true, detail: "running" }; },
    async stopCpuWorkload() { calls.push("workload-stop"); return { ok: true, detail: "stopped" }; },
    async constrainCpu() {
      calls.push("limit");
      quota = 5000;
      return { ok: true, before: { cpuQuota: 0, cpuPeriod: 0 }, detail: "updated" };
    },
    async inspect() { return { ok: true, status: "running", cpuQuota: quota }; },
    async stats() { return { ok: false, detail: "stats failed" }; },
    async restoreCpu() {
      calls.push("restore");
      return { ok: false, after: { ok: true, cpuQuota: 5000 }, detail: "docker inspect did not show the previous CPU quota." };
    },
  };
  const result = await executeExperiment(measuredConfig("cpu"), {
    docker,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(calls.filter((call) => call === "restore").length, 2);
  assert.equal(calls.includes("workload-stop"), true);
  assert.equal(result.evidence.cleanup.status, "failed");
  assert.equal(result.evidence.phases.baseline.cpuPercent, null);
  assert.equal(result.evidence.cpuComparison.baseline.cpuPercent, null);
  assert.equal(result.verdict, "FAILED");
  assert.equal(JSON.stringify(result.evidence).includes("\"cpuPercent\":0"), false);
});

test("cpu comparison records impact and recovery from measured samples", () => {
  const { compareCpuPhases } = require("./cpuComparison");
  const comparison = compareCpuPhases({
    baseline: metricsBundle(0, 10, 20, 5),
    fault: metricsBundle(0, 2, 90, 40),
    recovery: metricsBundle(0, 4, 25, 12),
    cpu: { baseline: 95, fault: 5, recovery: 90 },
  });
  assert.equal(comparison.faultVersusBaseline.latencyIncreased, true);
  assert.equal(comparison.faultVersusBaseline.probeCompletionDecreased, true);
  assert.equal(comparison.faultVersusBaseline.cpuDecreased, true);
  assert.equal(comparison.recoveryVersusFault.latencyDecreased, true);
  assert.equal(comparison.recoveryVersusFault.cpuIncreased, true);
  assert.equal(comparison.summary.includes("probe completion"), true);
  assert.equal(comparison.summary.includes("Verified CPU throttling is the docker inspect quota result"), true);
  assert.equal(comparison.summary.includes("not a consistent latency effect"), true);
  assert.equal(comparison.summary.includes("not service capacity"), true);
  assert.equal(comparison.summary.includes("not a significance test"), true);
  assert.equal(comparison.summary.includes("CPU 95%"), true);
  assert.equal(comparison.summary.includes("CPU 5%"), true);
  const small = compareCpuPhases({
    baseline: metricsBundle(0, 5, 20, 10),
    fault: metricsBundle(0, 5, 22, 11),
    recovery: metricsBundle(0, 5, 21, 10),
    cpu: { baseline: 90, fault: 80, recovery: 88 },
  });
  assert.equal(small.faultVersusBaseline.latencyIncreased, null);
  assert.equal(small.faultVersusBaseline.cpuDecreased, null);
  assert.equal(small.faultVersusBaseline.probeCompletionDecreased, false);

  const missing = compareCpuPhases({
    baseline: { totalRequests: 0, errorRatePercent: null, requestsPerSecond: null, latencyMs: {} },
    fault: { totalRequests: 0, errorRatePercent: null, requestsPerSecond: null, latencyMs: {} },
    recovery: null,
    cpu: { baseline: null, fault: null, recovery: null },
  });
  assert.equal(missing.baseline.p95, null);
  assert.equal(missing.baseline.cpuPercent, null);
  assert.equal(missing.summary.includes("unavailable"), true);
  assert.equal(missing.summary.includes("CPU 0%"), false);
});

test("cpu edge cases keep workload, probe, sample, and cancellation results separate", async () => {
  function dockerWith({ workloadOk = true, statsOk = true } = {}) {
    const calls = [];
    const state = { limited: false };
    return {
      calls,
      state,
      async capabilities() { return { dockerAvailable: true, chaosEnabled: true, allowlist: ["api"] }; },
      async startCpuWorkload() {
        calls.push("workload");
        return { ok: workloadOk, detail: workloadOk ? "running" : "The CPU workload process was not observed." };
      },
      async stopCpuWorkload() { calls.push("workload-stop"); return { ok: true, detail: "stopped" }; },
      async constrainCpu() {
        calls.push("limit");
        state.limited = true;
        return { ok: true, before: { cpuQuota: 0, cpuPeriod: 0 }, detail: "updated" };
      },
      async inspect() {
        return { ok: true, status: "running", cpuQuota: state.limited ? 5000 : 0, cpuPeriod: 100000 };
      },
      async stats() {
        return statsOk
          ? { ok: true, cpuPercent: state.limited ? 5 : 100 }
          : { ok: false, detail: "stats failed" };
      },
      async restoreCpu() {
        calls.push("restore");
        state.limited = false;
        return { ok: true, after: { ok: true, cpuQuota: -1 }, detail: "docker inspect showed CPU quota -1 after restore." };
      },
    };
  }

  const missedWorkload = dockerWith({ workloadOk: false });
  const missed = await executeExperiment(measuredConfig("cpu"), {
    docker: missedWorkload,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(missed.evidence.assertions.find((item) => item.id === "cpu_workload").result, "INCONCLUSIVE");
  assert.equal(missed.verdict, "INCONCLUSIVE");
  assert.equal(missedWorkload.calls.includes("restore"), true);
  assert.equal(missedWorkload.calls.includes("workload-stop"), true);
  assert.equal(missed.evidence.cpuComparison.summary.includes("not service capacity"), true);
  assert.equal(missed.evidence.cpuComparison.summary.includes("separate from latency"), true);

  const failingProbes = dockerWith();
  const failed = await executeExperiment(measuredConfig("cpu"), {
    docker: failingProbes,
    fetchImpl: async () => ({ status: 500 }),
  });
  assert.equal(failed.evidence.assertions.find((item) => item.id === "recovery_error_rate").result, "FAILED");
  assert.equal(failed.verdict, "FAILED");
  assert.equal(failed.evidence.cleanup.status, "restored");

  const missingStats = dockerWith({ statsOk: false });
  const missing = await executeExperiment(measuredConfig("cpu"), {
    docker: missingStats,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(missing.evidence.phases.baseline.cpuPercent, null);
  assert.equal(missing.evidence.assertions.find((item) => item.id === "cpu_sample").result, "INCONCLUSIVE");
  assert.equal(missing.verdict, "INCONCLUSIVE");
  assert.equal(JSON.stringify(missing.evidence).includes("\"cpuPercent\":0"), false);

  const earlyController = new AbortController();
  earlyController.abort();
  const earlyDocker = dockerWith();
  const early = await executeExperiment(measuredConfig("cpu"), {
    docker: earlyDocker,
    signal: earlyController.signal,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(early.verdict, "CANCELLED");
  assert.equal(early.cleanupStatus, "not_required");
  assert.deepEqual(earlyDocker.calls, []);

  const midController = new AbortController();
  const midDocker = dockerWith();
  const mid = await executeExperiment(measuredConfig("cpu"), {
    docker: midDocker,
    signal: midController.signal,
    fetchImpl: async () => {
      if (midDocker.state.limited) midController.abort();
      return { status: 200 };
    },
  });
  assert.equal(mid.verdict, "CANCELLED");
  assert.equal(midDocker.calls.includes("limit"), true);
  assert.equal(midDocker.calls.includes("restore"), true);
  assert.equal(midDocker.calls.includes("workload-stop"), true);
  assert.equal(mid.evidence.cleanup.status, "restored");
});

function metricsBundle(errorRatePercent, requestsPerSecond, p95, p50) {
  return {
    totalRequests: 10,
    errorRatePercent,
    requestsPerSecond,
    latencyMs: { p50, p95 },
  };
}
