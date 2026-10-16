const crypto = require("crypto");
const express = require("express");
const { createDockerExecutor } = require("../experiments/dockerExecutor");
const { validateExperiment, executeExperiment, resolveSandboxTarget, probeAllowlist } = require("../experiments/experimentService");
const { probeEndpoint } = require("../experiments/sandboxProbe");
const {
  createExperiment,
  markRunning,
  updateProgress,
  finishExperiment,
  getExperiment,
  listExperiments,
  hasRunning,
  countSince,
} = require("../database/experimentRepository");

const router = express.Router();
const active = new Map();

router.get("/capabilities", async (_req, res) => {
  const docker = createDockerExecutor();
  const capabilities = await docker.capabilities();
  res.json({
    ...capabilities,
    probeAllowlist: probeAllowlist(),
    blockedProbePorts: [3000, 3001],
  });
});

router.get("/", (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 20));
  res.json({ experiments: listExperiments(req.session.user.userId, limit) });
});

router.get("/:id", (req, res) => {
  const experiment = getExperiment(req.params.id, req.session.user.userId);
  if (!experiment) return res.status(404).json({ error: "Experiment not found." });
  res.json({ experiment });
});

router.post("/:id/cancel", (req, res) => {
  const experiment = getExperiment(req.params.id, req.session.user.userId);
  if (!experiment) return res.status(404).json({ error: "Experiment not found." });
  const run = active.get(req.params.id);
  if (!run || run.userId !== req.session.user.userId) {
    return res.status(409).json({ error: "This experiment is not running." });
  }
  run.controller.abort();
  res.json({ success: true });
});

router.post("/", async (req, res) => {
  const userId = req.session.user.userId;
  const validated = validateExperiment(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  let config = validated.value;
  if (config.mode === "measured") {
    const resolved = await resolveSandboxTarget(userId, config.sandboxId, config.targetService);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    if (config.faultType === "measure" && !probeEndpoint(config.targetService)) {
      return res.status(409).json({ error: "This sandbox service has no approved HTTP health endpoint." });
    }
    config = { ...config, verifiedContainer: resolved.container };
  }
  if (hasRunning(userId)) {
    return res.status(429).json({ error: "An experiment is already running." });
  }
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  if (countSince(userId, since) >= 8) {
    return res.status(429).json({ error: "Experiment rate limit reached. Try again later." });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  createExperiment({
    id,
    userId,
    name: validated.value.name,
    hypothesis: validated.value.hypothesis,
    targetService: validated.value.targetService,
    faultType: validated.value.faultType,
    mode: validated.value.mode,
    config,
    createdAt,
  });
  const controller = new AbortController();
  active.set(id, { controller, userId });
  markRunning(id, userId, createdAt);

  const running = getExperiment(id, userId);
  res.status(202).json({ experiment: running });

  void executeExperiment(config, {
    fetchImpl: global.fetch,
    sandboxProbe: true,
    docker: createDockerExecutor(),
    signal: controller.signal,
    onProgress: (evidence) => updateProgress(id, userId, evidence),
  }).then((result) => {
    finishExperiment(id, userId, result);
  }).catch((error) => {
    finishExperiment(id, userId, {
      status: "ERROR",
      verdict: "ERROR",
      cleanupStatus: "failed",
      error: "The experiment stopped because of an internal error.",
      finishedAt: new Date().toISOString(),
      evidence: {
        mode: validated.value.mode,
        provenance: validated.value.mode === "simulation" ? "predicted" : "observed",
        limitations: ["The experiment stopped because of an internal error."],
        assertions: [],
        measurementErrors: [],
      },
    });
    console.error("Experiment failed:", error && error.message ? error.message.slice(0, 180) : "error");
  }).finally(() => {
    active.delete(id);
  });
});

module.exports = router;
