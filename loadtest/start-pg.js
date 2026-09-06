// Starts a real, local Postgres process (no Docker, no root) and keeps it
// running so separate test scripts can connect to it. Data dir + port are
// fixed so subsequent script invocations know where to find it.
const path = require("path");
const EmbeddedPostgres = require("embedded-postgres").default;

const pg = new EmbeddedPostgres({
  databaseDir: path.join(__dirname, "pgdata"),
  user: "postgres",
  password: "postgres",
  port: 54329,
  persistent: true,
});

(async () => {
  await pg.initialise();
  await pg.start();
  console.log("PG_READY");
})().catch((err) => {
  console.error("PG_START_FAILED", err);
  process.exit(1);
});
