const path = require("path");
const { execFileSync } = require("child_process");

const API_DIR = path.resolve(__dirname, "..");
const API_SCRIPT = path.join(API_DIR, "index.js");

function isProjectApiCommand(command, cwd) {
  const parts = String(command || "").trim().split(/\s+/);
  if (parts.length < 2 || path.basename(parts[0]) !== "node") return false;
  const script = parts[1];
  if (!script || script.includes("next") || path.basename(script) !== "index.js") return false;
  return path.resolve(cwd || "", script) === API_SCRIPT;
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

function inspectPort(port, execImpl = execFileSync) {
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
  describeListener,
};
