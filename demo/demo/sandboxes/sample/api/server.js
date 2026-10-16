const http = require("http");
const { Client } = require("pg");

async function databaseReady() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
  });
  try {
    await client.connect();
    const result = await client.query("SELECT 1 AS ok");
    return result.rows[0] && result.rows[0].ok === 1;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404);
    res.end();
    return;
  }
  const ready = await databaseReady();
  res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ service: "api", db: ready ? "ok" : "down" }));
});

server.listen(8080, "0.0.0.0");
