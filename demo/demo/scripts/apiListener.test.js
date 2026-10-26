const assert = require("node:assert/strict");
const test = require("node:test");
const { createDockerExecutor, chaosStatusFromEnv } = require("../experiments/dockerExecutor");
const { API_DIR, classifyListener, decideStartup, parseListenerOutput } = require("./apiListener");
const {
  inspectPortUnix,
  inspectPortWindows,
  parseWindowsListeningPids,
  parseWindowsProcessInfo,
  isValidWindowsAbsolutePath,
  isValidWindowsEnvironment,
  tokenizeCommandLine,
  isProjectApiCommand,
} = require("./apiListener");
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

// ---------------------------------------------------------------------------
// Windows support (apiListener.js) — the API runs on port 3001 and the same
// safety contract must hold on Windows as on Unix. These tests exercise the
// Windows parsing/inspection logic with mocked command output so they do not
// require a real Windows machine, except the end-to-end project cases which
// rely on Windows path semantics.
// ---------------------------------------------------------------------------

const WIN = process.platform === "win32";

test("tokenizeCommandLine splits on unquoted whitespace and keeps quoted segments", () => {
  assert.deepEqual(tokenizeCommandLine("node index.js"), ["node", "index.js"]);
  assert.deepEqual(tokenizeCommandLine('"C:\\Program Files\\nodejs\\node.exe" index.js'), [
    "C:\\Program Files\\nodejs\\node.exe",
    "index.js",
  ]);
  assert.deepEqual(tokenizeCommandLine("node node_modules/next/dist/bin/next dev"), [
    "node",
    "node_modules/next/dist/bin/next",
    "dev",
  ]);
  assert.deepEqual(tokenizeCommandLine(""), []);
});

test("isProjectApiCommand accepts node/node.exe from this project dir and rejects others", () => {
  assert.equal(isProjectApiCommand("node index.js", API_DIR), true);
  assert.equal(isProjectApiCommand("node.exe index.js", API_DIR), true);
  assert.equal(isProjectApiCommand('"C:\\Program Files\\nodejs\\node.exe" index.js', API_DIR), true);
  assert.equal(isProjectApiCommand("python server.py", API_DIR), false);
  assert.equal(isProjectApiCommand("node node_modules/next/dist/bin/next dev", API_DIR), false);
  assert.equal(isProjectApiCommand("node index.js", "/tmp/other"), false);
  assert.equal(isProjectApiCommand("", API_DIR), false);
});

const NETSTAT_SAMPLE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       4321",
  "  TCP    [::]:3001              [::]:0                 LISTENING       4321",
  "  TCP    127.0.0.1:3001         127.0.0.1:51234        ESTABLISHED     9999",
  "  UDP    0.0.0.0:3002           *:*                                    1111",
  "  TCP    0.0.0.0:30010          0.0.0.0:0              LISTENING       2222",
].join("\n");

test("parseWindowsListeningPids finds listeners by local port + foreign port 0 and ignores the rest", () => {
  assert.deepEqual(parseWindowsListeningPids(NETSTAT_SAMPLE, 3001).sort((a, b) => a - b), [4321]);
  assert.deepEqual(parseWindowsListeningPids(NETSTAT_SAMPLE, 30010), [2222]);
  assert.deepEqual(parseWindowsListeningPids(NETSTAT_SAMPLE, 3002), []);
  assert.deepEqual(parseWindowsListeningPids("", 3001), []);
});

test("parseWindowsProcessInfo parses PEB JSON or fails safe to null", () => {
  assert.deepEqual(
    parseWindowsProcessInfo(
      JSON.stringify({ command: "node index.js", cwd: "C:\\demo", environment: "SystemRoot=C:\\Windows" }),
    ),
    { command: "node index.js", cwd: "C:\\demo", environment: "SystemRoot=C:\\Windows" },
  );
  assert.equal(parseWindowsProcessInfo(""), null);
  assert.equal(parseWindowsProcessInfo("not json"), null);
  assert.equal(parseWindowsProcessInfo(JSON.stringify({ command: "x" })), null);
  assert.deepEqual(
    parseWindowsProcessInfo('\uFEFF{"command":"c","cwd":"d","environment":"e"}'),
    { command: "c", cwd: "d", environment: "e" },
  );
});

test("Windows validators guard against garbage PEB reads", () => {
  assert.equal(isValidWindowsAbsolutePath("C:\\Users\\demo"), true);
  assert.equal(isValidWindowsAbsolutePath("/home/demo"), false);
  assert.equal(isValidWindowsAbsolutePath("relative"), false);
  assert.equal(isValidWindowsEnvironment("SystemRoot=C:\\Windows\nPATH=C:\\Windows\\system32"), true);
  assert.equal(isValidWindowsEnvironment("garbage"), false);
  assert.equal(isValidWindowsEnvironment(""), false);
});

// Mock execImpl for the Windows path: returns canned `netstat -ano` output and
// the PEB JSON keyed by the PID passed via -ProcessId.
function winExec(netstat, pebByPid) {
  return (cmd, args) => {
    if (cmd === "netstat") return netstat;
    if (cmd === "powershell") {
      const idx = args.indexOf("-ProcessId");
      const pid = idx >= 0 ? Number(args[idx + 1]) : NaN;
      return pebByPid && pebByPid[pid] != null ? pebByPid[pid] : "";
    }
    throw new Error("unexpected command " + cmd);
  };
}

const WIN_NETSTAT_LISTENING = (pid) =>
  [
    "  Proto  Local Address          Foreign Address        State           PID",
    `  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       ${pid}`,
  ].join("\n");

const WIN_NETSTAT_EMPTY =
  "  Proto  Local Address          Foreign Address        State           PID";

const WIN_NETSTAT_MULTIPLE = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       111",
  "  TCP    [::]:3001              [::]:0                 LISTENING       222",
].join("\n");

test("inspectPortWindows reports free when nothing listens on the port", () => {
  assert.equal(inspectPortWindows(3001, winExec(WIN_NETSTAT_EMPTY, {})).state, "free");
});

test("inspectPortWindows classifies a non-node listener as unrelated", () => {
  const peb = JSON.stringify({
    command: "C:\\Python\\python.exe server.py",
    cwd: "C:\\tmp",
    environment: "SystemRoot=C:\\Windows\nPATH=C:\\Python",
  });
  const r = inspectPortWindows(3001, winExec(WIN_NETSTAT_LISTENING(55), { 55: peb }));
  assert.equal(r.state, "unrelated");
  assert.equal(r.pid, 55);
});

test("inspectPortWindows reports unknown when multiple listeners occupy the port", () => {
  assert.equal(inspectPortWindows(3001, winExec(WIN_NETSTAT_MULTIPLE, {})).state, "unknown");
});

test("inspectPortWindows fails safe to unknown when the PEB read is empty", () => {
  assert.equal(inspectPortWindows(3001, winExec(WIN_NETSTAT_LISTENING(77), { 77: "" })).state, "unknown");
});

test("inspectPortWindows fails safe to unknown when the environment block looks invalid", () => {
  const peb = JSON.stringify({ command: "node.exe index.js", cwd: "C:\\demo", environment: "not-an-env-block" });
  assert.equal(inspectPortWindows(3001, winExec(WIN_NETSTAT_LISTENING(88), { 88: peb })).state, "unknown");
});

test("inspectPortWindows fails safe to unknown when the cwd is not an absolute Windows path", () => {
  const peb = JSON.stringify({ command: "node.exe index.js", cwd: "relative", environment: "SystemRoot=C:\\Windows\nPATH=x" });
  assert.equal(inspectPortWindows(3001, winExec(WIN_NETSTAT_LISTENING(99), { 99: peb })).state, "unknown");
});

test(
  "inspectPortWindows identifies this project's normal and chaos API (Windows path semantics)",
  { skip: process.platform !== "win32" },
  () => {
    const normalPeb = JSON.stringify({
      command: '"C:\\Program Files\\nodejs\\node.exe" index.js',
      cwd: API_DIR,
      environment: "SystemRoot=C:\\Windows\nPATH=C:\\Windows\\system32\nMETRICMANTIS_CHAOS_ENABLED=\nSESSION_SECRET=secret",
    });
    const normal = inspectPortWindows(3001, winExec(WIN_NETSTAT_LISTENING(4321), { 4321: normalPeb }));
    assert.equal(normal.state, "project-normal");
    assert.equal(normal.pid, 4321);
    assert.equal(JSON.stringify(normal).includes("secret"), false);

    const chaosPeb = JSON.stringify({
      command: "node.exe index.js",
      cwd: API_DIR,
      environment: "SystemRoot=C:\\Windows\nPATH=x\nMETRICMANTIS_CHAOS_ENABLED=true",
    });
    const chaos = inspectPortWindows(3001, winExec(WIN_NETSTAT_LISTENING(42), { 42: chaosPeb }));
    assert.equal(chaos.state, "project-chaos");
    assert.equal(chaos.pid, 42);
  },
);

// ---------------------------------------------------------------------------
// Unix regression: the lsof/ps path is refactored into inspectPortUnix but its
// behavior must not change. Mocked so it runs on any platform.
// ---------------------------------------------------------------------------

test("inspectPortUnix unchanged: free when lsof exits status 1", () => {
  const exec = (cmd, args) => {
    if (cmd === "lsof" && args.some((a) => a.startsWith("-iTCP:"))) {
      const e = new Error("no listener");
      e.status = 1;
      throw e;
    }
    throw new Error("unexpected " + cmd);
  };
  assert.equal(inspectPortUnix(3001, exec).state, "free");
});

test("inspectPortUnix unchanged: project-normal via lsof + ps", () => {
  const exec = (cmd, args) => {
    if (cmd === "lsof") {
      if (args.some((a) => a.startsWith("-iTCP:"))) return "p4321\n";
      if (args.includes("-d") && args.includes("cwd")) return `n${API_DIR}\n`;
      throw new Error("lsof " + args.join(" "));
    }
    if (cmd === "ps") {
      if (args.includes("command=")) return "node index.js";
      if (args.includes("eww")) return "node index.js";
      throw new Error("ps " + args.join(" "));
    }
    throw new Error("unexpected " + cmd);
  };
  const r = inspectPortUnix(3001, exec);
  assert.equal(r.state, "project-normal");
  assert.equal(r.pid, 4321);
});

test("inspectPortUnix unchanged: unrelated via ps command", () => {
  const exec = (cmd, args) => {
    if (cmd === "lsof") {
      if (args.some((a) => a.startsWith("-iTCP:"))) return "p55\n";
      if (args.includes("-d") && args.includes("cwd")) return "n/tmp\n";
      throw new Error("lsof");
    }
    if (cmd === "ps") {
      if (args.includes("command=")) return "python other.py";
      if (args.includes("eww")) return "python other.py";
      throw new Error("ps");
    }
    throw new Error("unexpected " + cmd);
  };
  const r = inspectPortUnix(3001, exec);
  assert.equal(r.state, "unrelated");
  assert.equal(r.pid, 55);
});
