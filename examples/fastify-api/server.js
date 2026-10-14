import Fastify from "fastify";
import { Redis } from "ioredis";

const fastify = Fastify({ logger: true });

// lazyConnect: the client connects on the first command, so the server starts without Redis.
fastify.decorate(
  "redis",
  new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true }),
);
fastify.addHook("onClose", async (instance) => {
  await instance.redis.quit();
});

fastify.get("/", async () => {
  return { visits: await fastify.redis.incr("visits") };
});

fastify.get("/health", async () => {
  return { status: "ok" };
});

try {
  await fastify.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
