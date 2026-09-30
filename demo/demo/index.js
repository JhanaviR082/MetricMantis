require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const yaml = require("js-yaml");
const fs = require("fs");
const { exec } = require("child_process");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

let graphData = {
  nodes: [],
  edges: []
};

const ADVISOR_SYSTEM_PROMPT =
  "You are the Resilience Advisor for MetricMantis. Explain this resilience report in simple language for a student. " +
  "Use the report as the only source of truth — never invent services, metrics, findings, or scores not present in it. " +
  "Explain jargon in plain terms inline (e.g. say what a SPOF is the first time you use it). " +
  "If something cannot be answered from the report, say so clearly. Keep answers short and clear.";

function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set in environment");
  return new GoogleGenerativeAI(key);
}

// =============================
// Upload + Parse YAML
// =============================
app.post("/upload", upload.single("file"), (req, res) => {
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

      if (services[serviceName].depends_on) {
        services[serviceName].depends_on.forEach((dep) => {
          edges.push({
            from: serviceName,
            to: dep
          });
        });
      }
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
app.get("/graph", (req, res) => {
  res.json(graphData);
});


// =============================
// Stop Service (Chaos)
// =============================
app.post("/chaos/stop/:service", (req, res) => {
  const service = req.params.service;

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
app.post("/chaos/restart/:service", (req, res) => {
  const service = req.params.service;

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
app.get("/logs/:service", (req, res) => {
  const service = req.params.service;

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
app.get("/report", (req, res) => {

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
app.post("/api/advisor/summary", async (req, res) => {
  const { report } = req.body;

  if (!report || typeof report !== "object") {
    return res.status(400).json({ error: "Report data is required." });
  }

  let genAI;
  try {
    genAI = getGeminiClient();
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
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

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
    console.error("Advisor summary error:", err);
    if (err.status === 429 || (err.message && err.message.includes("quota"))) {
      return res.status(429).json({ error: "Rate limit reached. Please wait a moment and try again." });
    }
    res.status(500).json({ error: "Advisor could not complete the analysis. Please try again." });
  }
});


// =============================
// Advisor — Chat
// =============================
app.post("/api/advisor/chat", async (req, res) => {
  const { report, history, question } = req.body;

  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Question cannot be empty." });
  }

  if (!report || typeof report !== "object") {
    return res.status(400).json({ error: "Report data is required." });
  }

  let genAI;
  try {
    genAI = getGeminiClient();
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
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
    const result = await model.generateContent(prompt);
    const answer = result.response.text().trim();

    res.json({ answer });

  } catch (err) {
    console.error("Advisor chat error:", err);
    if (err.status === 429 || (err.message && err.message.includes("quota"))) {
      return res.status(429).json({ error: "Rate limit reached. Please wait a moment and try again." });
    }
    res.status(500).json({ error: "Advisor could not answer right now. Please try again." });
  }
});


app.listen(3001, () => {
  console.log("MetricMantis backend running on 3001");
});
