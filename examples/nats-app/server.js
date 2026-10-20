import express from "express";
import { openNats } from "./nats.js";

// Opened on the first request, so the server starts without NATS; opened again once it closed.
let ready;
const nats = () => {
  ready ??= openNats().then(
    (opened) => {
      opened.nc.closed().then(() => {
        ready = undefined;
      });
      return opened;
    },
    (error) => {
      ready = undefined;
      throw error;
    },
  );
  return ready;
};

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.put("/data", express.text(), async (req, res) => {
  await (await nats()).kv.put("data", req.body);
  res.sendStatus(204);
});

app.get("/data", async (_req, res) => {
  const entry = await (await nats()).kv.get("data");
  if (entry === null) res.sendStatus(404);
  else res.send(entry.string());
});

app.post("/jobs/:id", async (req, res) => {
  await (await nats()).js.publish(`jobs.${req.params.id}`);
  res.sendStatus(202);
});

app.get("/jobs/:id", async (req, res) => {
  const entry = await (await nats()).kv.get(`done-${req.params.id}`);
  res.sendStatus(entry === null ? 404 : 200);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
