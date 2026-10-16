const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");

const dbPath = path.join(os.tmpdir(), `metricmantis-api-${process.pid}.db`);
const invalidDbPath = path.join(os.tmpdir(), `metricmantis-api-invalid-${process.pid}.db`);
const port = 31991;
const invalidPort = 31992;
const base = `http://127.0.0.1:${port}`;

const SAMPLE = `services:
  web-app:
    image: nginx:alpine
    depends_on:
      - api
  api:
    image: node:20-alpine
    depends_on:
      db:
        condition: service_started
  db:
    image: mysql:8.0
`;

function cookieFrom(response) {
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.map((entry) => entry.split(";")[0]).join("; ");
}

function startServer(extraEnv, listenPort = port, databasePath = dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["index.js"], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(listenPort),
        SESSION_SECRET: "integration-test-secret",
        FRONTEND_URL: "http://localhost:3000",
        METRICMANTIS_DB_PATH: databasePath,
        GEMINI_API_KEY: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start: ${output.slice(0, 400)}`));
    }, 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(`running on ${listenPort}`)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!output.includes(`running on ${listenPort}`)) {
        reject(new Error(`server exited ${code}`));
      }
    });
  });
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

async function signupAndLogin() {
  const signup = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "tester",
      email: "tester@example.com",
      password: "password123",
    }),
  });
  assert.equal(signup.status, 201);

  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "tester", password: "password123" }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  return { cookie: cookieFrom(login), user: body.user };
}

test("HTTP auth, compose upload, advisor key, and protected routes", async (t) => {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
  const child = await startServer();
  t.after(async () => {
    await stopServer(child);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
  });

  const badSignup = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "x", email: "not-an-email", password: "short" }),
  });
  assert.equal(badSignup.status, 400);

  const session = await signupAndLogin();
  assert.equal(session.user.username, "tester");

  const duplicate = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "tester",
      email: "other@example.com",
      password: "password123",
    }),
  });
  assert.equal(duplicate.status, 409);

  const badLogin = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "tester", password: "wrong-password" }),
  });
  assert.equal(badLogin.status, 401);

  const me = await fetch(`${base}/auth/me`, { headers: { Cookie: session.cookie } });
  const meBody = await me.json();
  assert.equal(meBody.authenticated, true);

  const noAuth = await fetch(`${base}/report`);
  assert.equal(noAuth.status, 401);

  const report = await fetch(`${base}/report`, { headers: { Cookie: session.cookie } });
  assert.equal(report.status, 200);

  const form = new FormData();
  form.append("file", new Blob([SAMPLE], { type: "text/yaml" }), "stack.yml");
  const uploaded = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Cookie: session.cookie },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const graph = await uploaded.json();
  assert.deepEqual(
    graph.graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort(),
    ["api->db", "web-app->api"],
  );

  const badForm = new FormData();
  badForm.append("file", new Blob(["services: [\n"], { type: "text/yaml" }), "bad.yml");
  const badUpload = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Cookie: session.cookie },
    body: badForm,
  });
  assert.equal(badUpload.status, 500);
  const badBody = await badUpload.json();
  assert.equal(badBody.error, "Failed to parse YAML");

  const advisorReport = {
    scores: { overall: 4, dependencySafety: 4, faultTolerance: 4, recoveryCapability: 4, monitoringVisibility: 4 },
    findings: [],
    sections: [{ id: "overview", title: "System Overview", bullets: ["web-app depends on api"] }],
  };
  const missingKey = await fetch(`${base}/api/advisor/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    body: JSON.stringify({ report: advisorReport }),
  });
  const missingBody = await missingKey.json();
  assert.equal(missingKey.status, 500);
  assert.equal(missingBody.error, "Advisor is not configured. GEMINI_API_KEY is missing.");

  const emptyQuestion = await fetch(`${base}/api/advisor/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    body: JSON.stringify({ report: advisorReport, history: [], question: "   " }),
  });
  assert.equal(emptyQuestion.status, 400);

  const advisorAnon = await fetch(`${base}/api/advisor/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report: advisorReport }),
  });
  assert.equal(advisorAnon.status, 401);

  const chaosAnon = await fetch(`${base}/chaos/stop/db`, { method: "POST" });
  assert.equal(chaosAnon.status, 401);

  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { Cookie: session.cookie },
  });
  assert.equal(logout.status, 200);
  const after = await fetch(`${base}/auth/me`, { headers: { Cookie: session.cookie } });
  const afterBody = await after.json();
  assert.equal(afterBody.authenticated, false);
});

test("invalid Gemini key is rejected without returning the key", async (t) => {
  for (const file of [invalidDbPath, `${invalidDbPath}-wal`, `${invalidDbPath}-shm`]) {
    fs.rmSync(file, { force: true });
  }
  const child = await startServer({ GEMINI_API_KEY: "invalid-test-key" }, invalidPort, invalidDbPath);
  const invalidBase = `http://127.0.0.1:${invalidPort}`;
  t.after(async () => {
    await stopServer(child);
    for (const file of [invalidDbPath, `${invalidDbPath}-wal`, `${invalidDbPath}-shm`]) {
      fs.rmSync(file, { force: true });
    }
  });

  await fetch(`${invalidBase}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "advisor",
      email: "advisor@example.com",
      password: "password123",
    }),
  });
  const login = await fetch(`${invalidBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "advisor", password: "password123" }),
  });
  const cookie = cookieFrom(login);
  const response = await fetch(`${invalidBase}/api/advisor/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      report: {
        scores: { overall: 1, dependencySafety: 1, faultTolerance: 1, recoveryCapability: 1, monitoringVisibility: 1 },
        findings: [],
        sections: [],
      },
    }),
  });
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("invalid-test-key"), false);
  assert.equal(serialized.includes("AIza"), false);
  assert.ok(response.status === 502 || response.status === 500 || response.status === 503);
  assert.equal(typeof body.error, "string");
});

test("measured experiments require auth, a sandbox, and do not probe without one", async (t) => {
  const http = require("http");
  let probeHits = 0;
  const probe = http.createServer((_req, res) => {
    probeHits += 1;
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const probePort = probe.address().port;
  const experimentDb = path.join(os.tmpdir(), `metricmantis-exp-http-${process.pid}.db`);
  const experimentPort = 31994;
  const experimentBase = `http://127.0.0.1:${experimentPort}`;
  for (const file of [experimentDb, `${experimentDb}-wal`, `${experimentDb}-shm`]) fs.rmSync(file, { force: true });
  const child = await startServer({}, experimentPort, experimentDb);
  t.after(async () => {
    await stopServer(child);
    probe.close();
    for (const file of [experimentDb, `${experimentDb}-wal`, `${experimentDb}-shm`]) fs.rmSync(file, { force: true });
  });

  const anon = await fetch(`${experimentBase}/experiments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401);

  const signup = await fetch(`${experimentBase}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "measurer", email: "measurer@example.com", password: "password123" }),
  });
  assert.equal(signup.status, 201);
  const login = await fetch(`${experimentBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "measurer", password: "password123" }),
  });
  const cookie = cookieFrom(login);

  const badName = await fetch(`${experimentBase}/chaos/stop/${encodeURIComponent("api;rm")}`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(badName.status, 400);

  const created = await fetch(`${experimentBase}/experiments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      mode: "measured",
      faultType: "measure",
      targetService: "api",
      probeUrl: `http://127.0.0.1:${probePort}/health`,
      baselineMs: 400,
      ratePerSecond: 15,
      thresholds: { maxErrorRatePercent: 5, maxP95Ms: 2000 },
      edges: [{ from: "web-app", to: "api" }],
    }),
  });
  const createdBody = await created.json();
  assert.equal(created.status, 400);
  assert.match(createdBody.error, /sandbox/i);
  assert.equal(probeHits, 0);

  const missing = await fetch(`${experimentBase}/experiments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      mode: "measured",
      sandboxId: "11111111-1111-4111-8111-111111111111",
      faultType: "measure",
      targetService: "api",
      probeUrl: `http://127.0.0.1:${probePort}/health`,
      baselineMs: 400,
      ratePerSecond: 5,
    }),
  });
  assert.equal(missing.status, 404);
  assert.equal(probeHits, 0);

  const simulation = await fetch(`${experimentBase}/experiments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      mode: "simulation",
      faultType: "cpu",
      targetService: "api",
      edges: [{ from: "web-app", to: "api" }],
    }),
  });
  const simulationBody = await simulation.json();
  assert.equal(simulation.status, 202);
  let finished = simulationBody.experiment;
  for (let attempt = 0; attempt < 20 && (finished.status === "RUNNING" || finished.status === "PENDING"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const polled = await fetch(`${experimentBase}/experiments/${simulationBody.experiment.id}`, { headers: { Cookie: cookie } });
    finished = (await polled.json()).experiment;
  }
  assert.equal(finished.evidence.provenance, "predicted");
  assert.equal(probeHits, 0);

  const other = await fetch(`${experimentBase}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "otheruser", email: "otheruser@example.com", password: "password123" }),
  });
  assert.equal(other.status, 201);
  const otherLogin = await fetch(`${experimentBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "otheruser", password: "password123" }),
  });
  const hidden = await fetch(`${experimentBase}/experiments/${simulationBody.experiment.id}`, {
    headers: { Cookie: cookieFrom(otherLogin) },
  });
  assert.equal(hidden.status, 404);
});
