import type { Playbook } from "./types";

/** Node.js servers: Express, Fastify, NestJS, Hono, Koa and plain `npm start` apps. */
export const nodeServerPlaybook: Playbook = {
  id: "node-server",
  title: "Node.js server (Express, Fastify, NestJS, Hono, Koa)",
  guidance: [
    "The container runs the app's production start command (the `start` script) as the `node` user.",
    "Start commands must not rely on development tools such as nodemon, ts-node-dev or tsx watch.",
  ],
  steps: {
    "health-endpoint":
      'Add `GET /health` in the listed server file, before any authentication middleware. Express or Koa router: `app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }))`. Fastify: `app.get("/health", async () => ({ status: "ok" }))`. Hono: `app.get("/health", (c) => c.json({ status: "ok" }))`. NestJS: add a `HealthController` with `@Get("health")` returning `{ status: "ok" }` and register it in the root module.',
    "port-config":
      'Replace the literal port with `const port = Number(process.env.PORT ?? <current port>);` and listen on host "0.0.0.0" (for example `app.listen(port, "0.0.0.0")`, `app.listen({ port, host: "0.0.0.0" })` for Fastify, `await app.listen(port, "0.0.0.0")` for NestJS).',
    "build-config":
      "Make sure `build` (when present) emits the files that `start` runs, and that `start` uses `node` on the built output rather than a development tool.",
  },
  checks: {
    "health-endpoint": ["`GET /health` returns 200 with a JSON body before any auth middleware."],
    "port-config": [
      "PORT=8081 makes the server listen on 8081; without PORT it uses the previous port.",
      'The server binds to "0.0.0.0".',
    ],
  },
};
