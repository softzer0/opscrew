import { createTopics, kafka } from "./kafka.js";

const consumer = kafka.consumer({ groupId: "worker" });
const producer = kafka.producer();
await createTopics();
await Promise.all([consumer.connect(), producer.connect()]);
// From the start the first time, so no job queued before the group existed is missed.
await consumer.subscribe({ topic: "jobs", fromBeginning: true });
await consumer.run({
  eachMessage: async ({ message }) => {
    await producer.send({ topic: "done", messages: [{ value: message.value }] });
  },
});
console.log("Waiting for jobs");
