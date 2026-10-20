import express from "express";
import { queue, redis } from "./queue.js";

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.put("/data", express.text(), async (req, res) => {
  await redis.set("data", req.body);
  res.sendStatus(204);
});

app.get("/data", async (_req, res) => {
  const value = await redis.get("data");
  if (value === null) res.sendStatus(404);
  else res.send(value);
});

app.post("/jobs/:id", async (req, res) => {
  await queue.add("job", { id: req.params.id });
  res.sendStatus(202);
});

app.get("/jobs/:id", async (req, res) => {
  res.sendStatus((await redis.exists(`done:${req.params.id}`)) ? 200 : 404);
});

// The cron job in vercel.json calls this with the CRON_SECRET bearer token.
app.get("/api/cron/tick", async (req, res) => {
  if (req.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    res.sendStatus(401);
    return;
  }
  await redis.incr("cron-runs");
  res.sendStatus(204);
});

app.get("/cron", async (_req, res) => {
  const runs = Number(await redis.get("cron-runs"));
  res.status(runs > 0 ? 200 : 404).json({ runs });
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
