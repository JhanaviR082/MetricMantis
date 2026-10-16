const fs = require("fs");
const path = require("path");

const LEASE_FILE = path.join(__dirname, "..", "data", "fault-lease.json");

function writeLease(lease) {
  fs.mkdirSync(path.dirname(LEASE_FILE), { recursive: true });
  const temporary = `${LEASE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(lease));
  fs.renameSync(temporary, LEASE_FILE);
}

function readLease() {
  try {
    const body = JSON.parse(fs.readFileSync(LEASE_FILE, "utf8"));
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function clearLease() {
  fs.rmSync(LEASE_FILE, { force: true });
}

async function recoverFaultLease(docker) {
  if (typeof docker.sweepNetem === "function") {
    try {
      await docker.sweepNetem();
    } catch {
      // A leftover sidecar is reported by the next experiment cleanup.
    }
  }
  const lease = readLease();
  if (!lease || !lease.id || !lease.expected) return { ok: true, empty: !lease };
  try {
    if (lease.fault === "stop" || lease.fault === "restart") {
      await docker.restoreService(lease.id, lease.expected);
    } else if (lease.fault === "cpu" && lease.before) {
      await docker.restoreCpu(lease.id, lease.before, lease.expected);
      if (typeof docker.stopCpuWorkload === "function") await docker.stopCpuWorkload(lease.id, lease.expected);
    } else if (lease.fault === "memory") {
      await docker.clearMemory(lease.id, lease.expected);
    } else if (lease.fault === "latency" || lease.fault === "packet_loss") {
      await docker.clearNetem(lease.id, lease.expected, lease.sidecarId || null);
    }
  } catch {
    return { ok: false, error: "Fault cleanup could not finish after restart." };
  }
  clearLease();
  return { ok: true };
}

module.exports = {
  writeLease,
  readLease,
  clearLease,
  recoverFaultLease,
};
