import { Worker } from "bullmq";
import { redis } from "./queue.js";

new Worker(
  "jobs",
  async (job) => {
    await redis.set(`done:${job.data.id}`, "1");
  },
  { connection: redis },
);
console.log("Waiting for jobs");
