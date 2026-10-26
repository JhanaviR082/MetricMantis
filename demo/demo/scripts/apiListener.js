const path = require("path");
const { execFileSync } = require("child_process");

const API_DIR = path.resolve(__dirname, "..");
const API_SCRIPT = path.join(API_DIR, "index.js");
const IS_WIN32 = process.platform === "win32";

// Split a command line into argv tokens, honoring double-quoted segments.
// `ps -o command=` output on Unix is whitespace separated (quotes are rare), while
// Windows command lines quote paths that contain spaces ("C:\Program Files\...").
// This keeps the existing Unix behavior intact and handles quoted Windows paths.
function tokenizeCommandLine(command) {
  const text = String(command || "").trim();
  const parts = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (/\s/.test(ch) && !inQuotes) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Compare a resolved script path to API_SCRIPT. Windows paths are
// case-insensitive and separator-agnostic; elsewhere an exact match is required
// (matching the original behavior).
function sameScriptPath(candidate, expected) {
  if (candidate === expected) return true;
  if (IS_WIN32) {
    return path.normalize(candidate).toLowerCase() === path.normalize(expected).toLowerCase();
  }
  return false;
}

function isProjectApiCommand(command, cwd) {
  const parts = tokenizeCommandLine(command);
  if (parts.length < 2) return false;
  const exe = path.basename(parts[0]).toLowerCase();
  if (exe !== "node" && exe !== "node.exe") return false;
  const script = parts[1];
  if (!script || script.includes("next") || path.basename(script) !== "index.js") return false;
  return sameScriptPath(path.resolve(cwd || "", script), API_SCRIPT);
}

function classifyListener({ pid, cwd, command, chaosEnabled }) {
  if (!pid) return { state: "free" };
  const project = isProjectApiCommand(command, cwd);
  if (!project) {
    return { state: "unrelated", pid, command: String(command || "").trim(), cwd: cwd || "" };
  }
  return {
    state: chaosEnabled ? "project-chaos" : "project-normal",
    pid,
    command: String(command || "").trim(),
    cwd: path.resolve(cwd),
  };
}

function decideStartup(mode, listener) {
  if (!listener || listener.state === "free") return { action: "start" };
  if (listener.state === "unknown" || listener.state === "unrelated") {
    return { action: "refuse", reason: listener.state };
  }
  if (mode === "chaos" && listener.state === "project-chaos") return { action: "already" };
  if (mode === "chaos" && listener.state === "project-normal") return { action: "replace", pid: listener.pid };
  if (mode === "normal" && listener.state === "project-chaos") return { action: "refuse", reason: "chaos-active" };
  if (mode === "normal" && listener.state === "project-normal") return { action: "refuse", reason: "already-running" };
  return { action: "refuse", reason: "unknown" };
}

function chaosEnabledInProcessText(text) {
  return /(?:^|\s)METRICMANTIS_CHAOS_ENABLED=true(?:\s|$)/.test(String(text || ""));
}

function parseListenerOutput(portOutput, command, cwdOutput, environText) {
  const pids = [...new Set(Array.from(String(portOutput || "").matchAll(/^p(\d+)$/gm)).map((match) => Number(match[1])))];
  if (pids.length === 0) return { state: "free" };
  if (pids.length > 1) return { state: "unknown", error: "More than one process is listening." };
  const cwd = (String(cwdOutput || "").match(/^n(.+)$/m) || [])[1] || "";
  return classifyListener({
    pid: pids[0],
    cwd,
    command,
    chaosEnabled: chaosEnabledInProcessText(environText),
  });
}

// Unix/macOS implementation using lsof + ps. Unchanged from the original behavior.
function inspectPortUnix(port, execImpl = execFileSync) {
  let portOutput = "";
  try {
    portOutput = execImpl("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
  } catch (error) {
    if (error.status === 1) return { state: "free" };
    return { state: "unknown", error: "Could not inspect the API port." };
  }
  const pids = [...new Set(Array.from(String(portOutput).matchAll(/^p(\d+)$/gm)).map((match) => Number(match[1])))];
  if (pids.length === 0) return { state: "free" };
  if (pids.length > 1) return { state: "unknown", error: "More than one process is listening." };
  const pid = String(pids[0]);
  try {
    const command = execImpl("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim();
    const cwdOutput = execImpl("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const environText = execImpl("ps", ["eww", "-p", pid], { encoding: "utf8" });
    return parseListenerOutput(portOutput, command, cwdOutput, environText);
  } catch {
    return { state: "unknown", error: "Could not identify the process listening on the API port." };
  }
}

// Windows: parse `netstat -ano` for the PID(s) listening on the port. A LISTENING
// socket has an unspecified foreign endpoint (foreign port 0), so this matches on
// the local port + foreign port 0 rather than the localized "LISTENING" word.
function parseWindowsListeningPids(output, port) {
  const pids = new Set();
  const lines = String(output || "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)\s*$/);
    if (!match) continue;
    const localAddr = match[1];
    const foreignAddr = match[2];
    const pid = Number(match[3]);
    const localPort = localAddr.match(/:(\d+)$/);
    if (!localPort || Number(localPort[1]) !== port) continue;
    const foreignPort = foreignAddr.match(/:(\d+)$/);
    if (!foreignPort || Number(foreignPort[1]) !== 0) continue;
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

// Parse the JSON emitted by inspectWindowsProcess.ps1 into { command, cwd,
// environment } strings, or null if it is missing/invalid.
function parseWindowsProcessInfo(output) {
  const text = String(output || "").replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const command = typeof obj.command === "string" ? obj.command : null;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
  const environment = typeof obj.environment === "string" ? obj.environment : null;
  // Require a complete record; anything missing fails safe to null so the
  // caller reports "unknown" rather than acting on partial data.
  if (!command || !cwd || !environment) return null;
  return { command, cwd, environment };
}

function isValidWindowsAbsolutePath(p) {
  return typeof p === "string" && /^[A-Za-z]:[\\/]/.test(p);
}

// Guard against a wrong PEB offset yielding garbage: a real Windows environment
// always contains well-known variables. If the read does not look like one, the
// caller fails safe with "unknown" rather than guessing the listener's identity.
function isValidWindowsEnvironment(env) {
  return (
    typeof env === "string" &&
    env.length > 0 &&
    /(?:^|\n)(SystemRoot|PATH|USERNAME|USERPROFILE|ProgramData|windir|OS|PATHEXT|COMPUTERNAME|TEMP)=/m.test(env)
  );
}

// Windows implementation: identify the listener via netstat, then read its PEB
// (command line, current directory, environment) via PowerShell. If anything
// cannot be identified reliably, fail safe with "unknown" so startup refuses
// rather than terminating an unverified process.
function inspectPortWindows(port, execImpl = execFileSync) {
  let netstatOutput = "";
  try {
    netstatOutput = execImpl("netstat", ["-ano"], { encoding: "utf8" });
  } catch {
    return { state: "unknown", error: "Could not inspect the API port." };
  }
  const pids = parseWindowsListeningPids(netstatOutput, port);
  if (pids.length === 0) return { state: "free" };
  if (pids.length > 1) return { state: "unknown", error: "More than one process is listening." };
  const pid = pids[0];

  const script = path.join(__dirname, "inspectWindowsProcess.ps1");
  let pebOutput = "";
  try {
    pebOutput = execImpl(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProcessId", String(pid)],
      { encoding: "utf8" },
    );
  } catch {
    return { state: "unknown", error: "Could not identify the process listening on the API port." };
  }
  const info = parseWindowsProcessInfo(pebOutput);
  if (!info || !info.command || !info.cwd || !info.environment) {
    return { state: "unknown", error: "Could not identify the process listening on the API port." };
  }
  if (!isValidWindowsAbsolutePath(info.cwd) || !isValidWindowsEnvironment(info.environment)) {
    return { state: "unknown", error: "Could not identify the process listening on the API port." };
  }
  return classifyListener({
    pid,
    cwd: info.cwd,
    command: info.command,
    chaosEnabled: chaosEnabledInProcessText(info.environment),
  });
}

function inspectPort(port, execImpl = execFileSync) {
  return IS_WIN32 ? inspectPortWindows(port, execImpl) : inspectPortUnix(port, execImpl);
}

function describeListener(listener) {
  if (!listener || listener.state === "free") return "Port 3001 is free.";
  if (listener.state === "unknown") return listener.error || "The process on port 3001 could not be identified.";
  const where = listener.cwd ? ` in ${listener.cwd}` : "";
  return `pid ${listener.pid} (${listener.command})${where}`;
}

module.exports = {
  API_DIR,
  API_SCRIPT,
  isProjectApiCommand,
  classifyListener,
  decideStartup,
  chaosEnabledInProcessText,
  parseListenerOutput,
  inspectPort,
  inspectPortUnix,
  inspectPortWindows,
  parseWindowsListeningPids,
  parseWindowsProcessInfo,
  isValidWindowsAbsolutePath,
  isValidWindowsEnvironment,
  tokenizeCommandLine,
  describeListener,
};
