import type { Playbook } from "./types";

/** Next.js served by the standalone server (`node server.js`). */
export const nextjsPlaybook: Playbook = {
  id: "nextjs",
  title: "Next.js (standalone server)",
  guidance: [
    'The container runs the standalone output (`node server.js`) with PORT and HOSTNAME=0.0.0.0 set when the Next.js config uses output: "standalone" (OpsCrew sets it itself when the config is a plain object). Without it the image still builds but falls back to `next start` with every dependency, which is much larger.',
    "Variables starting with NEXT_PUBLIC_ are baked into the browser bundle at build time. Never put a secret in one.",
    "Read server-only secrets only in server code: route handlers, server components, server actions or API routes.",
  ],
  steps: {
    "health-endpoint":
      'Create the health route at the listed path. With the app router (`app/api/health/route.ts`) export `export const dynamic = "force-dynamic";` and `export function GET() { return Response.json({ status: "ok" }); }`. With the pages router (`pages/api/health.ts`) export a default handler that calls `res.status(200).json({ status: "ok" })`. Make sure middleware does not redirect or protect this path.',
    "build-config":
      'Set `output: "standalone"` in the listed Next.js config file and keep every other option as it is. If the file does not exist, create `next.config.mjs` with `const nextConfig = { output: "standalone" }; export default nextConfig;`. For an app in a monorepo folder (for example `apps/web`), also set `outputFileTracingRoot` to the repository root (for example `path.join(__dirname, "../../")`) so workspace packages are traced into the standalone output.',
    "port-config":
      "The standalone server already reads PORT and HOSTNAME. If the app uses a custom server, make it listen on `Number(process.env.PORT ?? <current port>)` and host 0.0.0.0.",
    "secret-removal":
      "Move the hard-coded secret into an environment variable read with process.env in server-only code. If the value was used in a client component, route the call through a route handler or server action that holds the secret, and never give it a NEXT_PUBLIC_ name. Say in your notes that the exposed value must be rotated.",
  },
  checks: {
    "health-endpoint": [
      "`GET /api/health` returns 200 with a JSON body and is not cached or protected by middleware.",
    ],
    "build-config": [
      '`next build` succeeds and creates `.next/standalone/server.js` (the config contains output: "standalone"). For an app in a monorepo folder `<dir>`, the server is `<dir>/.next/standalone/<dir>/server.js` and the config also sets outputFileTracingRoot.',
    ],
    "secret-removal": [
      "The value is gone from the file and is read from process.env on the server only.",
      "No NEXT_PUBLIC_ variable holds a secret.",
    ],
  },
};
