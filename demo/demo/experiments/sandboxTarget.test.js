const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const dbPath = path.join(os.tmpdir(), `metricmantis-sandbox-target-${process.pid}.db`);
process.env.METRICMANTIS_DB_PATH = dbPath;

const { initDatabase } = require("../database/database");
const sandboxRepository = require("../database/sandboxRepository");
const userRepository = require("../database/userRepository");
const { resolveSandboxTarget } = require("./experimentService");
const { createDockerExecutor } = require("./dockerExecutor");

const OWNER_PROJECT = "mm0123456789abcdef";
const OTHER_PROJECT = "mmfedcba9876543210";
const API_ID = "a".repeat(64);
const DB_ID = "b".repeat(64);
const SANDBOX_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SANDBOX_ID = "22222222-2222-4222-8222-222222222222";

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

function storeSandbox(ownerId, overrides = {}) {
  return sandboxRepository.createSandbox({
    id: SANDBOX_ID,
    userId: ownerId,
    projectName: OWNER_PROJECT,
    status: "running",
    composeSha256: "sample",
    composeYaml: "services:\n  api:\n    image: not-executed\n",
    fileName: "uploaded.yml",
    services: { api: API_ID, db: null, "web-app": null },
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  });
}

function dockerFor(projects) {
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    if (args[0] === "version") return { ok: true, stdout: "28", stderr: "" };
    if (args[0] === "compose" && args[1] === "version") return { ok: true, stdout: "2", stderr: "" };
    if (args[0] === "ps") {
      const filter = args.find((arg) => arg.startsWith("label=com.docker.compose.project=")) || "";
      const project = filter.split("=").pop();
      const ids = projects[project]?.ids || [];
      return { ok: true, stdout: ids.join("\n"), stderr: "" };
    }
    if (args[0] === "inspect") {
      const id = args[args.length - 1];
      const row = Object.values(projects).flatMap((project) => project.rows).find((item) => item.id === id);
      if (!row) return { ok: false, stdout: "", stderr: "missing" };
      return { ok: true, stdout: JSON.stringify(row), stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected docker command" };
  };
  return { calls, execFileImpl };
}

function projects() {
  return {
    [OWNER_PROJECT]: {
      ids: [API_ID],
      rows: [{ id: API_ID, status: "running", health: "healthy", project: OWNER_PROJECT, service: "api" }],
    },
    [OTHER_PROJECT]: {
      ids: [DB_ID],
      rows: [{ id: DB_ID, status: "running", health: "healthy", project: OTHER_PROJECT, service: "api" }],
    },
  };
}

test("a measured target must be a verified container in the owner's running sandbox", async () => {
  resetDb();
  const owner = user("sandbox-owner");
  const other = user("sandbox-other");
  storeSandbox(owner.id);
  sandboxRepository.createSandbox({
    id: OTHER_SANDBOX_ID,
    userId: other.id,
    projectName: OTHER_PROJECT,
    status: "running",
    composeSha256: "other",
    composeYaml: "services:\n  api:\n    image: other\n",
    fileName: null,
    services: { api: DB_ID },
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  });
  const docker = dockerFor(projects());

  const selected = await resolveSandboxTarget(owner.id, SANDBOX_ID, "api", docker);
  assert.equal(selected.status, 200);
  assert.equal(selected.container.id, API_ID);
  assert.equal(selected.container.projectName, OWNER_PROJECT);
  assert.equal(selected.container.service, "api");
  assert.equal(docker.calls.some((args) => args.includes("web-app") || args.includes("uploaded.yml")), false);
  assert.equal(docker.calls.some((args) => ["stop", "rm", "kill", "prune", "down"].includes(args[0])), false);

  const missing = await resolveSandboxTarget(owner.id, "33333333-3333-4333-8333-333333333333", "api", docker);
  assert.equal(missing.status, 404);

  const denied = await resolveSandboxTarget(other.id, SANDBOX_ID, "api", docker);
  assert.equal(denied.status, 404);
  assert.equal(denied.container, undefined);
  assert.equal(docker.calls.some((args) => args.includes("run") || args.includes("measurer")), false);

  const foreign = await resolveSandboxTarget(owner.id, OTHER_SANDBOX_ID, "api", docker);
  assert.equal(foreign.status, 404);

  const crossed = await resolveSandboxTarget(owner.id, SANDBOX_ID, "db", docker);
  assert.equal(crossed.status, 409);
  assert.match(crossed.error, /not a verified container/);

  const created = storeSandbox(owner.id, {
    id: "44444444-4444-4444-8444-444444444444",
    projectName: "mmabcdefabcdefabcd",
    status: "created",
    services: { api: null },
  });
  const idle = await resolveSandboxTarget(owner.id, created.id, "api", docker);
  assert.equal(idle.status, 409);
  assert.match(idle.error, /not running/);
});

test("container id operations refuse a raw service name and a mismatched project label", async () => {
  const id = "c".repeat(64);
  const calls = [];
  const docker = createDockerExecutor({
    env: { METRICMANTIS_CHAOS_ENABLED: "true", METRICMANTIS_CHAOS_ALLOWLIST: "api" },
    async execFileImpl(_command, args) {
      calls.push(args);
      if (args[0] === "inspect" && args.includes(id)) {
        return {
          ok: true,
          stdout: JSON.stringify({
            id,
            status: "running",
            health: "healthy",
            project: OWNER_PROJECT,
            service: "api",
          }),
        };
      }
      if (args[0] === "stop") return { ok: true, stdout: id };
      return { ok: false, stderr: "unexpected" };
    },
  });

  const named = await docker.stop("api");
  assert.equal(named.ok, false);
  assert.equal(calls.length, 0);

  const unlabeled = await docker.stop(id);
  assert.equal(unlabeled.ok, false);
  assert.equal(calls.length, 0);

  const mismatched = await docker.stop(id, { id, project: OTHER_PROJECT, service: "api" });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.detail, /labels/);
  assert.equal(calls.some((args) => args[0] === "stop"), false);

  calls.length = 0;
  const stopped = await docker.stop(id, { id, project: OWNER_PROJECT, service: "api" });
  assert.equal(stopped.ok, true);
  assert.deepEqual(calls.at(-1), ["stop", id]);
});
