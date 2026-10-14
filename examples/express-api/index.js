import express from "express";
import pg from "pg";

// The pool connects on the first query, so the server starts without the database.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
const port = process.env.PORT || 3000;

app.get("/", async (_req, res) => {
  const { rows } = await pool.query("SELECT now() AS now");
  res.json({ now: rows[0].now });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
