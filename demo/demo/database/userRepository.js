const { getDatabase } = require("./database");

function findById(id) {
  return getDatabase()
    .prepare(
      "SELECT id, username, email, password_hash, created_at FROM users WHERE id = ?",
    )
    .get(id);
}

function findByUsername(username) {
  return getDatabase()
    .prepare(
      "SELECT id, username, email, password_hash, created_at FROM users WHERE username = ? COLLATE NOCASE",
    )
    .get(username);
}

function findByEmail(email) {
  return getDatabase()
    .prepare(
      "SELECT id, username, email, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE",
    )
    .get(email);
}

function createUser({ username, email, passwordHash }) {
  const result = getDatabase()
    .prepare(
      "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
    )
    .run(username, email, passwordHash);

  return findById(Number(result.lastInsertRowid));
}

module.exports = {
  findById,
  findByUsername,
  findByEmail,
  createUser,
};
