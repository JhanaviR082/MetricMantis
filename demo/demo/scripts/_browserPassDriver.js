const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const API = process.env.API_BASE || "http://localhost:3001";
const USER = process.env.MM_USER || "browserpass2610";
const PASS = process.env.MM_PASS || "BrowserPass2610!";
const EMAIL = process.env.MM_EMAIL || "browserpass2610@example.com";
const STATE = path.join(__dirname, "_browserPass.state.json");

let cookie = "";

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
    cookie = saved.cookie || "";
    return saved;
  } catch {
    return {};
  }
}

function saveState(extra) {
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    prev = {};
  }
  fs.writeFileSync(STATE, JSON.stringify({ ...prev, cookie, ...extra }, null, 2));
}

function api(pathname, { method = "GET", body } = {}) {
  const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
  const target = new URL(`${API}${pathname}`);
  const headers = { Cookie: cookie };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        const rawCookies = res.headers["set-cookie"];
        if (rawCookies && rawCookies.length) {
          cookie = rawCookies.map((item) => item.split(";")[0]).join("; ");
          saveState({});
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text.slice(0, 500) };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function signup() {
  return api("/auth/signup", {
    method: "POST",
    body: { username: USER, email: EMAIL, password: PASS },
  });
}

async function login() {
  return api("/auth/login", {
    method: "POST",
    body: { username: USER, password: PASS },
  });
}

async function pollExperiment(id, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { status, json } = await api(`/experiments/${id}`);
    last = { status, json };
    const exp = json?.experiment;
    if (exp && exp.status && !["RUNNING", "PENDING"].includes(exp.status)) return exp;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Experiment ${id} did not finish. Last: ${JSON.stringify(last)?.slice(0, 800)}`);
}

async function waitSandboxRunning(id, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await api(`/sandboxes/${id}/runtime`);
    const sandbox = json?.sandbox;
    const services = json?.runtime?.services || [];
    const verified = services.filter((s) => s.verified && /^[a-f0-9]{64}$/.test(s.containerId || ""));
    if (sandbox?.status === "running" && verified.some((s) => s.service === "api") && verified.some((s) => s.service === "web-app")) {
      return { sandbox, runtime: json.runtime, error: json.error || json.runtime?.error || null };
    }
    if (sandbox?.status === "failed") {
      throw new Error(json.error || sandbox.error || "Sandbox failed");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Sandbox did not become running with verified api and web-app");
}

function summarize(exp) {
  const ev = exp.evidence || {};
  const http = ev.http || ev.phases || null;
  return {
    id: exp.id,
    faultType: exp.faultType,
    targetService: exp.targetService,
    status: exp.status,
    verdict: exp.verdict,
    cleanupStatus: exp.cleanupStatus,
    error: exp.error,
    p95: ev.p95 ?? ev.metrics?.p95 ?? null,
    sampleCount: ev.sampleCount ?? ev.metrics?.sampleCount ?? null,
    assertions: (ev.assertions || []).map((a) => ({
      name: a.name || a.id,
      passed: a.passed ?? a.result,
      observed: a.observed ?? a.actual,
      expected: a.expected,
    })),
    limitations: ev.limitations || [],
    measurementErrors: ev.measurementErrors || [],
    provenance: ev.provenance,
  };
}

async function main() {
  const cmd = process.argv[2];
  loadState();
  if (cmd === "signup") {
    console.log(JSON.stringify(await signup(), null, 2));
    return;
  }
  if (cmd === "login") {
    const result = await login();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === "caps") {
    console.log(JSON.stringify(await api("/experiments/capabilities"), null, 2));
    return;
  }
  if (cmd === "me") {
    console.log(JSON.stringify(await api("/auth/me"), null, 2));
    return;
  }
  if (cmd === "active") {
    console.log(JSON.stringify(await api("/sandboxes/active"), null, 2));
    return;
  }
  if (cmd === "ensure-sandbox") {
    const composeYaml = fs.readFileSync(
      path.join(__dirname, "..", "sandboxes", "approved-sample-compose.yml"),
      "utf8",
    );
    let active = (await api("/sandboxes/active")).json?.sandbox;
    if (!active) {
      const created = await api("/sandboxes", {
        method: "POST",
        body: { composeYaml, fileName: "approved-sample-compose.yml" },
      });
      if (!created.json?.sandbox) {
        console.log(JSON.stringify(created, null, 2));
        process.exit(1);
      }
      active = created.json.sandbox;
    }
    if (active.status !== "running") {
      const started = await api(`/sandboxes/${active.id}/start`, { method: "POST" });
      if (started.status >= 400 && started.json?.sandbox?.status !== "starting" && started.json?.sandbox?.status !== "running") {
        console.log(JSON.stringify(started, null, 2));
        process.exit(1);
      }
      active = started.json.sandbox || active;
    }
    const ready = await waitSandboxRunning(active.id);
    saveState({ sandboxId: ready.sandbox.id, projectName: ready.sandbox.projectName });
    console.log(JSON.stringify({ sandbox: ready.sandbox, services: ready.runtime?.services, error: ready.error }, null, 2));
    return;
  }
  if (cmd === "run") {
    const state = loadState();
    const body = JSON.parse(process.argv[3] || "{}");
    if (!body.sandboxId) body.sandboxId = state.sandboxId;
    body.mode = body.mode || "measured";
    body.hypothesis = body.hypothesis || "The service stays within its error and latency limits.";
    const started = await api("/experiments", { method: "POST", body });
    if (started.status !== 202) {
      console.log(JSON.stringify(started, null, 2));
      process.exit(1);
    }
    const exp = await pollExperiment(started.json.experiment.id, Number(process.argv[4] || 180000));
    const out = { summary: summarize(exp), experiment: exp };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === "suite") {
    const state = loadState();
    const common = {
      mode: "measured",
      sandboxId: state.sandboxId,
      targetService: "api",
      hypothesis: "The service stays within its error and latency limits.",
      baselineMs: 4000,
      faultDurationMs: 4000,
      recoveryMs: 4000,
      ratePerSecond: 5,
      concurrency: 2,
      timeoutMs: 1000,
      thresholds: { maxErrorRatePercent: 5, maxP95Ms: 1000, recoveryTimeoutMs: 5000 },
    };
    const jobs = [
      { name: "measure", body: { ...common, faultType: "measure" } },
      { name: "stop", body: { ...common, faultType: "stop" } },
      { name: "restart", body: { ...common, faultType: "restart" } },
      { name: "cpu", body: { ...common, faultType: "cpu" } },
      { name: "memory", body: { ...common, faultType: "memory", memoryMib: 8 } },
      {
        name: "latency",
        body: {
          ...common,
          faultType: "latency",
          latencyMs: 100,
          baselineMs: 6000,
          faultDurationMs: 6000,
          recoveryMs: 6000,
          ratePerSecond: 8,
        },
      },
      {
        name: "packet_loss",
        body: {
          ...common,
          faultType: "packet_loss",
          lossPercent: 5,
          baselineMs: 6000,
          faultDurationMs: 6000,
          recoveryMs: 6000,
          ratePerSecond: 8,
        },
      },
    ];
    const results = [];
    for (const job of jobs) {
      const started = await api("/experiments", { method: "POST", body: job.body });
      if (started.status !== 202) {
        results.push({ name: job.name, startError: started });
        continue;
      }
      const timeout = job.name === "latency" || job.name === "packet_loss" ? 240000 : 180000;
      try {
        const exp = await pollExperiment(started.json.experiment.id, timeout);
        results.push({ name: job.name, summary: summarize(exp), evidence: exp.evidence, error: exp.error, verdict: exp.verdict, status: exp.status, cleanupStatus: exp.cleanupStatus });
      } catch (err) {
        results.push({ name: job.name, pollError: err.message });
      }
    }
    const outPath = path.join(__dirname, "_browserPass.results.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.map((row) => ({
      name: row.name,
      status: row.status,
      verdict: row.verdict,
      cleanupStatus: row.cleanupStatus,
      error: row.error || row.pollError || row.startError?.json?.error,
      summary: row.summary,
    })), null, 2));
    return;
  }
  if (cmd === "invalid-fields") {
    const state = loadState();
    const started = await api("/experiments", {
      method: "POST",
      body: {
        mode: "measured",
        sandboxId: "not-a-uuid",
        faultType: "measure",
        targetService: "api",
        baselineMs: 50,
      },
    });
    const missing = await api("/experiments", {
      method: "POST",
      body: {
        mode: "measured",
        sandboxId: state.sandboxId,
        faultType: "not_a_fault",
        targetService: "api",
      },
    });
    console.log(JSON.stringify({ badSandbox: started, badFault: missing }, null, 2));
    return;
  }
  console.error("Unknown command");
  process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
