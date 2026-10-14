import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.json({ message: "Hello from Hono" }));

app.get("/health", (c) => c.json({ status: "ok" }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
  console.log(`Listening on port ${info.port}`);
});
