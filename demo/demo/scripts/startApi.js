const { spawn } = require("child_process");
const { localChaosEnvironment } = require("./localChaos");
const { API_DIR, decideStartup, describeListener, inspectPort } = require("./apiListener");

function normalEnvironment(baseEnv = {}) {
  return {
    ...baseEnv,
    METRICMANTIS_CHAOS_ENABLED: "",
    METRICMANTIS_CHAOS_ALLOWLIST: "",
  };
}

function environmentForMode(mode, baseEnv = process.env) {
  return mode === "chaos" ? localChaosEnvironment(baseEnv) : normalEnvironment(baseEnv);
}

function startupMessage(mode, listener) {
  const described = describeListener(listener);
  const decision = decideStartup(mode, listener);
  if (decision.action === "start" && mode === "chaos") {
    return "Starting the MetricMantis API with chaos enabled for the approved sandbox services.";
  }
  if (decision.action === "start") {
    return "Starting the MetricMantis API with real chaos disabled.";
  }
  if (decision.action === "already") {
    return `Port 3001 is already this project's chaos-enabled API: ${described}. Another API was not started.`;
  }
  if (decision.action === "replace") {
    return `Port 3001 is this project's API with chaos disabled: ${described}. Stopping only that process, then starting the chaos-enabled API.`;
  }
  if (decision.reason === "chaos-active") {
    return `Port 3001 is this project's chaos-enabled API: ${described}. npm start will not replace it. Stop that process before starting normal mode.`;
  }
  if (decision.reason === "already-running") {
    return `Port 3001 is already this project's API: ${described}. npm start will not replace it.`;
  }
  return `Port 3001 is occupied by a process that is not this project's API: ${described}. It was not stopped.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilPidLeaves(pid, inspect, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let current = await inspect();
  while (Date.now() < deadline) {
    if (!current || current.state === "free" || current.pid !== pid) return current;
    await sleep(200);
    current = await inspect();
  }
  return current;
}

async function stopVerifiedProjectApi(pid, inspect, kill = process.kill) {
  const current = await inspect();
  if (!current || current.state !== "project-normal" || current.pid !== pid) {
    throw new Error("Refusing to stop because the listener is no longer this project's normal API.");
  }
  kill(pid, "SIGTERM");
  let after = await waitUntilPidLeaves(pid, inspect);
  if (after && after.state === "project-normal" && after.pid === pid) {
    const again = await inspect();
    if (again.state === "project-normal" && again.pid === pid) kill(pid, "SIGKILL");
    after = await waitUntilPidLeaves(pid, inspect, 2000);
  }
  if (after && after.pid === pid && after.state !== "free") {
    throw new Error("The project API on port 3001 did not exit.");
  }
}

function spawnApi(mode, env, spawnImpl = spawn) {
  const child = spawnImpl(process.execPath, ["index.js"], {
    cwd: API_DIR,
    env,
    stdio: "inherit",
  });
  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });
  return child;
}

async function runStartup(mode, deps = {}) {
  const inspect = deps.inspect || (() => inspectPort(Number(process.env.PORT) || 3001));
  const log = deps.log || console.log;
  const listener = await inspect();
  log(startupMessage(mode, listener));
  const decision = decideStartup(mode, listener);
  if (decision.action === "refuse") return 1;
  if (decision.action === "already") return 0;
  if (decision.action === "replace") {
    await stopVerifiedProjectApi(decision.pid, inspect, deps.kill);
    const after = await inspect();
    if (!after || after.state !== "free") {
      log("Port 3001 is still occupied. The chaos-enabled API was not started.");
      return 1;
    }
  }
  if (deps.spawn) {
    deps.spawn(mode, environmentForMode(mode, deps.baseEnv || process.env));
    return 0;
  }
  spawnApi(mode, environmentForMode(mode));
  return null;
}

function parseMode(argv) {
  const mode = argv[2];
  if (mode !== "normal" && mode !== "chaos") return null;
  return mode;
}

module.exports = {
  normalEnvironment,
  environmentForMode,
  startupMessage,
  stopVerifiedProjectApi,
  runStartup,
  parseMode,
};

if (require.main === module) {
  const mode = parseMode(process.argv);
  if (!mode) {
    console.error("Usage: node scripts/startApi.js normal|chaos");
    process.exit(1);
  }
  runStartup(mode).then((code) => {
    if (code != null) process.exit(code);
  }).catch((error) => {
    console.error(error.message || "The API was not started.");
    process.exit(1);
  });
}
