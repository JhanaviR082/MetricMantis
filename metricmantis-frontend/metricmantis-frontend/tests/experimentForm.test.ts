import assert from "node:assert/strict";
import test from "node:test";
import { chaosStatusText, measuredFaultSupport, measuredSandboxGate, validateMeasuredForm, verifiedSandboxTargets } from "../src/lib/experimentForm";

const base = {
  target: "mmcpu-check",
  fault: "measure" as const,
  probeUrl: "http://127.0.0.1:18083/",
  hypothesis: "Check the probe.",
  baselineMs: 2000,
  faultDurationMs: 2000,
  recoveryMs: 2000,
  ratePerSecond: 5,
  concurrency: 1,
  timeoutMs: 1000,
  maxErrorRatePercent: 5,
  maxP95Ms: 1000,
  recoveryTimeoutMs: 5000,
  executable: true,
  blockedReason: "",
};

test("chaos status text comes from the connected API response", () => {
  assert.equal(
    chaosStatusText(null, "http://localhost:3001"),
    "Chaos status is unavailable from http://localhost:3001.",
  );
  assert.equal(
    chaosStatusText({ chaosEnabled: false, allowlist: [], startupMode: "normal" }, "http://localhost:3001"),
    "Connected to http://localhost:3001. Real chaos is off. Allowlist: none. Mode: normal.",
  );
  assert.equal(
    chaosStatusText(
      { chaosEnabled: true, allowlist: ["web-app", "api", "db"], startupMode: "chaos" },
      "http://localhost:3001",
    ),
    "Connected to http://localhost:3001. Real chaos is on. Allowlist: web-app, api, db. Mode: chaos.",
  );
});

test("measure-only probes web-app and api inside the sandbox and skips db", () => {
  const caps = {
    dockerAvailable: true,
    chaosEnabled: false,
    allowlist: [],
    latency: false,
    packetLoss: false,
    networkFaultReason: "Latency and packet loss need Linux traffic control.",
  };
  const measure = measuredFaultSupport("measure", caps, "api");
  assert.equal(measure.executable, true);
  assert.match(measure.reason, /No fault is injected/);
  assert.equal(measuredFaultSupport("measure", caps, "db").executable, false);
  const latency = measuredFaultSupport("latency", caps, "api");
  assert.equal(latency.executable, false);
  assert.match(latency.reason, /Linux traffic control/);
  assert.equal(measuredFaultSupport("cpu", caps, "api").executable, false);
});

test("verified sandbox targets ignore uploaded names and missing containers", () => {
  const targets = verifiedSandboxTargets([
    { service: "api", verified: true, containerId: "a".repeat(64) },
    { service: "web-app", verified: false, containerId: null },
    { service: "db", verified: true, containerId: "not-an-id" },
  ]);
  assert.deepEqual(targets.map((target) => target.service), ["api"]);

  const missing = measuredSandboxGate({
    sandbox: null,
    runtimeKnown: false,
    runtimeError: null,
    verifiedTargets: [],
    selected: "api",
  });
  assert.equal(missing.phase, "empty");
  assert.equal(missing.ready, false);

  const ready = measuredSandboxGate({
    sandbox: { projectName: "mm0123456789abcdef", status: "running" },
    runtimeKnown: true,
    runtimeError: null,
    verifiedTargets: targets,
    selected: "api",
  });
  assert.equal(ready.ready, true);

  const other = measuredSandboxGate({
    sandbox: { projectName: "mm0123456789abcdef", status: "running" },
    runtimeKnown: true,
    runtimeError: null,
    verifiedTargets: targets,
    selected: "web-app",
  });
  assert.equal(other.ready, false);
  assert.equal(other.phase, "unavailable");
});

test("approved services are selectable, while db has no HTTP probe", () => {
  const caps = {
    dockerAvailable: true,
    chaosEnabled: true,
    allowlist: ["web-app", "api", "db"],
    stop: true,
    restart: true,
    cpu: true,
    memory: true,
    latency: true,
    packetLoss: true,
    networkFaultReason: "ready",
  };
  assert.equal(measuredFaultSupport("measure", caps, "web-app").executable, true);
  assert.equal(measuredFaultSupport("measure", caps, "api").executable, true);
  assert.equal(measuredFaultSupport("measure", caps, "db").executable, false);
  const stopDb = measuredFaultSupport("stop", caps, "db");
  assert.equal(stopDb.executable, true);
  assert.match(stopDb.reason, /no approved HTTP health endpoint/);
  assert.equal(measuredFaultSupport("stop", caps, "measurer").executable, false);
  assert.match(measuredFaultSupport("stop", caps, "measurer").reason, /allowlist/);
});

test("cpu is executable only for an allowlisted target when chaos is on", () => {
  const caps = {
    dockerAvailable: true,
    chaosEnabled: true,
    allowlist: ["mmcpu-check"],
    stop: true,
    restart: true,
    cpu: true,
    cpuQuota: 5000,
    cpuPeriod: 100000,
    networkFaultReason: "unused",
  };
  assert.equal(measuredFaultSupport("memory", caps, "mmcpu-check").executable, true);
  assert.equal(measuredFaultSupport("latency", { ...caps, latency: true }, "mmcpu-check").executable, true);
  assert.equal(measuredFaultSupport("latency", { ...caps, latency: false }, "mmcpu-check").executable, false);
  assert.equal(measuredFaultSupport("cpu", caps, "mmcpu-check").executable, true);
  assert.equal(measuredFaultSupport("cpu", caps, "web-app").executable, false);
  assert.match(measuredFaultSupport("cpu", caps, "mmcpu-check").reason, /5000\/100000/);
});

test("form validation rejects out-of-range durations and unsupported faults", () => {
  assert.equal(validateMeasuredForm(base).error, null);
  assert.match(validateMeasuredForm({ ...base, baselineMs: 50 }).error || "", /baselineMs/);
  assert.match(validateMeasuredForm({ ...base, ratePerSecond: 1.5 }).error || "", /whole number/);
  const blocked = validateMeasuredForm({
    ...base,
    fault: "packet_loss",
    executable: false,
    blockedReason: "Packet loss is not applied.",
  });
  assert.equal(blocked.error, "Packet loss is not applied.");
});
