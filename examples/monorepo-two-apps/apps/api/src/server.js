import express from "express";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/items", async (_req, res) => {
  const result = await pool.query("select 1");
  res.json(result.rows);
});

app.listen(process.env.PORT ?? 4001);
