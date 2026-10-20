import { Kafka, logLevel } from "kafkajs";

export const kafka = new Kafka({
  clientId: "kafka-app",
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
  logLevel: logLevel.WARN,
});

/** Creates the app's topics when they are missing. */
export async function createTopics() {
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: ["jobs", "done", "data"].map((topic) => ({ topic })),
    waitForLeaders: true,
  });
  await admin.disconnect();
}
