const { execFile } = require("child_process");
const path = require("path");

const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const PROJECT_NAME = /^mm[a-f0-9]{16}$/;
const IDENTITY_FORMAT = '{"id":{{json .Id}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';
const CPU_PERIOD = 100000;
const CPU_QUOTA = 5000;
const MEMORY_MIB = new Set([4, 8, 12]);
const NETEM_IMAGE = "metricmantis-sandbox-netem:approved";
const NETEM_DIR = path.resolve(__dirname, "..", "sandboxes", "sample", "netem");
const LABEL_FORMAT = '{"id":{{json .Id}},"fault":{{json (index .Config.Labels "metricmantis.fault")}},"project":{{json (index .Config.Labels "metricmantis.sandbox-project")}},"target":{{json (index .Config.Labels "metricmantis.target-id")}}}';

function isSafeServiceName(name) {
  return typeof name === "string" && SERVICE_NAME.test(name);
}

function defaultExec(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || "").trim().slice(0, 2000),
        stderr: String(stderr || error?.message || "").trim().slice(0, 500),
      });
    });
  });
}

function chaosStatusFromEnv(env = process.env) {
  const chaosEnabled = env.METRICMANTIS_CHAOS_ENABLED === "true";
  const allowlist = String(env.METRICMANTIS_CHAOS_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim())
    .filter(isSafeServiceName);
  return {
    chaosEnabled,
    allowlist,
    startupMode: chaosEnabled ? "chaos" : "normal",
  };
}

function netemRuleVisible(stdout, spec) {
  const text = String(stdout || "");
  if (!/\bnetem\b/.test(text)) return false;
  if (spec.delayMs) {
    return new RegExp(`(?:^|\\s)delay\\s+${spec.delayMs}(?:\\.0+)?ms(?:\\s|$)`).test(text);
  }
  if (spec.lossPercent) {
    return new RegExp(`(?:^|\\s)loss\\s+${spec.lossPercent}(?:\\.0+)?%(?:\\s|$)`).test(text);
  }
  return false;
}

function egressInterface(routeText) {
  const lines = String(routeText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("default "));
  if (lines.length !== 1 || !/\sdev\s+eth0(?:\s|$)/.test(lines[0])) return null;
  return "eth0";
}

function createDockerExecutor({
  execFileImpl = defaultExec,
  platform = process.platform,
  env = process.env,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const { chaosEnabled, allowlist, startupMode } = chaosStatusFromEnv(env);

  function allowed(name) {
    return chaosEnabled && isSafeServiceName(name) && allowlist.includes(name);
  }

  async function capabilities() {
    const version = await execFileImpl("docker", ["version", "--format", "{{.Server.Version}}"], 4000);
    const dockerAvailable = version.ok && Boolean(version.stdout);
    const networkReady = dockerAvailable && chaosEnabled;
    const networkFaultReason = networkReady
      ? "Latency and packet loss use a server-owned netem sidecar on the verified container egress interface."
      : "Latency and packet loss stay off until Docker is available and chaos is enabled for an allowlisted service.";
    return {
      dockerAvailable,
      chaosEnabled,
      allowlist,
      startupMode,
      stop: dockerAvailable && chaosEnabled,
      restart: dockerAvailable && chaosEnabled,
      cpu: dockerAvailable && chaosEnabled,
      memory: dockerAvailable && chaosEnabled,
      cpuQuota: CPU_QUOTA,
      cpuPeriod: CPU_PERIOD,
      memoryMib: [4, 8, 12],
      latency: networkReady,
      packetLoss: networkReady,
      maxLatencyMs: 500,
      maxLossPercent: 20,
      networkFaultReason,
      platform,
    };
  }

  async function inspectIdentity(id) {
    if (!CONTAINER_ID.test(id)) return { ok: false, detail: "Invalid container id." };
    const result = await execFileImpl("docker", ["inspect", "--format", IDENTITY_FORMAT, id], 8000);
    if (!result.ok || !result.stdout) return { ok: false, detail: result.stderr || "docker inspect failed." };
    let body;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      return { ok: false, detail: "Could not read container inspection." };
    }
    if (!body || body.id !== id || !CONTAINER_ID.test(body.id)) {
      return { ok: false, detail: "Container inspection did not match the requested id." };
    }
    return {
      ok: true,
      id: body.id,
      status: body.status || null,
      health: body.health || "",
      project: body.project || null,
      service: body.service || null,
    };
  }

  async function mutationTarget(name, expected) {
    if (!CONTAINER_ID.test(name)) {
      if (!allowed(name)) return { ok: false, detail: "Container is not approved for chaos." };
      return { ok: true, ref: name };
    }
    if (!chaosEnabled) return { ok: false, detail: "Real chaos is disabled." };
    if (!expected || expected.id !== name || !isSafeServiceName(expected.service) || !PROJECT_NAME.test(expected.project)) {
      return { ok: false, detail: "Container is not approved for chaos." };
    }
    if (!allowlist.includes(expected.service)) return { ok: false, detail: "Container is not approved for chaos." };
    const identity = await inspectIdentity(name);
    if (!identity.ok || identity.project !== expected.project || identity.service !== expected.service) {
      return { ok: false, detail: "Container labels do not match the sandbox." };
    }
    return { ok: true, ref: name };
  }

  async function inspect(name) {
    if (!isSafeServiceName(name) && !CONTAINER_ID.test(name)) {
      return { ok: false, detail: "Invalid container name." };
    }
    const result = await execFileImpl(
      "docker",
      ["inspect", "--format", "{{.State.Status}} {{.RestartCount}} {{.HostConfig.CpuQuota}} {{.HostConfig.CpuPeriod}} {{.HostConfig.NanoCpus}} {{.State.StartedAt}}", name],
      8000,
    );
    if (!result.ok) return { ok: false, detail: result.stderr || "docker inspect failed." };
    const parts = result.stdout.split(/\s+/);
    const [status, restarts, quota, period] = parts;
    const hasNano = parts.length >= 6 && /^\d+$/.test(parts[4]);
    return {
      ok: true,
      status: status || null,
      restartCount: Number(restarts),
      cpuQuota: Number(quota),
      cpuPeriod: Number(period),
      nanoCpus: hasNano ? Number(parts[4]) : 0,
      startedAt: (hasNano ? parts.slice(5) : parts.slice(4)).join(" ") || null,
    };
  }

  async function stats(name, expected) {
    if (CONTAINER_ID.test(name)) {
      const target = await mutationTarget(name, expected);
      if (!target.ok) return target;
    } else if (!isSafeServiceName(name)) {
      return { ok: false, detail: "Invalid container name." };
    }
    const result = await execFileImpl(
      "docker",
      ["stats", "--no-stream", "--format", "{{.CPUPerc}} {{.MemUsage}}", name],
      8000,
    );
    if (!result.ok) return { ok: false, detail: result.stderr || "docker stats failed." };
    const match = result.stdout.match(/([0-9.]+)%/);
    const memory = result.stdout.split(/\s+/).slice(1).join(" ") || null;
    return {
      ok: true,
      cpuPercent: match ? Number(match[1]) : null,
      memory,
      memoryBytes: memoryBytes(memory),
    };
  }

  function memoryBytes(text) {
    const match = String(text || "").match(/([0-9.]+)\s*([KMGT]iB)/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const scale = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
    if (!Number.isFinite(amount) || !scale[unit]) return null;
    return Math.round(amount * scale[unit]);
  }

  async function identityMatches(name, expected) {
    if (!CONTAINER_ID.test(name)) return { ok: false, detail: "Container is not approved for chaos." };
    if (!expected || expected.id !== name || !isSafeServiceName(expected.service) || !PROJECT_NAME.test(expected.project)) {
      return { ok: false, detail: "Container is not approved for chaos." };
    }
    const identity = await inspectIdentity(name);
    if (!identity.ok || identity.project !== expected.project || identity.service !== expected.service) {
      return { ok: false, detail: "Container labels do not match the sandbox." };
    }
    return { ok: true, ref: name };
  }

  async function restoreService(name, expected) {
    const target = await identityMatches(name, expected);
    if (!target.ok) return target;
    const current = await inspect(target.ref);
    if (current.ok && current.status === "running") {
      return { ok: true, detail: "docker inspect showed the container already running." };
    }
    const result = await execFileImpl("docker", ["start", target.ref], 20000);
    const after = await inspect(target.ref);
    const restored = result.ok && after.ok && after.status === "running";
    return {
      ok: restored,
      detail: restored ? "docker start restored the container and inspect confirmed it is running." : (result.stderr || after.detail || "The container was not restored."),
    };
  }

  async function stop(name, expected) {
    if (!CONTAINER_ID.test(name)) return { ok: false, detail: "Container is not approved for chaos." };
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    const result = await execFileImpl("docker", ["stop", target.ref], 20000);
    return { ok: result.ok, detail: result.ok ? "docker stop completed." : result.stderr };
  }

  async function start(name, expected) {
    if (!CONTAINER_ID.test(name)) return { ok: false, detail: "Container is not approved for chaos." };
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    const result = await execFileImpl("docker", ["start", target.ref], 20000);
    return { ok: result.ok, detail: result.ok ? "docker start completed." : result.stderr };
  }

  async function restart(name, expected) {
    if (!CONTAINER_ID.test(name)) return { ok: false, detail: "Container is not approved for chaos." };
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    const result = await execFileImpl("docker", ["restart", target.ref], 30000);
    return { ok: result.ok, detail: result.ok ? "docker restart completed." : result.stderr };
  }

  async function constrainCpu(name, expected) {
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    const before = await inspect(target.ref);
    if (!before.ok) return { ok: false, detail: before.detail };
    if (before.nanoCpus > 0) {
      const result = await execFileImpl("docker", ["update", "--cpus", "0.05", target.ref], 8000);
      const after = await inspect(target.ref);
      const applied = Boolean(result.ok && after.ok && after.nanoCpus === 50_000_000);
      return {
        ok: applied,
        before,
        detail: applied ? "CPU limit set to 0.05 CPUs." : (result.stderr || "The CPU limit was not observed."),
      };
    }
    const result = await execFileImpl(
      "docker",
      ["update", "--cpu-period", String(CPU_PERIOD), "--cpu-quota", String(CPU_QUOTA), target.ref],
      8000,
    );
    return {
      ok: result.ok,
      before,
      detail: result.ok ? "CPU quota set to 5% of one core." : result.stderr,
    };
  }

  function unlimitedQuota(value) {
    return value === 0 || value === -1 || !Number.isFinite(value);
  }

  function workloadSeconds(durationMs) {
    const seconds = Math.round(Number(durationMs) / 1000);
    if (!Number.isInteger(seconds)) return null;
    return Math.min(40, Math.max(1, seconds));
  }

  function workloadPids(topOutput) {
    return String(topOutput || "").split("\n").map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match || !/^\d+$/.test(match[1])) return null;
      const command = match[2];
      if (!command.includes("dd") || !command.includes("if=/dev/zero") || !command.includes("of=/dev/null")) return null;
      return match[1];
    }).filter(Boolean);
  }

  async function startCpuWorkload(name, durationMs, expected) {
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    name = target.ref;
    const seconds = workloadSeconds(durationMs);
    if (seconds == null) return { ok: false, detail: "CPU workload duration is invalid." };
    const started = await execFileImpl(
      "docker",
      ["exec", "-d", name, "/bin/sh", "-c", `echo $$ >/tmp/mm-cpu-burn.pid; exec timeout ${seconds} dd if=/dev/zero of=/dev/null bs=1M`],
      8000,
    );
    if (!started.ok) return { ok: false, detail: started.stderr || "CPU workload did not start." };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const top = await execFileImpl("docker", ["top", name, "-eo", "pid,args"], 8000);
      if (top.ok && workloadPids(top.stdout).length > 0) {
        return { ok: true, detail: "A bounded CPU workload is running in the container." };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { ok: false, detail: "The CPU workload process was not observed." };
  }

  async function stopCpuWorkload(name, expected) {
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    name = target.ref;
    // The pid file is written inside the container, so it is a container PID, not a docker top host PID.
    const script = "pid=$(cat /tmp/mm-cpu-burn.pid 2>/dev/null || true); case \"$pid\" in ''|*[!0-9]*) ;; *) kill \"$pid\" 2>/dev/null || true ;; esac; rm -f /tmp/mm-cpu-burn.pid";
    await execFileImpl("docker", ["exec", name, "/bin/sh", "-c", script], 8000);
    const top = await execFileImpl("docker", ["top", name, "-eo", "pid,args"], 8000);
    if (!top.ok) {
      return { ok: false, detail: "docker top could not confirm the CPU workload stopped." };
    }
    const stillRunning = workloadPids(top.stdout).length > 0;
    return {
      ok: !stillRunning,
      detail: stillRunning
        ? "The CPU workload was still running after stop."
        : "CPU workload stopped.",
    };
  }

  async function restoreCpu(name, before, expected) {
    const target = await mutationTarget(name, expected);
    if (!target.ok || !before) return { ok: false, detail: target.ok ? "CPU settings were not restored." : target.detail };
    name = target.ref;
    if (before.nanoCpus > 0) {
      const cpus = before.nanoCpus / 1e9;
      const text = Number.isInteger(cpus) ? String(cpus) : String(Math.round(cpus * 100) / 100);
      const result = await execFileImpl("docker", ["update", "--cpus", text, name], 8000);
      if (!result.ok) return { ok: false, detail: result.stderr || "CPU settings were not restored." };
      const after = await inspect(name);
      const restored = after.ok && after.nanoCpus === before.nanoCpus;
      return {
        ok: restored,
        after,
        detail: restored
          ? `docker inspect showed ${after.nanoCpus} NanoCPUs after restore.`
          : "docker inspect did not show the previous CPU limit.",
      };
    }
    // Docker keeps a positive quota when --cpu-quota 0 is passed. Unlimited is -1.
    const quota = unlimitedQuota(before.cpuQuota) ? "-1" : String(before.cpuQuota);
    const period = before.cpuPeriod > 0 ? String(before.cpuPeriod) : "100000";
    const result = await execFileImpl(
      "docker",
      ["update", "--cpu-period", period, "--cpu-quota", quota, name],
      8000,
    );
    if (!result.ok) return { ok: false, detail: result.stderr || "CPU settings were not restored." };
    const after = await inspect(name);
    const restored = after.ok && (
      unlimitedQuota(before.cpuQuota)
        ? unlimitedQuota(after.cpuQuota)
        : after.cpuQuota === before.cpuQuota
    );
    return {
      ok: restored,
      after,
      detail: restored
        ? `docker inspect showed CPU quota ${after.cpuQuota} after restore.`
        : "docker inspect did not show the previous CPU quota.",
    };
  }

  function memoryCount(mib) {
    const count = Number(mib);
    return MEMORY_MIB.has(count) ? count : null;
  }

  async function applyMemory(name, expected, mib) {
    if (!CONTAINER_ID.test(name)) return { ok: false, detail: "Container is not approved for chaos." };
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    const count = memoryCount(mib);
    if (count == null) return { ok: false, detail: "Memory pressure size is not approved." };
    const limit = await execFileImpl("docker", ["inspect", "--format", "{{.HostConfig.Memory}}", target.ref], 8000);
    const limitBytes = Number(limit.stdout);
    const requestBytes = count * 1024 * 1024;
    if (!limit.ok || !Number.isFinite(limitBytes) || limitBytes < requestBytes * 4) {
      return { ok: false, detail: "The container memory limit is too small for this pressure file." };
    }
    const started = await execFileImpl(
      "docker",
      ["exec", target.ref, "/bin/sh", "-c", `rm -f /dev/shm/mm-memory-pressure; dd if=/dev/zero of=/dev/shm/mm-memory-pressure bs=1048576 count=${count}`],
      8000,
    );
    if (!started.ok) return { ok: false, detail: started.stderr || "Memory pressure file was not created." };
    const measured = await execFileImpl("docker", ["exec", target.ref, "wc", "-c", "/dev/shm/mm-memory-pressure"], 8000);
    const size = Number(String(measured.stdout || "").trim().split(/\s+/)[0]);
    const verified = measured.ok && size === requestBytes;
    if (!verified) {
      await execFileImpl("docker", ["exec", target.ref, "rm", "-f", "/dev/shm/mm-memory-pressure"], 8000);
      return { ok: false, verified: false, detail: "The memory pressure file size did not match the approved size." };
    }
    return { ok: true, verified: true, bytes: size, detail: `A ${count} MiB pressure file was present in the container.` };
  }

  async function clearMemory(name, expected) {
    const target = await identityMatches(name, expected);
    if (!target.ok) return target;
    await execFileImpl("docker", ["exec", target.ref, "rm", "-f", "/dev/shm/mm-memory-pressure"], 8000);
    const check = await execFileImpl(
      "docker",
      ["exec", target.ref, "/bin/sh", "-c", "test ! -e /dev/shm/mm-memory-pressure"],
      8000,
    );
    return {
      ok: check.ok,
      detail: check.ok ? "The memory pressure file was removed." : "The memory pressure file was still present.",
    };
  }

  async function ensureNetemImage() {
    const found = await execFileImpl("docker", ["image", "inspect", "--format", "{{.Id}}", NETEM_IMAGE], 8000);
    if (found.ok && found.stdout) return { ok: true };
    const built = await execFileImpl("docker", ["build", "-t", NETEM_IMAGE, NETEM_DIR], 180000);
    return { ok: built.ok, detail: built.ok ? "Netem image built." : (built.stderr || "The netem image did not build.") };
  }

  function netemValue(kind, value) {
    const number = Number(value);
    if (!Number.isInteger(number)) return null;
    if (kind === "delay") return number >= 20 && number <= 500 ? number : null;
    if (kind === "loss") return number >= 1 && number <= 20 ? number : null;
    return null;
  }

  async function applyNetem(name, expected, spec) {
    if (!CONTAINER_ID.test(name)) return { ok: false, detail: "Container is not approved for chaos." };
    const target = await mutationTarget(name, expected);
    if (!target.ok) return target;
    const delay = spec.delayMs ? netemValue("delay", spec.delayMs) : 0;
    const loss = spec.lossPercent ? netemValue("loss", spec.lossPercent) : 0;
    if ((spec.delayMs && delay == null) || (spec.lossPercent && loss == null) || (delay > 0 && loss > 0) || (delay === 0 && loss === 0)) {
      return { ok: false, detail: "The network fault value is outside the approved range." };
    }
    const image = await ensureNetemImage();
    if (!image.ok) return { ok: false, detail: image.detail };
    const rule = delay > 0 ? { delayMs: delay } : { lossPercent: loss };
    const wanted = delay > 0 ? `delay ${delay}ms` : `loss ${loss}%`;
    const route = await execFileImpl("docker", [
      "run", "--rm",
      "--network", `container:${target.ref}`,
      "--entrypoint", "ip",
      NETEM_IMAGE,
      "route", "show", "default",
    ], 20000);
    const iface = route.ok ? egressInterface(route.stdout) : null;
    if (!iface) {
      return { ok: false, detail: "The verified container default route is not eth0, so no netem rule was installed." };
    }
    const started = await execFileImpl("docker", [
      "run", "-d",
      "--network", `container:${target.ref}`,
      "--cap-add", "NET_ADMIN",
      "--label", "metricmantis.fault=netem",
      "--label", `metricmantis.sandbox-project=${expected.project}`,
      "--label", `metricmantis.target-id=${target.ref}`,
      "--memory", "32m",
      "--cpus", "0.25",
      "--pids-limit", "32",
      "-e", `MM_DELAY_MS=${delay || 0}`,
      "-e", `MM_LOSS_PERCENT=${loss || 0}`,
      NETEM_IMAGE,
    ], 30000);
    const sidecarId = String(started.stdout || "").trim();
    if (!started.ok || !CONTAINER_ID.test(sidecarId)) {
      if (CONTAINER_ID.test(sidecarId)) await execFileImpl("docker", ["rm", "-f", sidecarId], 8000);
      return { ok: false, detail: started.stderr || "The netem sidecar did not start." };
    }
    const shown = await waitForNetem(sidecarId, iface, rule);
    const namespace = shown.ok ? await sharedNetNamespace(target.ref, sidecarId) : { ok: false, reason: "qdisc" };
    if (!shown.ok || !namespace.ok) {
      await execFileImpl("docker", ["stop", "-t", "5", sidecarId], 15000);
      await execFileImpl("docker", ["rm", "-f", sidecarId], 8000);
      const observed = String(shown.stdout || "").trim().replace(/\s+/g, " ").slice(0, 180);
      let detail;
      if (!shown.ok) {
        detail = observed
          ? `tc qdisc show dev ${iface} did not report ${wanted}. Observed: ${observed}`
          : `tc qdisc show dev ${iface} did not report ${wanted}.`;
      } else if (namespace.reason === "unread") {
        detail = "The verified container network namespace could not be read, so the netem rule was not verified.";
      } else if (namespace.reason === "attach") {
        detail = "The netem sidecar was not attached to the verified container network namespace.";
      } else {
        detail = "The netem sidecar was not in the verified container network namespace.";
      }
      return { ok: false, verified: false, sidecarId, detail };
    }
    return { ok: true, verified: true, sidecarId, detail: `tc qdisc show dev ${iface} reported ${wanted}.` };
  }

  function netnsValue(text) {
    const value = String(text || "").trim();
    return /^net:\[\d+\]$/.test(value) ? value : null;
  }

  async function sharedNetNamespace(targetId, sidecarId) {
    const attached = await execFileImpl(
      "docker",
      ["inspect", "--format", "{{.HostConfig.NetworkMode}}", sidecarId],
      8000,
    );
    const mode = String(attached.stdout || "").trim();
    if (!attached.ok || mode !== `container:${targetId}`) return { ok: false, reason: "attach" };
    const targetNs = await execFileImpl("docker", ["exec", targetId, "readlink", "/proc/1/ns/net"], 8000);
    const sideNs = await execFileImpl("docker", ["exec", sidecarId, "readlink", "/proc/1/ns/net"], 8000);
    const targetValue = targetNs.ok ? netnsValue(targetNs.stdout) : null;
    const sideValue = sideNs.ok ? netnsValue(sideNs.stdout) : null;
    if (!targetValue || !sideValue) return { ok: false, reason: "unread" };
    if (targetValue !== sideValue) return { ok: false, reason: "mismatch" };
    return { ok: true };
  }

  async function waitForNetem(sidecarId, iface, spec) {
    let observed = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await execFileImpl("docker", ["inspect", "--format", "{{.State.Status}}", sidecarId], 8000);
      if (state.ok && (state.stdout === "exited" || state.stdout === "dead")) {
        return { ok: false, stdout: observed };
      }
      const shown = await execFileImpl("docker", ["exec", sidecarId, "tc", "qdisc", "show", "dev", iface], 8000);
      observed = shown.stdout || observed;
      if (shown.ok && netemRuleVisible(shown.stdout, spec)) return { ok: true, stdout: shown.stdout };
      await sleepImpl(250);
    }
    return { ok: false, stdout: observed };
  }

  async function sidecarOwned(id, expected) {
    if (!CONTAINER_ID.test(id)) return false;
    const result = await execFileImpl("docker", ["inspect", "--format", LABEL_FORMAT, id], 8000);
    if (!result.ok || !result.stdout) return false;
    try {
      const body = JSON.parse(result.stdout);
      return body.fault === "netem" && body.project === expected.project && body.target === expected.id;
    } catch {
      return false;
    }
  }

  async function clearNetem(name, expected, sidecarId) {
    const target = await identityMatches(name, expected);
    if (!target.ok) return target;
    if (sidecarId && await sidecarOwned(sidecarId, expected)) {
      await execFileImpl("docker", ["stop", "-t", "5", sidecarId], 15000);
      await execFileImpl("docker", ["rm", "-f", sidecarId], 8000);
    }
    const image = await ensureNetemImage();
    if (!image.ok) return { ok: false, detail: image.detail };
    const shown = await execFileImpl("docker", [
      "run", "--rm",
      "--network", `container:${target.ref}`,
      "--cap-add", "NET_ADMIN",
      "--entrypoint", "tc",
      NETEM_IMAGE,
      "qdisc", "show", "dev", "eth0",
    ], 20000);
    if (shown.ok && shown.stdout.includes("netem")) {
      await execFileImpl("docker", [
        "run", "--rm",
        "--network", `container:${target.ref}`,
        "--cap-add", "NET_ADMIN",
        "--entrypoint", "tc",
        NETEM_IMAGE,
        "qdisc", "del", "dev", "eth0", "root",
      ], 20000);
    }
    const after = await execFileImpl("docker", [
      "run", "--rm",
      "--network", `container:${target.ref}`,
      "--cap-add", "NET_ADMIN",
      "--entrypoint", "tc",
      NETEM_IMAGE,
      "qdisc", "show", "dev", "eth0",
    ], 20000);
    const cleared = after.ok && !after.stdout.includes("netem");
    return {
      ok: cleared,
      detail: cleared ? "tc qdisc show no longer reported netem." : "A netem rule was still present after cleanup.",
    };
  }

  async function sweepNetem() {
    const listed = await execFileImpl("docker", ["ps", "-aq", "--no-trunc", "--filter", "label=metricmantis.fault=netem"], 8000);
    if (!listed.ok && listed.stderr) return { ok: false, detail: listed.stderr };
    const ids = String(listed.stdout || "").split(/\s+/).filter((id) => CONTAINER_ID.test(id));
    for (const id of ids) {
      const result = await execFileImpl("docker", ["inspect", "--format", LABEL_FORMAT, id], 8000);
      let owned = false;
      try {
        owned = result.ok && JSON.parse(result.stdout).fault === "netem";
      } catch {
        owned = false;
      }
      if (!owned) continue;
      await execFileImpl("docker", ["stop", "-t", "5", id], 15000);
      await execFileImpl("docker", ["rm", "-f", id], 8000);
    }
    return { ok: true };
  }

  return {
    isSafeServiceName,
    allowed,
    capabilities,
    inspect,
    inspectIdentity,
    stats,
    stop,
    start,
    restart,
    restoreService,
    constrainCpu,
    restoreCpu,
    startCpuWorkload,
    stopCpuWorkload,
    applyMemory,
    clearMemory,
    applyNetem,
    clearNetem,
    sweepNetem,
  };
}

module.exports = {
  createDockerExecutor,
  isSafeServiceName,
  chaosStatusFromEnv,
  netemRuleVisible,
  egressInterface,
};
