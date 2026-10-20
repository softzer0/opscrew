import express from "express";
import { openChannel } from "./amqp.js";

// Opened on the first request, so the server starts without RabbitMQ; opened again after a drop.
let ready;
const channel = () => {
  ready ??= openChannel(() => {
    ready = undefined;
  }).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
};

const app = express();
const port = process.env.PORT || 3000;
const done = new Set();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// One persistent message in the `data` queue holds the value.
app.put("/data", express.text(), async (req, res) => {
  const ch = await channel();
  await ch.purgeQueue("data");
  ch.sendToQueue("data", Buffer.from(req.body), { persistent: true });
  res.sendStatus(204);
});

app.get("/data", async (_req, res) => {
  const ch = await channel();
  const message = await ch.get("data");
  if (message === false) {
    res.sendStatus(404);
    return;
  }
  ch.nack(message, false, true);
  res.send(message.content.toString());
});

app.post("/jobs/:id", async (req, res) => {
  (await channel()).sendToQueue("jobs", Buffer.from(req.params.id), { persistent: true });
  res.sendStatus(202);
});

// The worker reports each finished job in the `done` queue.
app.get("/jobs/:id", async (req, res) => {
  const ch = await channel();
  for (let message = await ch.get("done"); message !== false; message = await ch.get("done")) {
    done.add(message.content.toString());
    ch.ack(message);
  }
  res.sendStatus(done.has(req.params.id) ? 200 : 404);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
