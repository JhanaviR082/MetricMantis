const crypto = require("crypto");
const yaml = require("js-yaml");
const { isSafeServiceName } = require("../experiments/dockerExecutor");
const repository = require("../database/sandboxRepository");
const runtime = require("./sandboxRuntime");

const MAX_COMPOSE_CHARS = 200000;
const MAX_SERVICES = 50;

function publicSandbox(sandbox) {
  if (!sandbox) return null;
  return {
    id: sandbox.id,
    projectName: sandbox.projectName,
    status: sandbox.status,
    fileName: sandbox.fileName,
    services: sandbox.services,
    error: sandbox.error,
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
    startedAt: sandbox.startedAt,
    stoppedAt: sandbox.stoppedAt,
  };
}

function parseComposeServices(composeYaml) {
  if (typeof composeYaml !== "string" || !composeYaml.trim()) {
    return { error: "Compose YAML is required." };
  }
  if (composeYaml.length > MAX_COMPOSE_CHARS) {
    return { error: "Compose YAML is too large." };
  }
  let parsed;
  try {
    parsed = yaml.load(composeYaml);
  } catch {
    return { error: "Compose YAML could not be parsed." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Compose YAML must define a services map." };
  }
  const services = parsed.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    return { error: "Compose YAML must define a services map." };
  }
  const names = Object.keys(services);
  if (names.length === 0 || names.length > MAX_SERVICES) {
    return { error: "Compose YAML must define between 1 and 50 services." };
  }
  if (names.some((name) => !isSafeServiceName(name))) {
    return { error: "A Compose service name is not safe to store." };
  }
  const mapping = {};
  for (const name of names) mapping[name] = null;
  return { services: mapping };
}

function projectName() {
  return `mm${crypto.randomBytes(8).toString("hex")}`;
}

function hasContainerId(services) {
  return Object.values(services || {}).some((value) => typeof value === "string" && value.length > 0);
}

function createSandboxRecord(userId, body, now = () => new Date().toISOString()) {
  const parsed = parseComposeServices(body?.composeYaml);
  if (parsed.error) return { error: parsed.error, status: 400 };

  const active = repository.findActive(userId);
  if (active) {
    return {
      error: "Another sandbox is already starting or running.",
      sandbox: publicSandbox(active),
      status: 409,
    };
  }

  const composeYaml = body.composeYaml;
  const composeSha256 = crypto.createHash("sha256").update(composeYaml).digest("hex");
  const existing = repository.findCreatedByHash(userId, composeSha256);
  if (existing) return { sandbox: publicSandbox(existing), status: 200 };

  const timestamp = now();
  for (const open of repository.listCreated(userId)) {
    if (hasContainerId(open.services)) {
      return {
        error: "An open sandbox already has container ids, so a new record was not created.",
        status: 409,
      };
    }
    repository.markStopped(open.id, userId, timestamp);
  }

  let created = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    try {
      created = repository.createSandbox({
        id: crypto.randomUUID(),
        userId,
        projectName: projectName(),
        status: "created",
        composeSha256,
        composeYaml,
        fileName: typeof body?.fileName === "string" ? body.fileName.slice(0, 200) : null,
        services: parsed.services,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      if (!String(error.message || "").includes("UNIQUE")) throw error;
    }
  }
  if (!created) return { error: "A unique sandbox project name could not be reserved.", status: 500 };
  return { sandbox: publicSandbox(created), status: 201 };
}

function getSandboxRecord(userId, id) {
  return publicSandbox(repository.getSandbox(id, userId));
}

function getActiveSandboxRecord(userId) {
  return publicSandbox(repository.findActive(userId));
}

async function readSandboxRuntime(userId, id, deps = {}) {
  const current = repository.getSandbox(id, userId);
  if (!current) return { error: "Sandbox not found.", status: 404 };
  if (!runtime.isValidProjectName(current.projectName)) {
    return {
      error: "The sandbox project name is invalid, so runtime status was not read.",
      sandbox: publicSandbox(current),
      status: 409,
    };
  }
  const execFileImpl = deps.execFileImpl || runtime.defaultExec;
  if (!await runtime.dockerAvailable(execFileImpl)) {
    return {
      error: "Docker is not available, so runtime status was not read.",
      sandbox: publicSandbox(current),
      status: 503,
    };
  }
  const observed = await runtime.readProjectRuntime(execFileImpl, current.projectName, current.services);
  if (observed.error && !observed.services) {
    return {
      error: observed.error,
      sandbox: publicSandbox(current),
      status: 502,
    };
  }
  return {
    sandbox: publicSandbox(current),
    runtime: { services: observed.services, error: observed.error || null },
    error: observed.error || null,
    status: 200,
  };
}

function clearedServices(services) {
  const cleared = {};
  for (const name of Object.keys(services || {})) cleared[name] = null;
  for (const name of runtime.APPROVED_SERVICES) cleared[name] = null;
  return cleared;
}

async function startSandbox(userId, id, deps = {}) {
  const execFileImpl = deps.execFileImpl || runtime.defaultExec;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => new Date().toISOString());
  const current = repository.getSandbox(id, userId);
  if (!current) return { error: "Sandbox not found.", status: 404 };
  if (!runtime.isValidProjectName(current.projectName)) {
    return {
      error: "The sandbox project name is invalid, so nothing was started.",
      sandbox: publicSandbox(current),
      status: 409,
    };
  }
  if (current.status !== "created" || hasContainerId(current.services)) {
    return {
      error: "This sandbox cannot be started from its current state.",
      sandbox: publicSandbox(current),
      status: 409,
    };
  }
  if (!await runtime.dockerAvailable(execFileImpl)) {
    return {
      error: "Docker Compose is not available, so the sandbox was not started.",
      sandbox: publicSandbox(current),
      status: 503,
    };
  }

  const claimed = repository.claimStart(userId, id, now());
  if (!claimed.sandbox) {
    const latest = repository.getSandbox(id, userId);
    const activeSandbox = claimed.conflict === "active" ? repository.findActive(userId) : null;
    return {
      error: claimed.conflict === "active"
        ? "Another sandbox is already starting or running."
        : "This sandbox cannot be started from its current state.",
      sandbox: activeSandbox ? publicSandbox(activeSandbox) : (latest ? publicSandbox(latest) : null),
      status: 409,
    };
  }

  const started = await runtime.startApprovedProject(execFileImpl, current.projectName);
  if (!started.ok) {
    await runtime.removeApprovedProject(execFileImpl, current.projectName);
    const failed = repository.saveFailed(id, userId, started.error, now());
    return { sandbox: publicSandbox(failed), error: started.error, status: 502 };
  }

  const ready = await runtime.waitUntilReady(execFileImpl, current.projectName, sleep);
  if (!ready.ready || ready.mismatch) {
    if (!ready.mismatch) await runtime.removeApprovedProject(execFileImpl, current.projectName);
    const failed = repository.saveFailed(id, userId, ready.error || "The approved sample did not become healthy.", now());
    return { sandbox: publicSandbox(failed), error: failed.error, status: 502 };
  }

  const services = {};
  for (const name of runtime.APPROVED_SERVICES) services[name] = ready.services[name].id;
  const running = repository.saveRunning(id, userId, services, now());
  if (!running) {
    await runtime.removeApprovedProject(execFileImpl, current.projectName);
    const failed = repository.saveFailed(id, userId, "The sandbox record changed before it could be marked running.", now());
    return { sandbox: publicSandbox(failed), error: failed.error, status: 409 };
  }
  return { sandbox: publicSandbox(running), status: 200 };
}

async function cleanupSandboxRecord(userId, id, deps = {}, now = () => new Date().toISOString()) {
  const execFileImpl = deps.execFileImpl || runtime.defaultExec;
  const current = repository.getSandbox(id, userId);
  if (!current) return { error: "Sandbox not found.", status: 404 };
  if (!runtime.isValidProjectName(current.projectName)) {
    return {
      error: "Cleanup did not change containers. The sandbox project name is invalid.",
      sandbox: publicSandbox(current),
      status: 409,
    };
  }

  if (current.status === "stopped" || (current.status === "created" && !hasContainerId(current.services))) {
    if (!await runtime.dockerAvailable(execFileImpl)) {
      if (current.status === "stopped" || !hasContainerId(current.services)) {
        if (current.status === "created") {
          const stopped = repository.markStopped(id, userId, now());
          return { sandbox: publicSandbox(stopped), status: 200 };
        }
        return { sandbox: publicSandbox(current), status: 200 };
      }
    }
    const observed = await runtime.observeProject(execFileImpl, current.projectName);
    if (observed.mismatch) {
      return { error: observed.error, sandbox: publicSandbox(current), status: 409 };
    }
    if (observed.empty && !observed.error) {
      if (current.status === "stopped") return { sandbox: publicSandbox(current), status: 200 };
      const stopped = repository.markStopped(id, userId, now());
      return { sandbox: publicSandbox(stopped), status: 200 };
    }
    if (observed.error || observed.empty === false) {
      if (observed.mismatch || observed.error) {
        return {
          error: observed.error || "Cleanup could not confirm the sandbox project was empty.",
          sandbox: publicSandbox(current),
          status: 409,
        };
      }
    }
  }

  if (!["created", "starting", "running", "stopping", "failed"].includes(current.status)) {
    return {
      error: "Cleanup did not change containers. This sandbox cannot be stopped from its current state.",
      sandbox: publicSandbox(current),
      status: 409,
    };
  }

  const stopping = current.status === "stopping"
    ? current
    : repository.claimStop(id, userId, ["created", "starting", "running", "failed", "stopped"], now());
  if (!stopping) {
    const latest = repository.getSandbox(id, userId);
    return {
      error: "Cleanup did not change containers. This sandbox cannot be stopped from its current state.",
      sandbox: latest ? publicSandbox(latest) : publicSandbox(current),
      status: 409,
    };
  }

  const removed = await runtime.removeApprovedProject(execFileImpl, current.projectName);
  if (!removed.ok) {
    const failed = repository.saveFailed(id, userId, removed.error, now());
    return { sandbox: publicSandbox(failed), error: removed.error, status: 502 };
  }
  const stopped = repository.saveStopped(id, userId, clearedServices(current.services), now());
  if (!stopped) {
    const latest = repository.getSandbox(id, userId);
    if (latest?.status === "stopped") return { sandbox: publicSandbox(latest), status: 200 };
    const failed = repository.saveFailed(id, userId, "The sandbox record changed during cleanup.", now());
    return { sandbox: publicSandbox(failed), error: failed.error, status: 409 };
  }
  return { sandbox: publicSandbox(stopped), status: 200 };
}

module.exports = {
  createSandboxRecord,
  getSandboxRecord,
  getActiveSandboxRecord,
  readSandboxRuntime,
  startSandbox,
  cleanupSandboxRecord,
  parseComposeServices,
};
