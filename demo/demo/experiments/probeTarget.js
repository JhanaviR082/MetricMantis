const dns = require("dns").promises;
const net = require("net");

const BLOCKED_PORTS = new Set(["3000", "3001"]);

function parseProbeUrl(raw, allowlist) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "probeUrl is required for a measured experiment." };
  }
  const trimmed = raw.trim();
  if (/[\s\\@]/.test(trimmed)) {
    return { error: "probeUrl must be a plain http or https URL without credentials." };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "probeUrl must be an HTTP URL." };
  }
  if (url.username || url.password) return { error: "probeUrl must not include credentials." };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "probeUrl must use http or https." };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = allowlist.map((item) => item.toLowerCase());
  if (!hostname || !allowed.includes(hostname)) {
    return { error: "probeUrl host is not in METRICMANTIS_PROBE_ALLOWLIST." };
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!/^\d+$/.test(port) || BLOCKED_PORTS.has(port)) {
    return { error: "Refusing to probe MetricMantis on ports 3000 or 3001." };
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { url: url.toString(), hostname, port, protocol: url.protocol };
}

function isBlockedAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower.startsWith("fe80:") || lower === "fd00:ec2::254") return true;
    return false;
  }
  return true;
}

async function prepareProbe(raw, allowlist, lookup = dns.lookup) {
  const parsed = parseProbeUrl(raw, allowlist);
  if (parsed.error) return parsed;
  const records = net.isIP(parsed.hostname)
    ? [{ address: parsed.hostname }]
    : await lookup(parsed.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!records?.length) return { error: "probeUrl could not be resolved." };
  if (records.some((record) => isBlockedAddress(record.address))) {
    return { error: "probeUrl resolves to a blocked address." };
  }
  const pinned = new URL(parsed.url);
  if (parsed.protocol === "http:") pinned.hostname = records[0].address;
  return { url: parsed.url, fetchUrl: pinned.toString() };
}

module.exports = { parseProbeUrl, prepareProbe, isBlockedAddress, BLOCKED_PORTS };
