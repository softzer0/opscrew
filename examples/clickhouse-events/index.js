import { createClient } from "@clickhouse/client";
import express from "express";

// CLICKHOUSE_URL holds the user, password and database: http://<user>:<password>@<host>:8123/<db>.
const clickhouse = createClient({ url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123" });
const table = () =>
  clickhouse.command({
    query:
      "CREATE TABLE IF NOT EXISTS events (at DateTime64(3) DEFAULT now64(3), value String) ENGINE = MergeTree ORDER BY at",
  });

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Each write is an event; the value is the latest one.
app.put("/data", express.text(), async (req, res) => {
  await table();
  await clickhouse.insert({ table: "events", values: [{ value: req.body }], format: "JSONEachRow" });
  res.sendStatus(204);
});

app.get("/data", async (_req, res) => {
  await table();
  const result = await clickhouse.query({
    query: "SELECT value FROM events ORDER BY at DESC LIMIT 1",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (rows.length === 0) res.sendStatus(404);
  else res.send(rows[0].value);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
