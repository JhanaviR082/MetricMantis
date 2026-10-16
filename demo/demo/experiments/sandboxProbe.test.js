const assert = require("node:assert/strict");
const test = require("node:test");
const { summarizeHttp } = require("./metrics");
const { runProbe } = require("../sandboxes/sample/measurer/probe");
const { observeProject } = require("../sandboxes/sandboxRuntime");
const {
  composeRunArgs,
  parseProbeOutput,
  removeMeasurerContainers,
  runSandboxProbe,
} = require("./sandboxProbe");

const PROJECT = "mm0123456789abcdef";
const OTHER = "mmfedcba9876543210";
const MEASURER_ID = "d".repeat(64);
const API_ID = "a".repeat(64);

test("the probe command is project scoped and has no socket, host port, or user command", () => {
  const planned = composeRunArgs(PROJECT, {
    service: "api",
    durationMs: 2000,
    ratePerSecond: 5,
    concurrency: 1,
    timeoutMs: 1000,
  });
  const joined = planned.args.join(" ");
  assert.match(joined, new RegExp(`-p ${PROJECT}`));
  assert.match(joined, /approved-sample-compose.yml/);
  assert.match(joined, /MM_SERVICE=api/);
  assert.equal(joined.includes("docker.sock"), false);
  assert.equal(joined.includes("-p 80") || joined.includes("--publish"), false);
  assert.equal(joined.includes("127.0.0.1"), false);
  assert.equal(composeRunArgs(PROJECT, { service: "db", durationMs: 2000 }), null);
  assert.equal(composeRunArgs("project", { service: "api", durationMs: 2000 }), null);
  assert.equal(composeRunArgs(OTHER, { service: "api", durationMs: 200 }).args.includes("MM_SERVICE=api"), true);
});

test("probe timestamps, timeouts, cancellation, and metric math stay explicit", async () => {
  let clock = 0;
  let calls = 0;
  const result = await runProbe({
    service: "web-app",
    durationMs: 100,
    ratePerSecond: 20,
    concurrency: 1,
    timeoutMs: 20,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async (url) => {
      assert.equal(url, "http://web-app/health");
      calls += 1;
      if (calls === 1) return { status: 200 };
      if (calls >= 3) {
        const error = new Error("timeout");
        error.name = "AbortError";
        throw error;
      }
      return { status: 200 };
    },
  });
  assert.equal(result.observations.some((sample) => sample.ok), true);
  assert.equal(result.observations.some((sample) => sample.error === "timeout"), true);
  const summary = summarizeHttp(result.observations, result.windowMs);
  assert.equal(summary.totalRequests, result.observations.length);
  assert.equal(summary.successfulRequests + summary.failedRequests, summary.totalRequests);
  assert.equal(typeof summary.errorRatePercent, "number");
  assert.equal(summarizeHttp([], 0).requestsPerSecond, null);
  assert.equal(summarizeHttp([], 0).errorRatePercent, null);

  const controller = new AbortController();
  let fetches = 0;
  const cancelled = runProbe({
    service: "api",
    durationMs: 5000,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    sleep: async () => {},
    fetchImpl: async () => {
      fetches += 1;
      controller.abort();
      return { status: 200 };
    },
    signal: controller.signal,
  });
  const stopped = await cancelled;
  assert.equal(fetches <= 1, true);
  assert.equal(stopped.observations.length <= 1, true);

  const missing = await runProbe({ service: "db", durationMs: 200, ratePerSecond: 1, concurrency: 1, timeoutMs: 200 });
  assert.match(missing.error, /no approved HTTP health endpoint/);
});

test("a cold warmup is excluded so a two second window can record five successes", async () => {
  let clock = 0;
  let calls = 0;
  const result = await runProbe({
    service: "api",
    durationMs: 2000,
    ratePerSecond: 5,
    concurrency: 2,
    timeoutMs: 3000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        clock += 3400;
        return { status: 200 };
      }
      return { status: 200 };
    },
  });
  assert.equal(result.warmupExcluded, 1);
  assert.equal(calls > 1, true);
  assert.equal(result.observations.length >= 5, true);
  assert.equal(result.observations.every((sample) => sample.ok && sample.latencyMs < 500), true);
  const summary = summarizeHttp(result.observations, result.windowMs);
  assert.equal(summary.successfulRequests, result.observations.length);
  assert.equal(summary.latencyMs.p95 == null, false);
  const tooFew = summarizeHttp(result.observations.slice(0, 4), result.windowMs);
  assert.equal(tooFew.latencyMs.p95, null);
});

test("cancellation removes only a verified measurer in that project", async () => {
  const calls = [];
  let present = [MEASURER_ID, API_ID];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    if (args[0] === "ps") return { ok: true, stdout: present.join("\n"), stderr: "" };
    if (args[0] === "inspect" && args.at(-1) === MEASURER_ID) {
      return {
        ok: true,
        stdout: JSON.stringify({ id: MEASURER_ID, status: "running", health: "", project: PROJECT, service: "measurer" }),
        stderr: "",
      };
    }
    if (args[0] === "inspect") {
      return {
        ok: true,
        stdout: JSON.stringify({ id: args.at(-1), status: "running", health: "healthy", project: OTHER, service: "api" }),
        stderr: "",
      };
    }
    if (args[0] === "rm") {
      present = present.filter((id) => id !== args.at(-1));
      return { ok: true, stdout: args.at(-1), stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected" };
  };
  const removed = await removeMeasurerContainers(execFileImpl, PROJECT);
  assert.equal(removed.ok, true);
  assert.deepEqual(calls.filter((args) => args[0] === "rm"), [["rm", "-f", MEASURER_ID]]);
  assert.equal(present.includes(API_ID), true);
  assert.equal(calls.some((args) => args.includes("prune")), false);
});

test("a running measurer does not make the application project unexpected", async () => {
  const ids = [API_ID, "b".repeat(64), "c".repeat(64), MEASURER_ID];
  const rows = {
    [API_ID]: { status: "running", health: "healthy", project: PROJECT, service: "api" },
    [ids[1]]: { status: "running", health: "healthy", project: PROJECT, service: "db" },
    [ids[2]]: { status: "running", health: "healthy", project: PROJECT, service: "web-app" },
    [MEASURER_ID]: { status: "running", health: "", project: PROJECT, service: "measurer" },
  };
  const execFileImpl = async (_command, args) => {
    if (args[0] === "ps") return { ok: true, stdout: ids.join("\n"), stderr: "" };
    if (args[0] === "inspect") {
      const id = args.at(-1);
      return { ok: true, stdout: JSON.stringify({ id, ...rows[id] }), stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected" };
  };
  const observed = await observeProject(execFileImpl, PROJECT);
  assert.equal(observed.error, undefined);
  assert.equal(observed.ready, true);
  assert.equal(observed.services.measurer, undefined);
});

test("invalid project names and services never start a container", async () => {
  let calls = 0;
  const execFileImpl = async () => {
    calls += 1;
    return { ok: true, stdout: "", stderr: "" };
  };
  const badProject = await runSandboxProbe({
    projectName: "demo",
    service: "api",
    durationMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    execFileImpl,
  });
  const badService = await runSandboxProbe({
    projectName: PROJECT,
    service: "db",
    durationMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    execFileImpl,
  });
  assert.equal(calls, 0);
  assert.match(badProject.error, /Invalid sandbox project/);
  assert.match(badService.error, /no approved HTTP health endpoint/);
});

test("probe output parses timestamps and refuses a foreign command result", async () => {
  const parsed = parseProbeOutput([
    "noise",
    `MM_RESULT ${JSON.stringify({
      startedAt: "2026-10-15T00:00:00.000Z",
      finishedAt: "2026-10-15T00:00:01.000Z",
      windowMs: 1000,
      observations: [{ at: "2026-10-15T00:00:00.100Z", status: 200, latencyMs: 12, ok: true }],
      measurementErrors: [],
    })}`,
  ].join("\n"));
  assert.equal(parsed.observations[0].latencyMs, 12);
  assert.equal(parsed.windowMs, 1000);
  assert.equal(parsed.warmupExcluded, 0);
  const warmed = parseProbeOutput(`MM_RESULT ${JSON.stringify({
    windowMs: 1000,
    warmupExcluded: 1,
    observations: [{ at: "2026-10-15T00:00:00.100Z", status: 200, latencyMs: 12, ok: true }],
  })}`);
  assert.equal(warmed.warmupExcluded, 1);
  const summary = summarizeHttp(parsed.observations, parsed.windowMs);
  assert.equal(summary.totalRequests, 1);
  assert.equal(summary.latencyMs.p95, null);

  const aborted = new AbortController();
  aborted.abort();
  const calls = [];
  const result = await runSandboxProbe({
    projectName: PROJECT,
    service: "api",
    durationMs: 200,
    ratePerSecond: 1,
    concurrency: 1,
    timeoutMs: 200,
    signal: aborted.signal,
    execFileImpl: async (_command, args) => {
      calls.push(args);
      return { ok: true, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.aborted, true);
  assert.equal(calls.length, 0);
});
