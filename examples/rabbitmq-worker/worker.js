import { openChannel } from "./amqp.js";

// Exits when the connection drops; Docker starts the worker again.
const channel = await openChannel(() => process.exit(1));
await channel.consume("jobs", (message) => {
  channel.sendToQueue("done", message.content, { persistent: true });
  channel.ack(message);
});
console.log("Waiting for jobs");
