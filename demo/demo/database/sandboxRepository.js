const { getDatabase } = require("./database");

const STATUSES = new Set(["created", "starting", "running", "stopping", "stopped", "failed"]);

function rowToSandbox(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    projectName: row.project_name,
    status: row.status,
    composeSha256: row.compose_sha256,
    fileName: row.file_name,
    services: JSON.parse(row.services_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
  };
}

function createSandbox(input) {
  if (!STATUSES.has(input.status)) {
    throw new Error("Invalid sandbox status.");
  }
  getDatabase().prepare(`
    INSERT INTO sandboxes (
      id, user_id, project_name, status, compose_sha256, compose_yaml, file_name,
      services_json, error, created_at, updated_at, started_at, stopped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    input.id,
    input.userId,
    input.projectName,
    input.status,
    input.composeSha256,
    input.composeYaml,
    input.fileName || null,
    JSON.stringify(input.services),
    input.error || null,
    input.createdAt,
    input.updatedAt,
  );
  return getSandbox(input.id, input.userId);
}

function getSandbox(id, userId) {
  const row = getDatabase().prepare(
    "SELECT * FROM sandboxes WHERE id = ? AND user_id = ?",
  ).get(id, userId);
  return rowToSandbox(row);
}

function findCreatedByHash(userId, composeSha256) {
  const row = getDatabase().prepare(`
    SELECT * FROM sandboxes
    WHERE user_id = ? AND status = 'created' AND compose_sha256 = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, composeSha256);
  return rowToSandbox(row);
}

function findActive(userId) {
  const row = getDatabase().prepare(`
    SELECT * FROM sandboxes
    WHERE user_id = ? AND status IN ('starting', 'running', 'stopping')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId);
  return rowToSandbox(row);
}

function listCreated(userId) {
  return getDatabase().prepare(`
    SELECT * FROM sandboxes
    WHERE user_id = ? AND status = 'created'
    ORDER BY created_at ASC
  `).all(userId).map(rowToSandbox);
}

function markStopped(id, userId, stoppedAt) {
  getDatabase().prepare(`
    UPDATE sandboxes
    SET status = 'stopped', error = NULL, updated_at = ?, stopped_at = ?
    WHERE id = ? AND user_id = ? AND status IN ('created', 'failed')
  `).run(stoppedAt, stoppedAt, id, userId);
  return getSandbox(id, userId);
}

function claimStart(userId, id, timestamp) {
  const database = getDatabase();
  return database.transaction(() => {
    const active = database.prepare(`
      SELECT COUNT(*) AS count FROM sandboxes
      WHERE user_id = ? AND id != ? AND status IN ('starting', 'running', 'stopping')
    `).get(userId, id).count;
    if (active > 0) return { conflict: "active" };
    const result = database.prepare(`
      UPDATE sandboxes
      SET status = 'starting', error = NULL, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'created'
    `).run(timestamp, id, userId);
    if (result.changes !== 1) return { conflict: "state" };
    return { sandbox: getSandbox(id, userId) };
  })();
}

function claimStop(id, userId, fromStatuses, timestamp) {
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const result = getDatabase().prepare(`
    UPDATE sandboxes
    SET status = 'stopping', error = NULL, updated_at = ?
    WHERE id = ? AND user_id = ? AND status IN (${placeholders})
  `).run(timestamp, id, userId, ...fromStatuses);
  return result.changes === 1 ? getSandbox(id, userId) : null;
}

function saveRunning(id, userId, services, timestamp) {
  const result = getDatabase().prepare(`
    UPDATE sandboxes
    SET status = 'running', services_json = ?, error = NULL, updated_at = ?, started_at = ?
    WHERE id = ? AND user_id = ? AND status = 'starting'
  `).run(JSON.stringify(services), timestamp, timestamp, id, userId);
  return result.changes === 1 ? getSandbox(id, userId) : null;
}

function saveFailed(id, userId, error, timestamp) {
  getDatabase().prepare(`
    UPDATE sandboxes
    SET status = 'failed', error = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status IN ('starting', 'running', 'stopping', 'failed')
  `).run(String(error || "Sandbox failed.").slice(0, 300), timestamp, id, userId);
  return getSandbox(id, userId);
}

function saveStopped(id, userId, services, timestamp) {
  const result = getDatabase().prepare(`
    UPDATE sandboxes
    SET status = 'stopped', services_json = ?, error = NULL, updated_at = ?, stopped_at = ?
    WHERE id = ? AND user_id = ? AND status = 'stopping'
  `).run(JSON.stringify(services), timestamp, timestamp, id, userId);
  return result.changes === 1 ? getSandbox(id, userId) : null;
}

module.exports = {
  STATUSES,
  createSandbox,
  getSandbox,
  findCreatedByHash,
  findActive,
  listCreated,
  markStopped,
  claimStart,
  claimStop,
  saveRunning,
  saveFailed,
  saveStopped,
};
