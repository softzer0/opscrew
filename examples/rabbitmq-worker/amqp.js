import amqp from "amqplib";

/** A channel with the app's durable queues; `onClose` runs when the connection drops. */
export async function openChannel(onClose) {
  const connection = await amqp.connect(process.env.AMQP_URL ?? "amqp://localhost");
  connection.on("error", () => {});
  connection.on("close", onClose);
  const channel = await connection.createChannel();
  for (const queue of ["jobs", "done", "data"]) await channel.assertQueue(queue, { durable: true });
  return channel;
}
