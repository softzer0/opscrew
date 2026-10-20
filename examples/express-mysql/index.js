import express from "express";
import mysql from "mysql2/promise";

// The pool connects on the first query, so the server starts without the database.
const pool = mysql.createPool(process.env.DATABASE_URL ?? "mysql://localhost:3306/app");
const table = () =>
  pool.query(
    "CREATE TABLE IF NOT EXISTS items (name VARCHAR(64) PRIMARY KEY, value TEXT NOT NULL)",
  );

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.put("/data", express.text(), async (req, res) => {
  await table();
  await pool.query("REPLACE INTO items (name, value) VALUES ('data', ?)", [req.body]);
  res.sendStatus(204);
});

app.get("/data", async (_req, res) => {
  await table();
  const [rows] = await pool.query("SELECT value FROM items WHERE name = 'data'");
  if (rows.length === 0) res.sendStatus(404);
  else res.send(rows[0].value);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
