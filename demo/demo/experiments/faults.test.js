const assert = require("node:assert/strict");
const test = require("node:test");
const { createDockerExecutor } = require("./dockerExecutor");

const PROJECT = "mm0123456789abcdef";
const ID = "a".repeat(64);
const SIDECAR = "b".repeat(64);
const expected = { id: ID, project: PROJECT, service: "api" };

function executor(script, options = {}) {
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    return script(args, calls);
  };
  return {
    calls,
    docker: createDockerExecutor({
      execFileImpl,
      ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
      env: { METRICMANTIS_CHAOS_ENABLED: "true", METRICMANTIS_CHAOS_ALLOWLIST: "api,web-app" },
    }),
  };
}

test("memory pressure rejects raw names, foreign labels, and oversized files", async () => {
  const { docker, calls } = executor((args) => {
    if (args[0] === "inspect" && args.includes(ID)) {
      if (String(args[2] || "").includes("Memory")) return { ok: true, stdout: String(64 * 1024 * 1024) };
      return {
        ok: true,
        stdout: JSON.stringify({ id: ID, status: "running", health: "healthy", project: PROJECT, service: "api" }),
      };
    }
    if (args[0] === "exec" && args.includes("wc")) return { ok: true, stdout: `${8 * 1024 * 1024} /dev/shm/mm-memory-pressure` };
    if (args[0] === "exec") return { ok: true, stdout: "" };
    return { ok: false, stdout: "", stderr: "unexpected" };
  });
  const named = await docker.applyMemory("api", expected, 8);
  assert.equal(named.ok, false);
  assert.equal(calls.length, 0);

  const foreign = await docker.applyMemory(ID, { ...expected, project: "mmfedcba9876543210" }, 8);
  assert.equal(foreign.ok, false);
  assert.equal(calls.some((args) => args[0] === "exec"), false);

  const applied = await docker.applyMemory(ID, expected, 8);
  assert.equal(applied.verified, true);
  const command = calls.find((args) => args.some((arg) => String(arg).includes("dd if=/dev/zero")));
  assert.ok(command);
  assert.equal(command.join(" ").includes("docker.sock"), false);
  assert.match(command.join(" "), /count=8/);

  calls.length = 0;
  const cleared = await docker.clearMemory(ID, expected);
  assert.equal(cleared.ok, true);
  assert.equal(calls.some((args) => args.includes("prune")), false);
});

function netemScript(overrides = {}) {
  return (args) => {
    if (args[0] === "inspect" && args.includes(ID) && String(args[2] || "").includes("State")) {
      return {
        ok: true,
        stdout: JSON.stringify({ id: ID, status: "running", health: "healthy", project: PROJECT, service: "api" }),
      };
    }
    if (args[0] === "image") return { ok: true, stdout: "sha256:image" };
    if (args[0] === "run" && args.includes("route")) {
      return { ok: true, stdout: overrides.route || "default via 172.25.0.1 dev eth0" };
    }
    if (args[0] === "run" && args.includes("-d")) return { ok: true, stdout: SIDECAR };
    if (args[0] === "inspect" && args.includes(SIDECAR) && String(args[2] || "").includes("State.Status")) {
      return { ok: true, stdout: overrides.status || "running" };
    }
    if (args[0] === "exec" && args.includes("qdisc")) {
      return { ok: true, stdout: overrides.qdisc || "qdisc netem 1: root refcnt 2 limit 1000 delay 100ms" };
    }
    if (args[0] === "inspect" && String(args[2] || "").includes("NetworkMode")) {
      const attachedTo = overrides.networkMode === undefined ? `container:${ID}` : overrides.networkMode;
      return { ok: overrides.networkModeOk !== false, stdout: attachedTo, stderr: overrides.networkModeOk === false ? "inspect failed" : "" };
    }
    if (args[0] === "exec" && args.includes("readlink")) {
      if (overrides.readlinkOk === false && args.includes(ID)) {
        return { ok: false, stdout: "", stderr: overrides.readlinkError || "timed out" };
      }
      const ns = args.includes(SIDECAR) ? (overrides.sideNs || "net:[4026533782]") : (overrides.targetNs || "net:[4026533782]");
      return { ok: true, stdout: ns };
    }
    if (args[0] === "inspect" && args.includes(SIDECAR)) {
      return {
        ok: true,
        stdout: JSON.stringify({ id: SIDECAR, fault: "netem", project: PROJECT, target: ID }),
      };
    }
    if (args[0] === "stop" || args[0] === "rm") return { ok: true, stdout: SIDECAR };
    if (args[0] === "run" && args.includes("show")) return { ok: true, stdout: overrides.cleanup || "qdisc noqueue 0: root refcnt 2" };
    if (args[0] === "run" && args.includes("del")) return { ok: true, stdout: "" };
    return { ok: false, stdout: "", stderr: "unexpected" };
  };
}

test("netem sidecar is scoped to the verified container and is not privileged", async () => {
  const { docker, calls } = executor(netemScript());
  const applied = await docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(applied.verified, true);
  assert.match(applied.detail, /dev eth0 reported delay 100ms/);
  const run = calls.find((args) => args[0] === "run" && args.includes("-d"));
  assert.equal(run.includes("--privileged"), false);
  assert.equal(run.includes("docker.sock"), false);
  assert.equal(run.includes(`container:${ID}`), true);
  assert.equal(run.includes("NET_ADMIN"), true);
  assert.equal(run.includes("metricmantis-sandbox-netem:approved"), true);
  assert.equal(run.some((arg) => arg.includes("MM_DELAY_MS=100")), true);
  const show = calls.find((args) => args[0] === "exec" && args.includes("qdisc"));
  assert.deepEqual(show.slice(-3), ["show", "dev", "eth0"]);
  assert.equal(show[1], SIDECAR);

  const cleared = await docker.clearNetem(ID, expected, SIDECAR);
  assert.equal(cleared.ok, true);
  assert.equal(calls.some((args) => args[0] === "rm" && args.includes(ID)), false);
  assert.equal(calls.some((args) => args.includes("del") && args.includes(ID)), false);
});

test("netem verification accepts the precise delay and rejects a missing or different rule", async () => {
  const decimal = executor(netemScript({
    qdisc: "qdisc netem 1: root refcnt 2 limit 1000 delay 100.0ms",
  }), { sleepImpl: async () => {} });
  const shown = await decimal.docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(shown.verified, true);

  const missing = executor(netemScript({ qdisc: "qdisc noqueue 0: root refcnt 2" }), { sleepImpl: async () => {} });
  const absent = await missing.docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(absent.verified, false);
  assert.match(absent.detail, /did not report delay 100ms/);
  assert.match(absent.detail, /noqueue/);
  assert.equal(missing.calls.some((args) => args[0] === "stop" && args.includes(SIDECAR)), true);
  assert.equal(missing.calls.some((args) => args[0] === "rm" && args.includes(ID)), false);

  const wrongValue = executor(netemScript({
    qdisc: "qdisc netem 1: root refcnt 2 limit 1000 delay 1000ms",
  }), { sleepImpl: async () => {} });
  const mismatched = await wrongValue.docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(mismatched.verified, false);
  assert.match(mismatched.detail, /Observed: qdisc netem/);
});

test("packet loss is verified only when tc qdisc show reports that loss", async () => {
  const exact = executor(netemScript({
    qdisc: "qdisc netem 1: root refcnt 2 limit 1000 loss 5%",
  }), { sleepImpl: async () => {} });
  const applied = await exact.docker.applyNetem(ID, expected, { lossPercent: 5 });
  assert.equal(applied.verified, true);
  assert.match(applied.detail, /reported loss 5%/);
  const run = exact.calls.find((args) => args[0] === "run" && args.includes("-d"));
  assert.equal(run.some((arg) => arg.includes("MM_LOSS_PERCENT=5")), true);
  assert.equal(run.some((arg) => arg.includes("MM_DELAY_MS=0")), true);

  const decimal = executor(netemScript({
    qdisc: "qdisc netem 1: root refcnt 2 limit 1000 loss 5.0%",
  }), { sleepImpl: async () => {} });
  const shown = await decimal.docker.applyNetem(ID, expected, { lossPercent: 5 });
  assert.equal(shown.verified, true);

  const different = executor(netemScript({
    qdisc: "qdisc netem 1: root refcnt 2 limit 1000 loss 15%",
  }), { sleepImpl: async () => {} });
  const rejected = await different.docker.applyNetem(ID, expected, { lossPercent: 5 });
  assert.equal(rejected.verified, false);
  assert.match(rejected.detail, /did not report loss 5%/);
  assert.match(rejected.detail, /loss 15%/);
  assert.equal(different.calls.some((args) => args[0] === "stop" && args.includes(SIDECAR)), true);
  assert.equal(different.calls.some((args) => args[0] === "rm" && args.includes(ID)), false);
});

test("netem is not installed on a non-eth0 route and a foreign namespace is removed", async () => {
  const otherIface = executor(netemScript({ route: "default via 10.0.0.1 dev eth1" }));
  const blocked = await otherIface.docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail, /not eth0/);
  assert.equal(otherIface.calls.some((args) => args.includes("-d")), false);

  const foreignNs = executor(netemScript({ sideNs: "net:[9]" }), { sleepImpl: async () => {} });
  const rejected = await foreignNs.docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(rejected.verified, false);
  assert.match(rejected.detail, /not in the verified container network namespace/);
  assert.equal(foreignNs.calls.some((args) => args[0] === "stop" && args.includes(SIDECAR)), true);
  assert.equal(foreignNs.calls.some((args) => args[0] === "rm" && args.includes(ID)), false);

  const unreadable = executor(netemScript({ readlinkOk: false, readlinkError: "timed out" }), { sleepImpl: async () => {} });
  const unread = await unreadable.docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(unread.verified, false);
  assert.match(unread.detail, /could not be read/);
  assert.equal(/not in the verified container network namespace/.test(unread.detail), false);
  assert.equal(unreadable.calls.some((args) => args[0] === "stop" && args.includes(SIDECAR)), true);
  assert.equal(unreadable.calls.some((args) => args[0] === "rm" && args.includes(ID)), false);

  const detached = executor(netemScript({ networkMode: "bridge" }), { sleepImpl: async () => {} });
  const loose = await detached.docker.applyNetem(ID, expected, { delayMs: 100 });
  assert.equal(loose.verified, false);
  assert.match(loose.detail, /not attached to the verified container network namespace/);
  assert.equal(detached.calls.some((args) => args[0] === "stop" && args.includes(SIDECAR)), true);
  assert.equal(detached.calls.some((args) => args.includes("readlink")), false);

  const cleared = await foreignNs.docker.clearNetem(ID, expected, SIDECAR);
  assert.equal(cleared.ok, true);
  assert.equal(foreignNs.calls.some((args) => args[0] === "del" || (args.includes("del") && args.includes(ID))), false);
});
