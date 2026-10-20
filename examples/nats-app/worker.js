import { openNats } from "./nats.js";

const { nc, js, kv } = await openNats();
// Exits when the connection closes for good; Docker starts the worker again.
nc.closed().then(() => process.exit(1));
const consumer = await js.consumers.get("JOBS", "worker");
console.log("Waiting for jobs");
for await (const message of await consumer.consume()) {
  await kv.put(`done-${message.subject.split(".")[1]}`, "1");
  message.ack();
}
