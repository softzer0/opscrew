# ADR 0019: Server-less targets: Cloudflare Workers with static assets and GitHub Pages

**Status**: Proposed (2026-10-23, feature 016). The founder chose the products and the scope; the rest are the lead's defaults.

## Context

Every OpsCrew target ran the app on a server: one OpsCrew creates, the user's own, their Portainer, or their own computer. Static sites and server-rendered front ends need none. The founder asked on 2026-10-23 for Cloudflare's hosting and GitHub Pages, and chose:
- Workers with static assets over Cloudflare Pages, which Cloudflare now steers new work away from;
- static and server-rendered apps in the first version on Cloudflare;
- GitHub Pages for static apps.

## Decision

- **Two targets in the plan's target union:**
  - `cloudflare-workers` (`mode: "workers-assets"`): the Worker's name, `render` (`static` or `ssr`), the not-found handling, and `workersDev` and `previewUrls`, both off by default;
  - `github-pages` (`mode: "pages-workflow"`).

  Both carry a `site` block: what builds the site (Node, Hugo or nothing), the build command, the output folder, and the Worker entry for server rendering.
- **No server parts:** no services, processes beyond web, cron, SQLite, host plan, edge proxy or self-hosted server runner. `onServer` becomes a positive list of the server targets, so a new target is never treated as a server by accident.
- **Cloudflare:**
  - OpenTofu or Terraform owns the Worker's shell (a placeholder module, no code, no secret bindings) and one custom domain per hostname, through the `iac-apply` plan.
  - The deploy workflow builds the app and runs Wrangler, pinned, through Cloudflare's pinned action. It uploads a version and activates it. The app's secrets go from GitHub secrets to the Worker with `wrangler secret`, so they never reach state.
  - OpsCrew's security headers come from a generated `_headers` for static responses, and from a generated wrapper around the adapter's Worker for server-rendered ones.
  - A rollback activates an earlier version of the environment's own Worker by id. A version belongs to one Worker, so a promotion copies the source's exact build instead: each version's message names its run and the build's SHA-256, and the target's workflow downloads that artifact, checks it, and uploads it. Both need a `promote` approval.
- **GitHub Pages:**
  - The Pages site (the workflow source, the custom domain, HTTPS) is a Pages plan through the typed GitHub connector, approved by its hash with a new hash-bound kind, `pages-apply`. There is no GitHub Terraform provider in OpsCrew.
  - The DNS records are DNS-only, through the `cloudflare-dns` module's GitHub Pages mode. The custom domain is set at GitHub before its records exist, and the records go right after it is removed, so the domain is never claimable by someone else.
  - A rollback re-runs the previous successful Pages run, after a `promote` approval. Promotion between environments is refused: each environment builds its own.
- **The running version is read, never stored:** from Cloudflare's deployments and GitHub's Pages runs. CI's deploys don't write `plan.yaml`.
- **Retarget** to and from both targets is refused until retarget anywhere.

## Consequences

- A contract change (T1601a): the two targets, the site block, `onServer`, and `pages-apply`. Every `switch` on `target.provider` gets a branch or a plain refusal.
- Three new pins in the user's workflows: Cloudflare's action with Wrangler's version, and GitHub's three Pages actions. Hugo is pinned with its checksum.
- GitHub Pages sites have no security headers, and GitHub's terms forbid commercial use. Design and `secure` say so.
- GitHub's domain verification needs one click in the user's settings, which has no API. OpsCrew creates the record and names the page.
- Out of scope: Cloudflare Pages, Netlify, Vercel, Cloudflare's storage and queue services, API-only back ends on Workers, and per-pull-request previews (a later feature).
