const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

// Expects this file to live in <repo-root>/loadtest/, alongside the repo's
// own supabase/migrations directory.
const MIGRATIONS_DIR = path.join(__dirname, "..", "supabase", "migrations");

async function main() {
  const client = new Client({
    host: "127.0.0.1",
    port: 54329,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  });
  await client.connect();

  console.log("-- bootstrap.sql");
  await client.query(fs.readFileSync(path.join(__dirname, "bootstrap.sql"), "utf8"));

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    console.log("--", f);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    try {
      await client.query(sql);
    } catch (err) {
      console.error("FAILED on", f, ":", err.message);
      process.exitCode = 1;
      await client.end();
      return;
    }
  }
  console.log("ALL_MIGRATIONS_APPLIED_OK");
  await client.end();
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
