const { execFile } = require("child_process");
const sandboxRuntime = require("../sandboxes/sandboxRuntime");
const { ENDPOINTS } = require("../sandboxes/sample/measurer/probe");

const CONTAINER_ID = /^[a-f0-9]{64}$/;

function probeEndpoint(service) {
  return ENDPOINTS[service] || null;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function composeRunArgs(projectName, options) {
  if (!sandboxRuntime.isValidProjectName(projectName) || !probeEndpoint(options.service)) return null;
  const durationMs = clampInt(options.durationMs, 200, 15000, 2000);
  const ratePerSecond = clampInt(options.ratePerSecond, 1, 20, 5);
  const concurrency = clampInt(options.concurrency, 1, 4, 1);
  const timeoutMs = clampInt(options.timeoutMs, 200, 5000, 1000);
  return {
    durationMs,
    args: [
      "compose", "-p", projectName, "-f", sandboxRuntime.APPROVED_COMPOSE_FILE,
      "--profile", "measure",
      "run", "--rm", "--no-deps", "-T",
      "-e", `MM_SERVICE=${options.service}`,
      "-e", `MM_DURATION_MS=${durationMs}`,
      "-e", `MM_RATE=${ratePerSecond}`,
      "-e", `MM_CONCURRENCY=${concurrency}`,
      "-e", `MM_TIMEOUT_MS=${timeoutMs}`,
      "measurer",
    ],
  };
}

function defaultExec(command, args, timeoutMs, signal) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || error?.message || "").trim().slice(0, 300),
        aborted: Boolean(signal?.aborted),
      });
    });
  });
}

function parseProbeOutput(stdout) {
  const line = String(stdout || "").split("\n").reverse().find((item) => item.startsWith("MM_RESULT "));
  if (!line) return { error: "The sandbox probe did not return a measurement." };
  let body;
  try {
    body = JSON.parse(line.slice("MM_RESULT ".length));
  } catch {
    return { error: "The sandbox probe returned unreadable output." };
  }
  if (!body || !Array.isArray(body.observations)) {
    return { error: body?.error || "The sandbox probe returned no observations." };
  }
  const observations = body.observations.slice(0, 200).flatMap((sample) => {
    if (!sample || typeof sample.at !== "string") return [];
    const latencyMs = Number(sample.latencyMs);
    return [{
      at: sample.at,
      status: Number.isInteger(sample.status) ? sample.status : null,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      ok: sample.ok === true,
      error: typeof sample.error === "string" ? sample.error : undefined,
    }];
  });
  return {
    startedAt: body.startedAt || null,
    finishedAt: body.finishedAt || null,
    windowMs: Number(body.windowMs) > 0 ? Number(body.windowMs) : 0,
    observations,
    measurementErrors: Array.isArray(body.measurementErrors) ? body.measurementErrors.slice(0, 5) : [],
    error: body.error || null,
    warmupExcluded: body.warmupExcluded === 1 ? 1 : 0,
  };
}

async function listMeasurerIds(execFileImpl, projectName) {
  const result = await execFileImpl("docker", [
    "ps", "-aq", "--no-trunc",
    "--filter", `label=com.docker.compose.project=${projectName}`,
    "--filter", "label=com.docker.compose.service=measurer",
  ], 8000);
  if (!result.ok) return { error: result.stderr || "Could not list measurement containers." };
  const ids = String(result.stdout || "").split("\n").map((item) => item.trim()).filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID.test(id))) return { error: "Docker returned an unexpected container id." };
  return { ids };
}

async function removeMeasurerContainers(execFileImpl, projectName) {
  if (!sandboxRuntime.isValidProjectName(projectName)) return { ok: false, error: "Invalid sandbox project name." };
  const listed = await listMeasurerIds(execFileImpl, projectName);
  if (listed.error) return { ok: false, error: listed.error };
  for (const id of listed.ids) {
    const info = await sandboxRuntime.inspectContainer(execFileImpl, id);
    if (info.error || info.project !== projectName || info.service !== "measurer") continue;
    await execFileImpl("docker", ["rm", "-f", id], 20000);
  }
  const left = await listMeasurerIds(execFileImpl, projectName);
  if (left.error) return { ok: false, error: left.error };
  for (const id of left.ids) {
    const info = await sandboxRuntime.inspectContainer(execFileImpl, id);
    if (!info.error && info.project === projectName && info.service === "measurer") {
      return { ok: false, error: "A measurement container was still present after stop." };
    }
  }
  return { ok: true };
}

async function runSandboxProbe({
  projectName,
  service,
  durationMs,
  ratePerSecond,
  concurrency,
  timeoutMs,
  signal,
  execFileImpl = defaultExec,
}) {
  const planned = composeRunArgs(projectName, { service, durationMs, ratePerSecond, concurrency, timeoutMs });
  if (!planned) {
    return {
      error: probeEndpoint(service)
        ? "Invalid sandbox project name."
        : "This sandbox service has no approved HTTP health endpoint.",
      observations: [],
      measurementErrors: [],
      windowMs: 0,
    };
  }
  if (signal?.aborted) {
    return { error: "Cancelled.", observations: [], measurementErrors: [], windowMs: 0, aborted: true };
  }
  const timeout = planned.durationMs + 180000;
  const result = await execFileImpl("docker", planned.args, timeout, signal);
  const parsed = parseProbeOutput(result.stdout);
  const removed = await removeMeasurerContainers(execFileImpl, projectName);
  if (signal?.aborted) {
    return { ...parsed, aborted: true, error: parsed.error || "Cancelled.", measurementErrors: parsed.measurementErrors || [] };
  }
  if (!result.ok && parsed.observations.length === 0) {
    return {
      error: removed.ok ? (parsed.error || "The sandbox probe did not finish.") : removed.error,
      observations: [],
      measurementErrors: parsed.measurementErrors || [],
      windowMs: parsed.windowMs || 0,
      startedAt: parsed.startedAt || null,
      finishedAt: parsed.finishedAt || null,
    };
  }
  if (!removed.ok) parsed.measurementErrors = [...(parsed.measurementErrors || []), removed.error];
  return parsed;
}

module.exports = {
  probeEndpoint,
  composeRunArgs,
  parseProbeOutput,
  removeMeasurerContainers,
  runSandboxProbe,
};
