const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const test = require("node:test");

const dbPath = path.join(os.tmpdir(), `metricmantis-sandboxes-${process.pid}.db`);
process.env.METRICMANTIS_DB_PATH = dbPath;

const { initDatabase } = require("../database/database");
const userRepository = require("../database/userRepository");
const repository = require("../database/sandboxRepository");
const requireAuth = require("../middleware/requireAuth");
const sandboxRoutes = require("../routes/sandboxRoutes");
const {
  createSandboxRecord,
  getSandboxRecord,
  readSandboxRuntime,
  startSandbox,
  cleanupSandboxRecord,
} = require("./sandboxService");
const { APPROVED_COMPOSE_FILE } = require("./sandboxRuntime");

const SAMPLE = `services:
  web-app:
    image: nginx:alpine
  api:
    image: node:20-alpine
`;

function resetDb() {
  initDatabase();
  const { getDatabase } = require("../database/database");
  getDatabase().exec("DELETE FROM sandboxes; DELETE FROM users;");
}

function user(username) {
  return userRepository.createUser({
    username,
    email: `${username}@example.com`,
    passwordHash: "hash",
  });
}

function idleExec() {
  return async (_command, args) => {
    if (args[0] === "version" || (args[0] === "compose" && args[1] === "version")) {
      return { ok: true, stdout: "28", stderr: "" };
    }
    if (args[0] === "ps") return { ok: true, stdout: "", stderr: "" };
    return { ok: false, stdout: "", stderr: "unexpected docker command" };
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("sandbox records are created, owned, and closed without Docker", async (t) => {
  resetDb();
  const serviceSource = fs.readFileSync(__filename.replace("sandbox.test.js", "sandboxService.js"), "utf8");
  const routeSource = fs.readFileSync(path.join(__dirname, "..", "routes", "sandboxRoutes.js"), "utf8");
  assert.equal(/compose up|docker stop|docker compose|spawn\(/.test(serviceSource + routeSource), false);

  const owner = user("sandbox-owner");
  const other = user("sandbox-other");
  const created = createSandboxRecord(owner.id, { composeYaml: SAMPLE, fileName: "sample.yml" });
  assert.equal(created.status, 201);
  assert.equal(created.sandbox.status, "created");
  assert.equal(created.sandbox.startedAt, null);
  assert.equal(created.sandbox.services["web-app"], null);
  assert.equal(created.sandbox.services.api, null);
  assert.equal(Object.hasOwn(created.sandbox, "composeYaml"), false);
  assert.match(created.sandbox.projectName, /^mm[a-f0-9]{16}$/);

  const repeat = createSandboxRecord(owner.id, { composeYaml: SAMPLE, fileName: "sample.yml" });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.sandbox.id, created.sandbox.id);

  const replaced = createSandboxRecord(owner.id, {
    composeYaml: "services:\n  db:\n    image: mysql:8.0\n",
  });
  assert.equal(replaced.status, 201);
  assert.notEqual(replaced.sandbox.id, created.sandbox.id);
  assert.equal(getSandboxRecord(owner.id, created.sandbox.id).status, "stopped");
  assert.equal(getSandboxRecord(other.id, replaced.sandbox.id), null);

  const idle = { execFileImpl: idleExec() };
  const closed = await cleanupSandboxRecord(owner.id, replaced.sandbox.id, idle);
  assert.equal(closed.status, 200);
  assert.equal(closed.sandbox.status, "stopped");
  assert.equal(closed.sandbox.stoppedAt == null, false);
  const again = await cleanupSandboxRecord(owner.id, replaced.sandbox.id, idle);
  assert.equal(again.status, 200);
  assert.equal(again.sandbox.status, "stopped");
  assert.equal(again.sandbox.stoppedAt, closed.sandbox.stoppedAt);
  assert.equal((await cleanupSandboxRecord(other.id, replaced.sandbox.id, idle)).status, 404);

  const running = repository.createSandbox({
    id: "running-record",
    userId: owner.id,
    projectName: "mmrunningrecord01",
    status: "running",
    composeSha256: "abc",
    composeYaml: SAMPLE,
    fileName: null,
    services: { api: null },
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  });
  const refused = await cleanupSandboxRecord(owner.id, running.id, idle);
  assert.equal(refused.status, 409);
  assert.equal(refused.sandbox.status, "running");
  assert.match(refused.error, /did not change containers/);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const header = req.headers["x-test-user"];
    req.session = header ? { user: { userId: Number(header) } } : {};
    next();
  });
  app.use("/sandboxes", requireAuth, sandboxRoutes);
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const anonymous = await fetch(`${base}/sandboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ composeYaml: SAMPLE }),
  });
  assert.equal(anonymous.status, 401);

  const response = await fetch(`${base}/sandboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": String(owner.id) },
    body: JSON.stringify({ composeYaml: SAMPLE }),
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /already starting or running/);
  assert.equal(body.sandbox.id, running.id);
  assert.equal(body.sandbox.status, "running");
  assert.equal(JSON.stringify(body).includes("nginx:alpine"), false);

  const active = await fetch(`${base}/sandboxes/active`, {
    headers: { "x-test-user": String(owner.id) },
  });
  const activeBody = await active.json();
  assert.equal(active.status, 200);
  assert.equal(activeBody.sandbox.id, running.id);
  const otherActive = await fetch(`${base}/sandboxes/active`, {
    headers: { "x-test-user": String(other.id) },
  });
  const otherActiveBody = await otherActive.json();
  assert.equal(otherActiveBody.sandbox, null);

  const anonymousStart = await fetch(`${base}/sandboxes/${running.id}/start`, { method: "POST" });
  assert.equal(anonymousStart.status, 401);
});

const CONTAINER_ID = "a".repeat(64);
const API_ID = "b".repeat(64);
const DB_ID = "c".repeat(64);
const SAMPLE_IDS = {
  [CONTAINER_ID]: "web-app",
  [API_ID]: "api",
  [DB_ID]: "db",
};
const MALICIOUS = `services:
  web:
    image: evil:latest
    privileged: true
    container_name: db
    ports:
      - "3000:80"
`;

function scriptedDocker() {
  const calls = [];
  const state = {
    ids: [],
    health: "healthy",
    project: null,
    inspectProject: null,
    service: "web-app",
    upOk: true,
    downOk: true,
    clearOnDown: true,
  };
  const execFileImpl = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "version") return { ok: true, stdout: "28", stderr: "" };
    if (args[0] === "compose" && args[1] === "version") return { ok: true, stdout: "2", stderr: "" };
    const projectFlag = args.indexOf("-p");
    if (projectFlag !== -1) state.project = args[projectFlag + 1];
    if (args.includes("up")) {
      if (state.upOk) state.ids = Object.keys(SAMPLE_IDS);
      return { ok: state.upOk, stdout: "", stderr: "" };
    }
    if (args[0] === "ps") return { ok: true, stdout: state.ids.join("\n"), stderr: "" };
    if (args[0] === "inspect") {
      const id = args[args.length - 1];
      return {
        ok: true,
        stdout: JSON.stringify({
          id,
          status: "running",
          health: state.health,
          project: state.inspectProject || state.project,
          service: SAMPLE_IDS[id] || state.service,
        }),
        stderr: "",
      };
    }
    if (args.includes("down")) {
      if (state.downOk && state.clearOnDown) state.ids = [];
      return { ok: state.downOk, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected docker command" };
  };
  return { calls, state, execFileImpl, sleep: async () => {} };
}

test("approved sandbox start and cleanup never execute uploaded YAML", async () => {
  resetDb();
  const approved = fs.readFileSync(APPROVED_COMPOSE_FILE, "utf8");
  assert.equal(/privileged:|container_name:|network_mode:|volumes:|ports:/.test(approved), false);
  assert.match(approved, /web-app:/);
  assert.match(approved, /api:/);
  assert.match(approved, /db:/);
  assert.match(approved, /pg_isready/);
  assert.match(approved, /service_healthy/);

  const owner = user("sandbox-runner");
  const other = user("sandbox-stranger");
  const created = createSandboxRecord(owner.id, { composeYaml: MALICIOUS, fileName: "evil.yml" });
  const docker = scriptedDocker();
  const deps = { execFileImpl: docker.execFileImpl, sleep: docker.sleep };

  const started = await startSandbox(owner.id, created.sandbox.id, deps);
  assert.equal(started.status, 200);
  assert.equal(started.sandbox.status, "running");
  assert.equal(started.sandbox.services["web-app"], CONTAINER_ID);
  assert.equal(started.sandbox.services.api, API_ID);
  assert.equal(started.sandbox.services.db, DB_ID);
  assert.equal(started.sandbox.startedAt == null, false);
  assert.equal(JSON.stringify(started).includes("evil:latest"), false);
  assert.equal(JSON.stringify(started).includes("sample-sandbox"), false);
  assert.equal(docker.calls.some((args) => args.includes(APPROVED_COMPOSE_FILE) && args.includes("up")), true);
  assert.equal(docker.calls.some((args) => args.includes("--no-build")), false);
  assert.equal(docker.calls.some((args) => args.some((arg) => String(arg).includes("evil") || String(arg).includes("privileged"))), false);
  assert.equal(docker.calls.some((args) => args.includes("--rmi") || args.includes("-v")), false);

  const missing = await startSandbox(other.id, created.sandbox.id, deps);
  assert.equal(missing.status, 404);
  const again = await startSandbox(owner.id, created.sandbox.id, deps);
  assert.equal(again.status, 409);
  assert.equal(again.sandbox.status, "running");

  const ups = () => docker.calls.filter((args) => args.includes("up")).length;
  const upsBefore = ups();
  const active = repository.createSandbox({
    id: "second-created",
    userId: owner.id,
    projectName: "mm0123456789abcdef",
    status: "created",
    composeSha256: "different",
    composeYaml: SAMPLE,
    fileName: null,
    services: { web: null },
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  });
  const blocked = await startSandbox(owner.id, active.id, deps);
  assert.equal(blocked.status, 409);
  assert.match(blocked.error, /already starting or running/);
  assert.equal(blocked.sandbox.id, created.sandbox.id);
  assert.equal(blocked.sandbox.status, "running");
  assert.equal(getSandboxRecord(owner.id, active.id).status, "created");
  assert.equal(ups(), upsBefore);
  const blockedCreate = createSandboxRecord(owner.id, { composeYaml: `${SAMPLE}\n# still-running\n` });
  assert.equal(blockedCreate.status, 409);
  assert.equal(blockedCreate.sandbox.id, created.sandbox.id);
  assert.equal(JSON.stringify(blockedCreate).includes("composeYaml"), false);

  const stopped = await cleanupSandboxRecord(owner.id, created.sandbox.id, deps);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.sandbox.status, "stopped");
  assert.equal(stopped.sandbox.services["web-app"], null);
  assert.equal(stopped.sandbox.services.api, null);
  assert.equal(stopped.sandbox.services.db, null);
  const downs = () => docker.calls.filter((args) => args.includes("down")).length;
  const downsAfterStop = downs();
  const repeated = await cleanupSandboxRecord(owner.id, created.sandbox.id, deps);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.sandbox.status, "stopped");
  assert.equal(downs(), downsAfterStop);

  const fresh = createSandboxRecord(owner.id, { composeYaml: MALICIOUS });
  docker.state.health = "starting";
  const unhealthy = await startSandbox(owner.id, fresh.sandbox.id, deps);
  assert.equal(unhealthy.sandbox.status, "failed");
  assert.match(unhealthy.sandbox.error, /did not become healthy/);
  assert.equal(unhealthy.sandbox.services.web == null, true);
  assert.equal(docker.calls.some((args) => args.includes("down")), true);

  const mismatched = createSandboxRecord(owner.id, { composeYaml: `${MALICIOUS}\n# mismatch\n` });
  const downsBeforeMismatch = downs();
  docker.state.health = "healthy";
  docker.state.inspectProject = "other-project";
  const mismatch = await startSandbox(owner.id, mismatched.sandbox.id, deps);
  assert.equal(mismatch.sandbox.status, "failed");
  assert.match(mismatch.sandbox.error, /did not match this sandbox project/);
  assert.equal(downs(), downsBeforeMismatch);
  assert.equal(JSON.stringify(mismatch.sandbox.services).includes(CONTAINER_ID), false);

  const cleanupTarget = createSandboxRecord(owner.id, { composeYaml: `${MALICIOUS}\n# cleanup-fail\n` });
  docker.state.inspectProject = null;
  const running = await startSandbox(owner.id, cleanupTarget.sandbox.id, deps);
  assert.equal(running.sandbox.status, "running");
  docker.state.downOk = false;
  docker.state.clearOnDown = false;
  const failedCleanup = await cleanupSandboxRecord(owner.id, cleanupTarget.sandbox.id, deps);
  assert.equal(failedCleanup.status, 502);
  assert.equal(failedCleanup.sandbox.status, "failed");
  assert.notEqual(failedCleanup.sandbox.status, "stopped");
});

test("concurrent start attempts claim one sandbox", async () => {
  resetDb();
  const owner = user("sandbox-race");
  const created = createSandboxRecord(owner.id, { composeYaml: SAMPLE });
  const docker = scriptedDocker();
  let waiting = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const execFileImpl = async (command, args) => {
    if (args[0] === "version") {
      waiting += 1;
      if (waiting === 2) release();
      await gate;
    }
    return docker.execFileImpl(command, args);
  };
  const [first, second] = await Promise.all([
    startSandbox(owner.id, created.sandbox.id, { execFileImpl, sleep: async () => {} }),
    startSandbox(owner.id, created.sandbox.id, { execFileImpl, sleep: async () => {} }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(docker.calls.filter((args) => args.includes("up")).length, 1);
});

function runtimeExec(options) {
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push([...args]);
    if (options.failDocker) return { ok: false, stdout: "", stderr: "docker unavailable" };
    if (args[0] === "version") return { ok: true, stdout: "28", stderr: "" };
    if (args[0] === "compose" && args[1] === "version") return { ok: true, stdout: "2", stderr: "" };
    if (args[0] === "ps") return { ok: true, stdout: (options.ids || []).join("\n"), stderr: "" };
    if (args[0] === "inspect") {
      const id = args[args.length - 1];
      const row = options.inspect?.[id];
      if (!row) return { ok: false, stdout: "", stderr: "missing" };
      return { ok: true, stdout: JSON.stringify({ id, ...row }), stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected docker command" };
  };
  return { calls, execFileImpl };
}

test("runtime status is owner scoped and comes from project inspection", async () => {
  resetDb();
  const owner = user("sandbox-runtime");
  const other = user("sandbox-runtime-other");
  const project = "mm0123456789abcdef";
  const stored = repository.createSandbox({
    id: "runtime-sandbox",
    userId: owner.id,
    projectName: project,
    status: "running",
    composeSha256: "runtime",
    composeYaml: "services:\n  web:\n    image: secret-compose-marker\n",
    fileName: null,
    services: { web: CONTAINER_ID, api: null },
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  });
  assert.equal(stored.status, "running");

  const denied = await readSandboxRuntime(other.id, stored.id, runtimeExec({}));
  assert.equal(denied.status, 404);

  const healthy = runtimeExec({
    ids: [CONTAINER_ID],
    inspect: {
      [CONTAINER_ID]: { status: "running", health: "healthy", project, service: "web" },
    },
  });
  const observed = await readSandboxRuntime(owner.id, stored.id, healthy);
  assert.equal(observed.status, 200);
  assert.equal(observed.sandbox.status, "running");
  const web = observed.runtime.services.find((service) => service.service === "web");
  const api = observed.runtime.services.find((service) => service.service === "api");
  assert.equal(web.display, "healthy");
  assert.equal(web.health, "healthy");
  assert.equal(web.verified, true);
  assert.equal(web.containerId, CONTAINER_ID);
  assert.equal(api.display, "unknown");
  assert.equal(api.verified, false);
  assert.equal(JSON.stringify(observed).includes("secret-compose-marker"), false);
  assert.equal(JSON.stringify(observed).includes("composeYaml"), false);
  assert.equal(healthy.calls.some((args) => args.some((arg) => /^(up|down|stop|rm|kill|prune)$/.test(arg))), false);
  assert.equal(getSandboxRecord(owner.id, stored.id).status, "running");

  const noHealth = await readSandboxRuntime(owner.id, stored.id, runtimeExec({
    ids: [CONTAINER_ID],
    inspect: { [CONTAINER_ID]: { status: "running", health: "", project, service: "web" } },
  }));
  const running = noHealth.runtime.services.find((service) => service.service === "web");
  assert.equal(running.state, "running");
  assert.equal(running.health, "unknown");
  assert.equal(running.display, "running");

  const sick = await readSandboxRuntime(owner.id, stored.id, runtimeExec({
    ids: [CONTAINER_ID],
    inspect: { [CONTAINER_ID]: { status: "running", health: "unhealthy", project, service: "web" } },
  }));
  assert.equal(sick.runtime.services.find((service) => service.service === "web").display, "unhealthy");

  const exited = await readSandboxRuntime(owner.id, stored.id, runtimeExec({
    ids: [CONTAINER_ID],
    inspect: { [CONTAINER_ID]: { status: "exited", health: "", project, service: "web" } },
  }));
  assert.equal(exited.runtime.services.find((service) => service.service === "web").display, "exited");

  const missing = await readSandboxRuntime(owner.id, stored.id, runtimeExec({ ids: [], inspect: {} }));
  const gone = missing.runtime.services.find((service) => service.service === "web");
  assert.equal(gone.display, "unknown");
  assert.equal(gone.containerId, null);
  assert.equal(gone.verified, false);
  assert.equal(missing.error, null);

  const mismatched = await readSandboxRuntime(owner.id, stored.id, runtimeExec({
    ids: [CONTAINER_ID],
    inspect: {
      [CONTAINER_ID]: { status: "running", health: "healthy", project: "other-project", service: "web" },
    },
  }));
  const foreign = mismatched.runtime.services.find((service) => service.service === "web");
  assert.equal(foreign.display, "unknown");
  assert.equal(foreign.health, "unknown");
  assert.equal(foreign.verified, false);
  assert.equal(foreign.containerId, null);
  assert.match(mismatched.error, /did not match this sandbox project/);
  assert.equal(JSON.stringify(mismatched).includes("other-project"), false);

  const duplicateId = "b".repeat(64);
  const duplicate = await readSandboxRuntime(owner.id, stored.id, runtimeExec({
    ids: [CONTAINER_ID, duplicateId],
    inspect: {
      [CONTAINER_ID]: { status: "running", health: "healthy", project, service: "web" },
      [duplicateId]: { status: "running", health: "healthy", project, service: "web" },
    },
  }));
  assert.equal(duplicate.runtime.services.find((service) => service.service === "web").verified, false);
  assert.match(duplicate.error, /unexpected container/);

  const invalid = repository.createSandbox({
    id: "runtime-invalid",
    userId: owner.id,
    projectName: "mmrunningrecord01",
    status: "running",
    composeSha256: "bad",
    composeYaml: "services:\n  web:\n    image: secret-compose-marker\n",
    fileName: null,
    services: { web: CONTAINER_ID },
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  });
  const refused = await readSandboxRuntime(owner.id, invalid.id, runtimeExec({}));
  assert.equal(refused.status, 409);
  assert.equal(refused.sandbox.status, "running");

  const offline = await readSandboxRuntime(owner.id, stored.id, runtimeExec({ failDocker: true }));
  assert.equal(offline.status, 503);
  assert.equal(getSandboxRecord(owner.id, stored.id).status, "running");

  const app = express();
  app.use(express.json());
  app.set("sandboxDeps", { execFileImpl: runtimeExec({
    ids: [CONTAINER_ID],
    inspect: { [CONTAINER_ID]: { status: "running", health: "healthy", project, service: "web" } },
  }).execFileImpl });
  app.use((req, _res, next) => {
    const header = req.headers["x-test-user"];
    req.session = header ? { user: { userId: Number(header) } } : {};
    next();
  });
  app.use("/sandboxes", requireAuth, sandboxRoutes);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const anonymous = await fetch(`${base}/sandboxes/${stored.id}/runtime`);
  assert.equal(anonymous.status, 401);
  const stranger = await fetch(`${base}/sandboxes/${stored.id}/runtime`, {
    headers: { "x-test-user": String(other.id) },
  });
  assert.equal(stranger.status, 404);
  const response = await fetch(`${base}/sandboxes/${stored.id}/runtime`, {
    headers: { "x-test-user": String(owner.id) },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.runtime.services.find((service) => service.service === "web").display, "healthy");
  assert.equal(JSON.stringify(body).includes("secret-compose-marker"), false);
  await new Promise((resolve) => server.close(resolve));
});
