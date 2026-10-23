import type { CloudflareFramework } from "@opscrew/detect";
import type { Playbook } from "./types";

/** What every server-rendered app on Cloudflare's Workers shares. */
const WORKERS_GUIDANCE = [
  "The app runs as a Cloudflare Worker with static assets, built by the deploy workflow in GitHub Actions; there is no container, server or port.",
  "Server-side secrets reach the Worker from the repository's GitHub secrets at each deploy. Never write a value into a file, and never give a secret a public prefix (PUBLIC_, NEXT_PUBLIC_, NUXT_PUBLIC_, VITE_).",
  "Pin a dependency you add to the exact release named in the change's notes, then update the lockfile with the app's package manager without running any package's scripts: `npm install --package-lock-only --ignore-scripts`, `pnpm install --lockfile-only --ignore-scripts`, `yarn install --mode update-lockfile` (Yarn 2+) or `yarn install --ignore-scripts` (Yarn 1), or `bun install --lockfile-only --ignore-scripts`.",
];

/**
 * The playbooks for a server-rendered app on Cloudflare's Workers, one per framework whose
 * Cloudflare adapter OpsCrew sets up (research.md "Spike results" 6). OpsCrew makes the adapter
 * change itself where it can; these tell the Code-change agent or the user how otherwise.
 */
export const CLOUDFLARE_PLAYBOOKS: Readonly<Record<CloudflareFramework, Playbook>> = {
  astro: {
    id: "cloudflare-astro",
    title: "Astro on Cloudflare (@astrojs/cloudflare)",
    guidance: WORKERS_GUIDANCE,
    steps: {
      "build-config":
        "Add `@astrojs/cloudflare` (the release that supports the app's astro version: its 14.4 releases need astro ^7.4.0) to dependencies and `wrangler` to devDependencies. In the Astro config, import it with `import cloudflare from '@astrojs/cloudflare';` and set `adapter: cloudflare()`, replacing any other adapter (such as `@astrojs/node`), whose package you then remove.",
    },
    checks: {
      "build-config": [
        "`astro build` writes `dist/server/entry.mjs` and the static files to `dist/client`.",
      ],
    },
  },
  next: {
    id: "cloudflare-next",
    title: "Next.js on Cloudflare (OpenNext, @opennextjs/cloudflare)",
    guidance: WORKERS_GUIDANCE,
    steps: {
      "build-config":
        'Add `@opennextjs/cloudflare` to dependencies and `wrangler` to devDependencies, add `.open-next/` to the app\'s .gitignore, and create `open-next.config.ts` next to package.json with `import { defineCloudflareConfig } from "@opennextjs/cloudflare"; export default defineCloudflareConfig();`. Never run `opennextjs-cloudflare migrate`: it waits for a browser login. In the Next.js config, set `cacheComponents` and `partialPrefetching` to `false` where they are `true`: with either on, every server-rendered request hangs on Workers.',
    },
    checks: {
      "build-config": [
        "`opennextjs-cloudflare build --skipWranglerConfigCheck` writes `.open-next/worker.js` and `.open-next/assets`.",
        "The Next.js config turns neither cacheComponents nor partialPrefetching on.",
      ],
    },
  },
  nuxt: {
    id: "cloudflare-nuxt",
    title: "Nuxt on Cloudflare (Nitro's cloudflare_module preset)",
    guidance: WORKERS_GUIDANCE,
    steps: {
      "build-config":
        'In `nuxt.config.ts`, set `nitro: { preset: "cloudflare_module" }` (inside an existing `nitro` block, set only its `preset`). Nuxt needs no new package for it.',
    },
    checks: {
      "build-config": [
        "`nuxt build` writes `.output/server/index.mjs` and the static files to `.output/public`.",
      ],
    },
  },
  sveltekit: {
    id: "cloudflare-sveltekit",
    title: "SvelteKit on Cloudflare (@sveltejs/adapter-cloudflare)",
    guidance: WORKERS_GUIDANCE,
    steps: {
      "build-config":
        "Add `@sveltejs/adapter-cloudflare` and `wrangler` to devDependencies and import the adapter from it in the SvelteKit config (`svelte.config.js`, or `vite.config.ts` where the app sets the adapter there), called with no options, in place of the app's other adapter (such as `@sveltejs/adapter-node` or `@sveltejs/adapter-auto`), whose package you then remove.",
    },
    checks: {
      "build-config": [
        "With `WORKERS_CI=1`, `vite build` writes `.svelte-kit/cloudflare/_worker.js` and the static files to `.svelte-kit/cloudflare`.",
      ],
    },
  },
};
