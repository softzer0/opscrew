import { Queue } from "bullmq";
import { Redis } from "ioredis";

// BullMQ needs `maxRetriesPerRequest: null` on the connections it blocks on.
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
export const queue = new Queue("jobs", { connection: redis });
