import { randomUUID } from "node:crypto";
import express from "express";
import { createTopics, kafka } from "./kafka.js";

const producer = kafka.producer();
const done = new Set();
let data;

// Reads `done` and `data` from the start in a group of its own each time the app starts, so a
// restarted app sees what was written before.
async function start() {
  await createTopics();
  await producer.connect();
  const consumer = kafka.consumer({ groupId: `web-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topics: ["done", "data"], fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (topic === "done") done.add(message.value.toString());
      else data = message.value.toString();
    },
  });
}
start().catch((error) => {
  console.error(error);
  process.exit(1);
});

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.put("/data", express.text(), async (req, res) => {
  await producer.send({ topic: "data", messages: [{ value: req.body }] });
  res.sendStatus(204);
});

app.get("/data", (_req, res) => {
  if (data === undefined) res.sendStatus(404);
  else res.send(data);
});

app.post("/jobs/:id", async (req, res) => {
  await producer.send({ topic: "jobs", messages: [{ value: req.params.id }] });
  res.sendStatus(202);
});

app.get("/jobs/:id", (req, res) => {
  res.sendStatus(done.has(req.params.id) ? 200 : 404);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
