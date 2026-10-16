const { execFile } = require("child_process");
const path = require("path");

const APPROVED_COMPOSE_FILE = path.resolve(__dirname, "approved-sample-compose.yml");
const APPROVED_SERVICES = ["web-app", "api", "db"];
const AUXILIARY_SERVICES = ["measurer"];
const PROJECT_NAME = /^mm[a-f0-9]{16}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const INSPECT_FORMAT = '{"id":{{json .Id}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';

function isValidProjectName(projectName) {
  return PROJECT_NAME.test(projectName);
}

function defaultExec(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout || "");
      if (out.length > 8000) {
        resolve({ ok: false, stdout: "", stderr: "Docker returned too much output." });
        return;
      }
      resolve({
        ok: !error,
        stdout: out.trim(),
        stderr: String(stderr || error?.message || "").trim().slice(0, 300),
      });
    });
  });
}

async function run(execFileImpl, args, timeoutMs) {
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    return { ok: false, stdout: "", stderr: "Invalid Docker argument." };
  }
  return execFileImpl("docker", args, timeoutMs);
}

async function dockerAvailable(execFileImpl) {
  const docker = await run(execFileImpl, ["version", "--format", "{{.Server.Version}}"], 4000);
  const compose = await run(execFileImpl, ["compose", "version", "--short"], 4000);
  return Boolean(docker.ok && docker.stdout && compose.ok && compose.stdout);
}

function composeArgs(projectName, args) {
  if (!isValidProjectName(projectName)) return null;
  return ["compose", "-p", projectName, "-f", APPROVED_COMPOSE_FILE, ...args];
}

async function listProjectIds(execFileImpl, projectName) {
  const result = await run(execFileImpl, [
    "ps", "-aq", "--no-trunc",
    "--filter", `label=com.docker.compose.project=${projectName}`,
  ], 8000);
  if (!result.ok) return { error: "Could not list sandbox containers." };
  const ids = result.stdout ? result.stdout.split(/\s+/).filter(Boolean) : [];
  if (ids.some((id) => !CONTAINER_ID.test(id))) {
    return { error: "Docker returned an unexpected container id." };
  }
  return { ids };
}

async function inspectContainer(execFileImpl, id) {
  if (!CONTAINER_ID.test(id)) return { error: "Invalid container id." };
  const result = await run(execFileImpl, ["inspect", "--format", INSPECT_FORMAT, id], 8000);
  if (!result.ok || !result.stdout) return { error: "Could not inspect a sandbox container." };
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { error: "Could not read container inspection." };
  }
  if (!body || body.id !== id || !CONTAINER_ID.test(body.id)) {
    return { error: "Container inspection did not match the requested id." };
  }
  return {
    id: body.id,
    status: body.status || null,
    health: body.health || "",
    project: body.project || null,
    service: body.service || null,
  };
}

async function observeProject(execFileImpl, projectName) {
  if (!isValidProjectName(projectName)) return { error: "Invalid sandbox project name." };
  const listed = await listProjectIds(execFileImpl, projectName);
  if (listed.error) return { error: listed.error };
  if (listed.ids.length === 0) return { ready: false, empty: true, services: {} };

  const services = {};
  for (const id of listed.ids) {
    const info = await inspectContainer(execFileImpl, id);
    if (info.error) return { error: info.error };
    if (info.project !== projectName) {
      return { error: "A container label did not match this sandbox project.", mismatch: true };
    }
    if (AUXILIARY_SERVICES.includes(info.service)) continue;
    if (!APPROVED_SERVICES.includes(info.service) || services[info.service]) {
      return { error: "The sandbox project has an unexpected container.", unexpected: true };
    }
    services[info.service] = info;
  }
  const ready = APPROVED_SERVICES.every((name) => (
    services[name]?.status === "running" && services[name]?.health === "healthy"
  ));
  return { ready, empty: false, services };
}

async function startApprovedProject(execFileImpl, projectName) {
  const args = composeArgs(projectName, ["up", "-d"]);
  if (!args) return { ok: false, error: "Invalid sandbox project name." };
  const result = await run(execFileImpl, args, 180000);
  return { ok: result.ok, error: result.ok ? null : "The approved sample did not start." };
}

async function removeApprovedProject(execFileImpl, projectName) {
  const before = await observeProject(execFileImpl, projectName);
  if (before.mismatch) return { ok: false, error: before.error };
  if (before.empty) return { ok: true };
  const args = composeArgs(projectName, ["down", "--remove-orphans"]);
  if (!args) return { ok: false, error: "Invalid sandbox project name." };
  const removed = await run(execFileImpl, args, 90000);
  if (!removed.ok) return { ok: false, error: "Sandbox cleanup failed." };
  const after = await observeProject(execFileImpl, projectName);
  if (after.error || !after.empty) {
    return { ok: false, error: "Sandbox resources were still present after cleanup." };
  }
  return { ok: true };
}

const DOCKER_STATES = new Set(["running", "exited", "created", "paused", "restarting", "dead", "removing"]);

function normalizeState(status) {
  return DOCKER_STATES.has(status) ? status : "unknown";
}

function normalizeHealth(health) {
  if (health === "healthy" || health === "unhealthy" || health === "starting") return health;
  return "unknown";
}

function displayFor(state, health, verified) {
  if (!verified) return "unknown";
  if (state === "exited" || state === "dead" || state === "removing") return "exited";
  if (health === "healthy") return "healthy";
  if (health === "unhealthy") return "unhealthy";
  if (state === "running") return "running";
  return "unknown";
}

function unknownService(service) {
  return {
    service,
    containerId: null,
    state: "unknown",
    health: "unknown",
    display: "unknown",
    verified: false,
  };
}

async function readProjectRuntime(execFileImpl, projectName, recordedServices) {
  if (!isValidProjectName(projectName)) return { error: "Invalid sandbox project name." };
  const recorded = recordedServices && typeof recordedServices === "object" ? recordedServices : {};
  const listed = await listProjectIds(execFileImpl, projectName);
  if (listed.error) return { error: listed.error };

  const recordedIds = new Map();
  for (const [name, id] of Object.entries(recorded)) {
    if (typeof id === "string" && CONTAINER_ID.test(id)) recordedIds.set(id, name);
  }
  const candidates = [...new Set([...recordedIds.keys(), ...listed.ids])];
  const trusted = new Map();
  const rejected = new Set();
  let mismatch = false;
  let unexpected = false;
  let inspectFailed = false;

  for (const id of candidates) {
    const info = await inspectContainer(execFileImpl, id);
    const recordedService = recordedIds.get(id);
    if (info.error) {
      if (listed.ids.includes(id)) inspectFailed = true;
      continue;
    }
    if (info.project !== projectName) {
      mismatch = true;
      if (recordedService) rejected.add(recordedService);
      continue;
    }
    const serviceName = info.service;
    if (AUXILIARY_SERVICES.includes(serviceName)) continue;
    const knownService = APPROVED_SERVICES.includes(serviceName) || Object.hasOwn(recorded, serviceName);
    if (!knownService || (recordedService && recordedService !== serviceName) || trusted.has(serviceName)) {
      unexpected = true;
      if (trusted.has(serviceName)) {
        trusted.delete(serviceName);
        rejected.add(serviceName);
      }
      if (recordedService) rejected.add(recordedService);
      continue;
    }
    trusted.set(serviceName, {
      service: serviceName,
      containerId: info.id,
      state: normalizeState(info.status),
      health: normalizeHealth(info.health),
      verified: true,
    });
  }

  const names = new Set([...Object.keys(recorded), ...trusted.keys()]);
  const services = [...names].sort().map((name) => {
    const row = trusted.get(name);
    if (!row || rejected.has(name)) return unknownService(name);
    return { ...row, display: displayFor(row.state, row.health, true) };
  });

  let error = null;
  if (mismatch) error = "A container label did not match this sandbox project.";
  else if (unexpected || rejected.size > 0) error = "The sandbox project has an unexpected container.";
  else if (inspectFailed) error = "Could not inspect a sandbox container.";
  return { services, error };
}

async function waitUntilReady(execFileImpl, projectName, sleep) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const observed = await observeProject(execFileImpl, projectName);
    if (observed.mismatch || observed.unexpected || (observed.error && observed.empty !== true && !observed.services)) {
      return observed;
    }
    if (observed.ready) return observed;
    if (observed.error) return observed;
    await sleep(1000);
  }
  return { error: "The approved sample did not become healthy." };
}

module.exports = {
  APPROVED_COMPOSE_FILE,
  APPROVED_SERVICES,
  AUXILIARY_SERVICES,
  defaultExec,
  isValidProjectName,
  dockerAvailable,
  observeProject,
  startApprovedProject,
  removeApprovedProject,
  inspectContainer,
  readProjectRuntime,
  waitUntilReady,
};
