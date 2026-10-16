const assert = require("node:assert/strict");
const test = require("node:test");
const { createDockerExecutor } = require("./dockerExecutor");
const { approvedChaosAllowlist, localChaosEnvironment } = require("../scripts/localChaos");
const { AUXILIARY_SERVICES } = require("../sandboxes/sandboxRuntime");

const PROJECT = "mm0123456789abcdef";
const OTHER = "mmfedcba9876543210";
const DB_ID = "d".repeat(64);
const FOREIGN_ID = "e".repeat(64);

test("local chaos config enables only the approved sandbox services", () => {
  const names = approvedChaosAllowlist();
  assert.deepEqual(names, ["web-app", "api", "db"]);
  for (const auxiliary of AUXILIARY_SERVICES) {
    assert.equal(names.includes(auxiliary), false);
  }
  const env = localChaosEnvironment({
    METRICMANTIS_CHAOS_ENABLED: "false",
    METRICMANTIS_CHAOS_ALLOWLIST: "web-app",
    SESSION_SECRET: "present",
    GEMINI_API_KEY: "present",
  });
  assert.equal(env.METRICMANTIS_CHAOS_ENABLED, "true");
  assert.equal(env.METRICMANTIS_CHAOS_ALLOWLIST, "web-app,api,db");
  assert.equal(env.SESSION_SECRET, "present");
  assert.equal(env.GEMINI_API_KEY, "present");
  assert.equal(JSON.stringify(env).includes("process.env"), false);
});

test("approved allowlist still refuses raw names, other projects, and auxiliary services", async () => {
  const calls = [];
  let status = "running";
  const docker = createDockerExecutor({
    env: localChaosEnvironment({}),
    async execFileImpl(_command, args) {
      calls.push(args);
      if (args[0] === "version") return { ok: true, stdout: "28" };
      if (args[0] === "inspect") {
        const id = args[args.length - 1];
        const format = String(args[2] || "");
        const project = id === FOREIGN_ID ? OTHER : PROJECT;
        const service = id === DB_ID || id === FOREIGN_ID ? "db" : "web";
        if (format.includes("json")) {
          return {
            ok: true,
            stdout: JSON.stringify({ id, status, health: "healthy", project, service }),
          };
        }
        return { ok: true, stdout: `${status} 0 0 100000 0 2026-10-15T00:00:00.000000000Z` };
      }
      if (args[0] === "stop" || args[0] === "start") {
        if (args[0] === "start") status = "running";
        if (args[0] === "stop") status = "exited";
        return { ok: true, stdout: args[args.length - 1] };
      }
      return { ok: false, stderr: "unexpected" };
    },
  });

  const caps = await docker.capabilities();
  assert.equal(caps.chaosEnabled, true);
  assert.deepEqual(caps.allowlist, ["web-app", "api", "db"]);
  assert.equal(caps.allowlist.includes("measurer"), false);

  calls.length = 0;
  const named = await docker.stop("db");
  assert.equal(named.ok, false);
  assert.equal(calls.length, 0);

  const auxiliary = await docker.stop("f".repeat(64), {
    id: "f".repeat(64),
    project: PROJECT,
    service: "measurer",
  });
  assert.equal(auxiliary.ok, false);
  assert.match(auxiliary.detail, /not approved/);
  assert.equal(calls.length, 0);

  const wrongId = await docker.stop(DB_ID, { id: FOREIGN_ID, project: PROJECT, service: "db" });
  assert.equal(wrongId.ok, false);
  assert.equal(calls.length, 0);

  const otherProject = await docker.stop(FOREIGN_ID, { id: FOREIGN_ID, project: PROJECT, service: "db" });
  assert.equal(otherProject.ok, false);
  assert.match(otherProject.detail, /labels/);
  assert.equal(calls.some((args) => args[0] === "stop"), false);

  calls.length = 0;
  status = "running";
  const stopped = await docker.stop(DB_ID, { id: DB_ID, project: PROJECT, service: "db" });
  assert.equal(stopped.ok, true);
  assert.deepEqual(calls.filter((args) => args[0] === "stop").map((args) => args[1]), [DB_ID]);
  assert.equal(calls.some((args) => args.includes("prune") || args.includes("--rmi")), false);

  calls.length = 0;
  status = "exited";
  const restored = await docker.restoreService(DB_ID, { id: DB_ID, project: PROJECT, service: "db" });
  assert.equal(restored.ok, true);
  assert.deepEqual(calls.filter((args) => args[0] === "start").map((args) => args[1]), [DB_ID]);
  assert.equal(calls.some((args) => args[0] === "stop" || args.includes("prune")), false);
});
