require("dotenv").config();

if (!process.env.SESSION_SECRET || !process.env.SESSION_SECRET.trim()) {
  console.error(
    "SESSION_SECRET is missing. Copy .env.example to .env and set SESSION_SECRET before starting the server.",
  );
  process.exit(1);
}

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const yaml = require("js-yaml");
const fs = require("fs");
const { exec } = require("child_process");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { initDatabase } = require("./database/database");
const { sessionMiddleware } = require("./auth/session");
const authRoutes = require("./routes/authRoutes");
const requireAuth = require("./middleware/requireAuth");
const experimentRoutes = require("./routes/experimentRoutes");
const sandboxRoutes = require("./routes/sandboxRoutes");
const { isSafeServiceName } = require("./experiments/dockerExecutor");

initDatabase();

const app = express();
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

// The UI on :3000 calls this API on :3001. Browsers only store that
// cross-origin session cookie when it is Secure + SameSite=None, and they
// accept Secure cookies on http://localhost. express-session withholds a
// Secure cookie unless the request looks like HTTPS, so local HTTP is
// treated as secure here. Production must actually be served over HTTPS.
if (process.env.NODE_ENV !== "production") {
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    req.headers["x-forwarded-proto"] = "https";
    next();
  });
}

app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
  }),
);
app.use(express.json());
app.use(sessionMiddleware());
app.use("/auth", authRoutes);
app.use("/experiments", requireAuth, experimentRoutes);
app.use("/sandboxes", requireAuth, sandboxRoutes);

const upload = multer({ dest: "uploads/" });

let graphData = {
  nodes: [],
  edges: []
};

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_TIMEOUT_MS = 25000;

const ADVISOR_SYSTEM_PROMPT =
  "You are the Resilience Advisor for MetricMantis. Explain this resilience report in simple language for a student. " +
  "Use the report as the only source of truth — never invent services, metrics, findings, or scores not present in it. " +
  "Compose analysis and browser chaos sections are simulations. A Measured experiment section contains observed numbers and a verdict already computed by the application. " +
  "Never invent metrics, never treat a missing measurement as zero, and never change the verdict. " +
  "Explain jargon in plain terms inline (e.g. say what a SPOF is the first time you use it). " +
  "If something cannot be answered from the report, say so clearly. Keep answers short and clear.";

function getGeminiClient() {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set in environment");
  return new GoogleGenerativeAI(key);
}

function redactAdvisorError(err) {
  return String(err?.message || err || "")
    .replace(/AIza[\w-]+/g, "[redacted]")
    .replace(/key=[^&\s]+/gi, "key=[redacted]")
    .slice(0, 240);
}

async function generateAdvisorText(prompt) {
  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel(
    { model: GEMINI_MODEL },
    { timeout: GEMINI_TIMEOUT_MS },
  );
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.();
  if (!text || !String(text).trim()) {
    const error = new Error("Empty advisor response");
    error.code = "EMPTY_RESPONSE";
    throw error;
  }
  return String(text).trim();
}

function sendAdvisorError(res, err, fallback) {
  const status = Number(err?.status) || 0;
  const raw = String(err?.message || "");
  console.error("Advisor request failed:", status || err?.code || "error", redactAdvisorError(err));
  if (status === 429 || /quota|rate limit|resource exhausted/i.test(raw)) {
    return res.status(429).json({ error: "Rate limit reached. Please wait a moment and try again." });
  }
  if (status === 503 || /high demand|unavailable|overloaded/i.test(raw)) {
    return res.status(503).json({ error: "Gemini is busy right now. Please try again in a moment." });
  }
  if (
    status === 401 ||
    status === 403 ||
    /API key not valid|API_KEY_INVALID|permission denied/i.test(raw)
  ) {
    return res.status(502).json({
      error: "Advisor could not authenticate with Gemini. Check GEMINI_API_KEY in the backend environment.",
    });
  }
  if (/timed out|timeout|aborted/i.test(raw)) {
    return res.status(504).json({ error: "Advisor timed out. Please try again." });
  }
  if (err?.code === "EMPTY_RESPONSE") {
    return res.status(502).json({ error: "Advisor returned an empty response. Please try again." });
  }
  return res.status(500).json({ error: fallback });
}

function dependencyTargets(dependsOn) {
  if (Array.isArray(dependsOn)) {
    return dependsOn.filter((name) => typeof name === "string" && name);
  }
  if (dependsOn && typeof dependsOn === "object") {
    return Object.keys(dependsOn);
  }
  return [];
}

// =============================
// Upload + Parse YAML
// =============================
app.post("/upload", requireAuth, upload.single("file"), (req, res) => {
  try {
    const fileContent = fs.readFileSync(req.file.path, "utf8");

    const parsed = yaml.load(fileContent);

    const services = parsed.services || {};

    const nodes = [];
    const edges = [];

    Object.keys(services).forEach((serviceName) => {
      nodes.push({
        id: serviceName,
        label: serviceName,
        status: "running"
      });

      dependencyTargets(services[serviceName]?.depends_on).forEach((dep) => {
        edges.push({
          from: serviceName,
          to: dep
        });
      });
    });

    graphData = { nodes, edges };

    res.json({
      success: true,
      graph: graphData
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to parse YAML"
    });
  }
});


// =============================
// Get Graph
// =============================
app.get("/graph", requireAuth, (req, res) => {
  res.json(graphData);
});


// =============================
// Stop Service (Chaos)
// =============================
app.post("/chaos/stop/:service", requireAuth, (req, res) => {
  const service = req.params.service;
  if (!isSafeServiceName(service)) {
    return res.status(400).json({ error: "Invalid service name." });
  }

  exec(`docker stop ${service}`, (err, stdout, stderr) => {

    graphData.nodes = graphData.nodes.map((node) => {
      if (node.id === service) {
        return { ...node, status: "failed" };
      }
      return node;
    });

    if (err) {
      return res.status(500).json({
        error: stderr
      });
    }

    res.json({
      message: `${service} stopped`,
      graph: graphData
    });
  });
});


// =============================
// Restart Service
// =============================
app.post("/chaos/restart/:service", requireAuth, (req, res) => {
  const service = req.params.service;
  if (!isSafeServiceName(service)) {
    return res.status(400).json({ error: "Invalid service name." });
  }

  exec(`docker start ${service}`, (err, stdout, stderr) => {

    graphData.nodes = graphData.nodes.map((node) => {
      if (node.id === service) {
        return { ...node, status: "running" };
      }
      return node;
    });

    if (err) {
      return res.status(500).json({
        error: stderr
      });
    }

    res.json({
      message: `${service} restarted`,
      graph: graphData
    });
  });
});


// =============================
// Logs
// =============================
app.get("/logs/:service", requireAuth, (req, res) => {
  const service = req.params.service;
  if (!isSafeServiceName(service)) {
    return res.status(400).json({ error: "Invalid service name." });
  }

  exec(`docker logs ${service}`, (err, stdout, stderr) => {

    if (err) {
      return res.status(500).json({
        error: stderr
      });
    }

    res.json({
      logs: stdout || stderr
    });
  });
});


// =============================
// Report
// =============================
app.get("/report", requireAuth, (req, res) => {

  const failedServices = graphData.nodes
    .filter((n) => n.status === "failed")
    .map((n) => n.id);

  res.json({
    summary: "MetricMantis Resilience Analysis",

    weakPoints: failedServices,

    recommendations: [
      "Add restart policies",
      "Implement retry logic",
      "Use database replication",
      "Add monitoring dashboards"
    ]
  });
});


// =============================
// Advisor helpers
// =============================

// Reduces the full AdvisorReport to the key signals only.
// Strips verbose paragraph text and simulated log output — keeps scores,
// service names, findings, and bullet-point facts. This keeps the prompt
// small so Gemini responds in 5-10s instead of 60-120s.
function buildSlimReport(report) { //function to slim down the report for the advisor in simple wordings
  return {
    scores: report.scores,
    findings: report.findings,
    sections: (report.sections || []).map((s) => ({
      id: s.id,
      title: s.title,
      bullets: s.bullets || [],
      // Include table rows (score breakdowns) but not paragraphs or logs
      table: s.table || undefined,
    })),
  };
}


// =============================
// Advisor — Summary
// =============================
app.post("/api/advisor/summary", requireAuth, async (req, res) => {
  const { report } = req.body;

  if (!report || typeof report !== "object") {
    return res.status(400).json({ error: "Report data is required." });
  }

  try {
    getGeminiClient();
  } catch (e) {
    return res.status(500).json({ error: "Advisor is not configured. GEMINI_API_KEY is missing." });
  }

  // Slim the report down to signal data only — skip verbose paragraphs and
  // simulated logs to keep the prompt small and fast.
  const slim = buildSlimReport(report);
  const reportText = JSON.stringify(slim, null, 2);

  const prompt =
    ADVISOR_SYSTEM_PROMPT +
    "\n\nHere is the resilience report data:\n" +
    reportText +
    "\n\nRespond with ONLY this JSON object (no markdown fences):\n" +
    "{ \"summary\": \"3-5 sentence plain-language explanation of the system condition, main weakness, and how failure propagates. Explain any jargon inline. Begin the summary with the words 'This system'.\", " +
    "\"suggestedQuestions\": [\"question 1\", \"question 2\", \"question 3\", \"question 4\"] }\n" +
    "The 4 questions must reference actual service names or findings from the report above.";

  try {
    const text = await generateAdvisorText(prompt);

    // Strip markdown code fences if the model wraps its output
    const cleaned = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: "Advisor returned an unexpected format. Please try again." });
    }

    if (!parsed.summary || !Array.isArray(parsed.suggestedQuestions)) {
      return res.status(500).json({ error: "Advisor response was incomplete. Please try again." });
    }

    res.json({
      summary: parsed.summary,
      suggestedQuestions: parsed.suggestedQuestions.slice(0, 4)
    });

  } catch (err) {
    return sendAdvisorError(res, err, "Advisor could not complete the analysis. Please try again.");
  }
});


// =============================
// Advisor — Chat
// =============================
app.post("/api/advisor/chat", requireAuth, async (req, res) => {
  const { report, history, question } = req.body;

  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Question cannot be empty." });
  }

  if (!report || typeof report !== "object") {
    return res.status(400).json({ error: "Report data is required." });
  }

  try {
    getGeminiClient();
  } catch (e) {
    return res.status(500).json({ error: "Advisor is not configured. GEMINI_API_KEY is missing." });
  }

  const slim = buildSlimReport(report);
  const reportText = JSON.stringify(slim, null, 2);

  const recentHistory = Array.isArray(history) ? history.slice(-6) : [];
  const historyBlock = recentHistory.length
    ? "\n\nConversation so far:\n" +
      recentHistory
        .map((m) => `${m.role === "user" ? "Student" : "Advisor"}: ${m.content}`)
        .join("\n")
    : "";

  const prompt =
    ADVISOR_SYSTEM_PROMPT +
    "\n\nResilience report data:\n" +
    reportText +
    historyBlock +
    "\n\nStudent: " +
    question.trim() +
    "\n\nAdvisor (answer concisely in plain language, referencing only the report above):";

  try {
    const answer = await generateAdvisorText(prompt);
    res.json({ answer });
  } catch (err) {
    return sendAdvisorError(res, err, "Advisor could not answer right now. Please try again.");
  }
});


const { createDockerExecutor, chaosStatusFromEnv } = require("./experiments/dockerExecutor");
const { recoverFaultLease } = require("./experiments/faultLease");
const { listByStatus, finishExperiment } = require("./database/experimentRepository");

const port = Number(process.env.PORT) || 3001;
recoverFaultLease(createDockerExecutor())
  .catch(() => {
    console.error("Fault cleanup after restart did not finish.");
  })
  .finally(() => {
    for (const experiment of listByStatus("RUNNING")) {
      finishExperiment(experiment.id, experiment.userId, {
        status: "ERROR",
        verdict: "ERROR",
        cleanupStatus: "failed",
        error: "The API restarted before the experiment finished. Fault cleanup was attempted.",
        finishedAt: new Date().toISOString(),
        evidence: experiment.evidence || {
          mode: experiment.mode,
          provenance: "observed",
          limitations: ["The API restarted before the experiment finished."],
          assertions: [],
          measurementErrors: [],
        },
      });
    }
    const server = app.listen(port, () => {
      const status = chaosStatusFromEnv(process.env);
      const allowlist = status.allowlist.length ? status.allowlist.join(", ") : "none";
      console.log(`MetricMantis backend running on ${port}`);
      console.log(`Real chaos is ${status.chaosEnabled ? "on" : "off"}. Allowlist: ${allowlist}.`);
    });
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use. This process did not replace the existing listener.`);
        process.exit(1);
      }
      console.error("The API could not listen.");
      process.exit(1);
    });
  });
