const express = require("express");
const {
  createSandboxRecord,
  getSandboxRecord,
  getActiveSandboxRecord,
  readSandboxRuntime,
  startSandbox,
  cleanupSandboxRecord,
} = require("../sandboxes/sandboxService");

const router = express.Router();

router.post("/", (req, res) => {
  const result = createSandboxRecord(req.session.user.userId, req.body);
  if (result.error) {
    return res.status(result.status).json({
      error: result.error,
      ...(result.sandbox ? { sandbox: result.sandbox } : {}),
    });
  }
  res.status(result.status).json({ sandbox: result.sandbox });
});

router.get("/active", (req, res) => {
  res.json({ sandbox: getActiveSandboxRecord(req.session.user.userId) });
});

router.post("/:id/start", async (req, res) => {
  try {
    const deps = req.app.get("sandboxDeps") || {};
    const result = await startSandbox(req.session.user.userId, req.params.id, deps);
    if (!result.sandbox) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ sandbox: result.sandbox, error: result.error || null });
  } catch {
    res.status(500).json({ error: "Sandbox start failed." });
  }
});

router.get("/:id/runtime", async (req, res) => {
  try {
    const deps = req.app.get("sandboxDeps") || {};
    const result = await readSandboxRuntime(req.session.user.userId, req.params.id, deps);
    if (!result.sandbox) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({
      sandbox: result.sandbox,
      runtime: result.runtime || null,
      error: result.error || null,
    });
  } catch {
    res.status(500).json({ error: "Sandbox runtime status failed." });
  }
});

router.get("/:id", (req, res) => {
  const sandbox = getSandboxRecord(req.session.user.userId, req.params.id);
  if (!sandbox) return res.status(404).json({ error: "Sandbox not found." });
  res.json({ sandbox });
});

router.post("/:id/cleanup", async (req, res) => {
  try {
    const deps = req.app.get("sandboxDeps") || {};
    const result = await cleanupSandboxRecord(req.session.user.userId, req.params.id, deps);
    if (!result.sandbox) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ sandbox: result.sandbox, error: result.error || null });
  } catch {
    res.status(500).json({ error: "Sandbox cleanup failed." });
  }
});

module.exports = router;
