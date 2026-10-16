const assert = require("node:assert/strict");
const test = require("node:test");
const { createDockerExecutor, chaosStatusFromEnv } = require("../experiments/dockerExecutor");
const { API_DIR, classifyListener, decideStartup, parseListenerOutput } = require("./apiListener");
const { environmentForMode, normalEnvironment, runStartup, stopVerifiedProjectApi } = require("./startApi");

const PROJECT_LISTENER = {
  state: "project-normal",
  pid: 17877,
  command: "node index.js",
  cwd: API_DIR,
};

test("only this project's API process is classified as replaceable", () => {
  const normal = parseListenerOutput("p17877\n", "node index.js", `n${API_DIR}\n`, "node index.js");
  assert.equal(normal.state, "project-normal");
  assert.equal(normal.pid, 17877);

  const chaos = parseListenerOutput(
    "p42\n",
    "node index.js",
    `n${API_DIR}\n`,
    "node index.js METRICMANTIS_CHAOS_ENABLED=true SESSION_SECRET=present",
  );
  assert.equal(chaos.state, "project-chaos");
  assert.equal(JSON.stringify(chaos).includes("present"), false);
  assert.equal(chaosEnabledTextSafe(chaos), true);

  const unset = parseListenerOutput(
    "p42\n",
    "node index.js",
    `n${API_DIR}\n`,
    "unset METRICMANTIS_CHAOS_ENABLED METRICMANTIS_CHAOS_ALLOWLIST && node index.js",
  );
  assert.equal(unset.state, "project-normal");

  const otherDir = classifyListener({
    pid: 9,
    cwd: "/tmp/other",
    command: "node index.js",
    chaosEnabled: false,
  });
  assert.equal(otherDir.state, "unrelated");

  const frontend = classifyListener({
    pid: 10,
    cwd: API_DIR,
    command: "node node_modules/next/dist/bin/next dev",
    chaosEnabled: false,
  });
  assert.equal(frontend.state, "unrelated");
});

function chaosEnabledTextSafe(listener) {
  return listener.state === "project-chaos" && listener.command === "node index.js";
}

test("startup mode refuses unrelated and chaos-enabled listeners", () => {
  assert.equal(decideStartup("chaos", { state: "free" }).action, "start");
  assert.equal(decideStartup("chaos", PROJECT_LISTENER).action, "replace");
  assert.equal(decideStartup("chaos", { ...PROJECT_LISTENER, state: "project-chaos" }).action, "already");
  assert.equal(decideStartup("normal", { ...PROJECT_LISTENER, state: "project-chaos" }).reason, "chaos-active");
  assert.equal(decideStartup("normal", PROJECT_LISTENER).reason, "already-running");
  assert.equal(decideStartup("chaos", { state: "unrelated", pid: 3, command: "python", cwd: "/tmp" }).action, "refuse");
  assert.equal(decideStartup("normal", { state: "unknown" }).action, "refuse");
});

test("normal mode forces chaos off and chaos mode reports the approved allowlist", async () => {
  const normal = normalEnvironment({
    METRICMANTIS_CHAOS_ENABLED: "true",
    METRICMANTIS_CHAOS_ALLOWLIST: "web-app,api,db",
    SESSION_SECRET: "present",
  });
  assert.equal(normal.METRICMANTIS_CHAOS_ENABLED, "");
  assert.equal(normal.METRICMANTIS_CHAOS_ALLOWLIST, "");
  assert.equal(chaosStatusFromEnv(normal).startupMode, "normal");
  assert.equal(chaosStatusFromEnv(normal).chaosEnabled, false);

  const chaos = environmentForMode("chaos", { SESSION_SECRET: "present" });
  const status = chaosStatusFromEnv(chaos);
  assert.equal(status.startupMode, "chaos");
  assert.equal(status.chaosEnabled, true);
  assert.deepEqual(status.allowlist, ["web-app", "api", "db"]);

  const docker = createDockerExecutor({
    env: chaos,
    async execFileImpl() { return { ok: true, stdout: "28" }; },
  });
  const caps = await docker.capabilities();
  assert.equal(caps.chaosEnabled, true);
  assert.equal(caps.startupMode, "chaos");
  assert.deepEqual(caps.allowlist, ["web-app", "api", "db"]);
});

test("chaos startup stops only the verified normal project API", async () => {
  const kills = [];
  let listener = { ...PROJECT_LISTENER };
  let spawned = null;
  const code = await runStartup("chaos", {
    baseEnv: { SESSION_SECRET: "present" },
    async inspect() { return listener; },
    kill(pid, signal) {
      kills.push([pid, signal]);
      assert.equal(pid, 17877);
      listener = { state: "free" };
    },
    spawn(_mode, env) { spawned = env; },
    log() {},
  });
  assert.equal(code, 0);
  assert.deepEqual(kills, [[17877, "SIGTERM"]]);
  assert.equal(spawned.METRICMANTIS_CHAOS_ENABLED, "true");
  assert.equal(spawned.METRICMANTIS_CHAOS_ALLOWLIST, "web-app,api,db");
  assert.equal(spawned.SESSION_SECRET, "present");
});

test("normal startup does not stop a chaos-enabled project API", async () => {
  const kills = [];
  const code = await runStartup("normal", {
    async inspect() {
      return { state: "project-chaos", pid: 42, command: "node index.js", cwd: API_DIR };
    },
    kill(pid) { kills.push(pid); },
    spawn() { throw new Error("spawned"); },
    log() {},
  });
  assert.equal(code, 1);
  assert.deepEqual(kills, []);
});

test("an unrelated listener is never signaled", async () => {
  const kills = [];
  await assert.rejects(
    () => stopVerifiedProjectApi(5, async () => ({
      state: "unrelated",
      pid: 5,
      command: "python other.py",
      cwd: "/tmp",
    }), (pid) => kills.push(pid)),
    /no longer this project's normal API/,
  );
  assert.deepEqual(kills, []);

  const code = await runStartup("chaos", {
    async inspect() {
      return { state: "unrelated", pid: 5, command: "python other.py", cwd: "/tmp" };
    },
    kill(pid) { kills.push(pid); },
    spawn() { throw new Error("spawned"); },
    log() {},
  });
  assert.equal(code, 1);
  assert.deepEqual(kills, []);
});
