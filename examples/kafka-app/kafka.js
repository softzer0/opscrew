import { Kafka, logLevel } from "kafkajs";

// The broker's login, when it asks for one (`login: true` in opscrew/plan.yaml).
const username = process.env.KAFKA_SASL_USERNAME;

export const kafka = new Kafka({
  clientId: "kafka-app",
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
  ...(username
    ? {
        sasl: {
          mechanism: (process.env.KAFKA_SASL_MECHANISM ?? "SCRAM-SHA-512").toLowerCase(),
          username,
          password: process.env.KAFKA_SASL_PASSWORD,
        },
      }
    : {}),
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
