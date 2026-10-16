const { getDatabase } = require("./database");

function rowToExperiment(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    hypothesis: row.hypothesis,
    targetService: row.target_service,
    faultType: row.fault_type,
    mode: row.mode,
    status: row.status,
    verdict: row.verdict,
    config: JSON.parse(row.config_json),
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    error: row.error,
    cleanupStatus: row.cleanup_status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function createExperiment(input) {
  const database = getDatabase();
  database.prepare(`
    INSERT INTO experiments (
      id, user_id, name, hypothesis, target_service, fault_type, mode, status,
      config_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
  `).run(
    input.id,
    input.userId,
    input.name,
    input.hypothesis,
    input.targetService,
    input.faultType,
    input.mode,
    JSON.stringify(input.config),
    input.createdAt,
  );
  prune(input.userId, 50);
  return getExperiment(input.id, input.userId);
}

function markRunning(id, userId, startedAt) {
  getDatabase().prepare(
    "UPDATE experiments SET status = 'RUNNING', started_at = ? WHERE id = ? AND user_id = ?",
  ).run(startedAt, id, userId);
}

function updateProgress(id, userId, evidence) {
  getDatabase().prepare(`
    UPDATE experiments
    SET evidence_json = ?
    WHERE id = ? AND user_id = ? AND status = 'RUNNING'
  `).run(JSON.stringify(evidence), id, userId);
}

function finishExperiment(id, userId, result) {
  getDatabase().prepare(`
    UPDATE experiments
    SET status = ?, verdict = ?, evidence_json = ?, error = ?, cleanup_status = ?, finished_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    result.status,
    result.verdict,
    JSON.stringify(result.evidence),
    result.error || null,
    result.cleanupStatus || null,
    result.finishedAt,
    id,
    userId,
  );
  return getExperiment(id, userId);
}

function getExperiment(id, userId) {
  const row = getDatabase().prepare(
    "SELECT * FROM experiments WHERE id = ? AND user_id = ?",
  ).get(id, userId);
  return rowToExperiment(row);
}

function listExperiments(userId, limit = 20) {
  const rows = getDatabase().prepare(
    "SELECT * FROM experiments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(userId, limit);
  return rows.map(rowToExperiment);
}

function listByStatus(status) {
  const rows = getDatabase().prepare(
    "SELECT * FROM experiments WHERE status = ?",
  ).all(status);
  return rows.map(rowToExperiment);
}

function hasRunning(userId) {
  const row = getDatabase().prepare(
    "SELECT id FROM experiments WHERE user_id = ? AND status = 'RUNNING' LIMIT 1",
  ).get(userId);
  return Boolean(row);
}

function countSince(userId, sinceIso) {
  const row = getDatabase().prepare(
    "SELECT COUNT(*) AS count FROM experiments WHERE user_id = ? AND created_at >= ?",
  ).get(userId, sinceIso);
  return row.count;
}

function prune(userId, keep) {
  getDatabase().prepare(`
    DELETE FROM experiments
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id FROM experiments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
      )
  `).run(userId, userId, keep);
}

module.exports = {
  createExperiment,
  markRunning,
  updateProgress,
  finishExperiment,
  getExperiment,
  listExperiments,
  hasRunning,
  listByStatus,
  countSince,
};
