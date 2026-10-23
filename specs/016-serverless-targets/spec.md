# Feature Specification: Server-less targets: Cloudflare Workers with static assets and GitHub Pages

**Feature Branch**: `main` (feature directory `specs/016-serverless-targets`)
**Created**: 2026-10-23
**Status**: Draft
**Input**: The founder, 2026-10-23: "why it's not supported in opscrew too? we should add it in the next/current feature implementation", about Cloudflare's hosting, then "we should add github pages support alongside". Decisions the same day:
- Cloudflare's hosting through Workers with static assets, which Cloudflare now recommends for new projects over Pages;
- the first version covers static sites and server-side rendering;
- GitHub Pages alongside, for static sites.

Research of 2026-10-23: `research.md`.

## Why

Every OpsCrew target today runs the app on a server: one OpsCrew creates in the cloud, the user's own, their Portainer, or their own computer. Many apps never needed one:
- a static site;
- a single-page app that talks to external services;
- a server-rendered front end that Cloudflare can run at its edge.

For these, a server is a monthly cost, something to patch, and an attack surface, all for nothing. Two hosts serve them without any server of the user's: Cloudflare (free for static files, with server-side rendering at the edge) and GitHub Pages (free for public repositories). OpsCrew should deploy to both with the same safety: plans approved by their hash, no secret in any file, and the same day-2 commands.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A static site on Cloudflare, with no server (Priority: P1)

The user's app builds to static files: Astro, Hugo, a Vite or React single-page app, a Next.js static export, Nuxt generate, or SvelteKit's static adapter. OpsCrew offers to host it on Cloudflare. The user approves the plan, and the site goes live on their own domain, with no server to rent, patch or pay for.

**Why this priority**: it is the cheapest and safest way to put most front ends online, and the most common app among OpsCrew's audience.

**Independent Test**: design a static example for the Cloudflare target, provision it with its plan approved by hash, and merge the deploy-setup pull request. The site then answers on its own hostname over HTTPS, with OpsCrew's security headers. `destroy` removes everything OpsCrew created.

**Acceptance Scenarios**:

1. **Given** a static app with a domain on Cloudflare, **When** the user designs it, **Then** the Cloudflare option is offered at no monthly cost for static files, next to the server options, with what it can and cannot do.
2. **Given** the user chose it, **When** they provision, **Then** the plan lists what will change: the hosting project on Cloudflare, the custom domain for each hostname, and the deploy workflow. Nothing changes until that plan's hash is approved.
3. **Given** the plan is applied and the deploy-setup pull request merged, **When** GitHub Actions has built and uploaded the site, **Then** it answers at `https://<domain>` (and `www`, when on). A path that isn't a file gets the app's own 404 page, or the app itself for a single-page app.
4. **Given** the site is live, **When** a visitor requests a page, **Then** the response carries OpsCrew's security headers: content type options, frame options, referrer policy and HSTS. The site's own header rules are kept.
5. **Given** the deployment, **When** the user merges a change, **Then** the new version is built and uploaded by the deploy workflow and answers within a few minutes. The previous version stays available for a rollback.

---

### User Story 2 - A server-rendered app on Cloudflare (Priority: P1)

The user's app renders pages on the server with a framework that has a Cloudflare adapter: Astro, Next.js through OpenNext, Nuxt or SvelteKit. OpsCrew sets up the adapter, deploys the app to run at Cloudflare's edge, and gives it its secrets without writing them anywhere.

**Why this priority**: the founder chose static and server-rendered apps for the first version. Server-rendered front ends are common, and they otherwise need a whole server.

**Independent Test**: design a server-rendered example (Astro with the Cloudflare adapter) for the Cloudflare target, provision and deploy it. A server-rendered page answers with content that shows it was rendered per request, a secret the app reads is available to it, and no secret appears in any file, plan, state or log.

**Acceptance Scenarios**:

1. **Given** a server-rendered app whose framework has a supported Cloudflare adapter, **When** the user designs it, **Then** the Cloudflare option is offered. It shows what Cloudflare's plan includes (requests per day, CPU time per request) and what the app's traffic and budget from the interview mean for it.
2. **Given** the app doesn't use the adapter yet, **When** `adapt` runs, **Then** it proposes the change in a pull request: the adapter, and the framework's setting for it. The user merges it as with every code change.
3. **Given** the app has secrets (its own values, such as API keys), **When** the deploy workflow runs, **Then** each secret reaches the app at Cloudflare from the repository's GitHub secrets. It is never in a plan, state file, workflow file or log.
4. **Given** a server-rendered app whose framework has no supported adapter, or one that needs a long-running server process (WebSockets held open, background work), **When** the user designs it, **Then** the Cloudflare option is not offered, and design says why.

---

### User Story 3 - A static site on GitHub Pages (Priority: P2)

The user's app builds to static files and its repository is public, or private on a paid GitHub plan. OpsCrew offers GitHub Pages: the site is built and published by the repository's own workflow, on the user's domain.

**Why this priority**: GitHub Pages is free and already part of the user's GitHub. It suits open-source projects and documentation, but it has more limits than Cloudflare: no headers, no server-side rendering, and no commercial use.

**Independent Test**: in a public throwaway repository, design a static example for GitHub Pages and provision it with its plan approved by hash. Merge the deploy-setup pull request. The site then answers at its custom domain over HTTPS once GitHub's certificate is issued. `destroy` removes the Pages site, its custom domain and its DNS records, in an order that leaves the domain no moment to be taken over.

**Acceptance Scenarios**:

1. **Given** a static app in a public repository with a domain on Cloudflare, **When** the user designs it, **Then** the GitHub Pages option is offered at no cost. It shows GitHub's limits: 1 GB per site, a soft 100 GB of traffic per month, no custom response headers, no server-side rendering, and no commercial or SaaS use under GitHub's terms.
2. **Given** a private repository on GitHub's free plan, **When** the user designs, **Then** the GitHub Pages option is not offered. Design says that GitHub needs a paid plan for that, and that even then the site is public.
3. **Given** the user chose it, **When** they provision, **Then** the plan lists the Pages site (published by the workflow), its custom domain, the DNS records, and the domain verification record. The custom domain is set at GitHub before its DNS records exist. Nothing changes until that plan's hash is approved.
4. **Given** the plan is applied, **When** GitHub has issued the site's certificate, **Then** HTTPS is enforced. While GitHub has not issued it yet, `status` and `verify` say that it is pending and when to look again.
5. **Given** GitHub's domain verification, **When** OpsCrew has created its DNS record, **Then** OpsCrew tells the user the one step GitHub offers no API for: clicking Verify in their GitHub settings, with the exact page.

---

### User Story 4 - The same day-2 commands for both (Priority: P2)

`verify`, `status`, `drift`, `secure`, `promote` (a rollback) and `destroy` work for both targets as they do for servers, and say plainly what doesn't apply.

**Independent Test**: on a deployed Cloudflare app and a deployed GitHub Pages site, run each command. Each reports the target's facts: the answering hostnames and their certificates, the running version, changes made outside OpsCrew, headers, and a rollback to the previous version.

**Acceptance Scenarios**:

1. **Given** a deployment, **When** the user runs `verify`, **Then** it checks each hostname: DNS, the certificate, an answer from the app, and the security headers where the target can set them.
2. **Given** a Cloudflare deployment, **When** the user runs `status`, **Then** it shows the version running, when it was deployed, and the custom domains' state.
3. **Given** someone changed the hosting settings or a custom domain in Cloudflare's or GitHub's dashboard, **When** the user runs `drift`, **Then** each difference from the plan is reported, and `provision` shows how it puts it back.
4. **Given** a Cloudflare deployment, **When** the user rolls back to the previous version, **Then** the previous version answers again within a minute, with no build.
5. **Given** a GitHub Pages site, **When** the user runs `secure`, **Then** it reports that GitHub Pages cannot set security headers, says what that means, and says that Cloudflare can.
6. **Given** either target, **When** the user runs `destroy` and confirms the app's name, **Then** everything OpsCrew created is removed:
   - **Cloudflare:** the hosting project, its custom domains and its secrets;
   - **GitHub Pages:** the Pages site, its custom domain and DNS records, in a takeover-safe order. The domain verification record stays unless the user asks for its removal.

---

### User Story 5 - Environments and promotion on Cloudflare (Priority: P3)

A user with staging and production on Cloudflare promotes the exact version staging runs to production, as they do with images on servers.

**Independent Test**: staging and prod on the Cloudflare target. A merged change deploys staging; `promote --to prod` makes prod run staging's exact version, and a rollback puts prod's previous version back.

**Acceptance Scenarios**:

1. **Given** staging and prod on the Cloudflare target, each with its own hosting project and hostname, **When** the user promotes staging to prod, **Then** prod runs exactly what staging runs, with no new build, after an approval bound to that version.
2. **Given** environments on GitHub Pages, **When** the user tries to promote, **Then** it is refused. GitHub Pages publishes from a build, so each environment builds its own; OpsCrew says so and how to deploy each.

---

### Edge Cases

- **An app with components:** databases, caches, queues, workers, cron jobs or SQLite, which need a server. Neither target is offered, and design names what needs the server. External services the app reaches by URL are allowed.
- **A domain whose DNS isn't on Cloudflare:** both targets need it. OpsCrew offers to move the domain's DNS (`domain connect`), as for servers.
- **The apex and `www`:** both work. On GitHub Pages, GitHub's own redirect between them is used. On Cloudflare, `www` redirects to the domain.
- **A DNS record already exists** at a hostname the target needs: refused at plan time, naming the record, as for servers.
- **A site over the target's limits:** over 20,000 files per version on Cloudflare's free plan, or 1 GB on GitHub Pages. Design lists the limits, and the deploy job checks the built site against them before uploading it, failing with the limit named.
- **The free plan's limits for server-rendered apps:** 100,000 requests a day and 10 ms of CPU per request. When the interview's expected traffic is above them, design shows Cloudflare's paid plan and its price, or the server options.
- **A Cloudflare token without the hosting permissions:** `init` and `provision` name the missing permission and where to add it, before any change.
- **Cloudflare's proxy for a GitHub Pages hostname:** refused. The proxy stops GitHub from issuing and renewing the site's certificate, so GitHub Pages hostnames stay DNS-only.
- **A CAA record** on the domain that doesn't allow Let's Encrypt: refused for GitHub Pages, naming the record.
- **GitHub Pages already turned on** in the repository (by hand, from a branch): shown in the plan as a change to the workflow source, and applied only with the approval.
- **Retarget** to or from these targets: refused for now, with a plain message ("moving to and from server-less targets comes with retarget anywhere").
- **A localhost environment** with a server-less prod: refused for now, with a plain message. The framework's own dev or preview server is the local copy. Every environment of a server-less app uses prod's target: any number on Cloudflare, and only prod on GitHub Pages, which allows one site per repository.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-1601**: The plan MUST have two new targets:
  - Cloudflare hosting, on Workers with static assets, for static and server-rendered apps;
  - GitHub Pages, for static apps.
  Neither has a server, a host plan or an edge proxy of OpsCrew's, and server-only settings are refused with them.
- **FR-1602**: Design MUST offer the Cloudflare target:
  - for static apps;
  - for server-rendered apps whose framework has a supported Cloudflare adapter (Astro, Next.js through OpenNext, Nuxt, SvelteKit).
  It MUST offer GitHub Pages for static apps in public repositories, or in private ones on a plan GitHub allows. It MUST NOT offer either for apps with components or long-running server processes, and MUST say why. Each option MUST show its cost and its limits.
- **FR-1603**: Every change MUST go through a plan approved by its hash (constitution I):
  - the hosting project, its custom domains and the DNS records, through the IaC plan;
  - the hosting project's settings, in its configuration file reviewed in the deploy-setup pull request; the `www` redirect, through the plan for the zone's shared rules;
  - GitHub Pages' site settings (the workflow source, the custom domain, HTTPS), through a typed GitHub change shown in the plan;
  - the deploy workflow, through the deploy-setup pull request.
- **FR-1604**: The deploy workflow MUST build the app in GitHub Actions and publish it with the target's own pinned actions or tools:
  - **Cloudflare:** upload a new version and deploy it;
  - **GitHub Pages:** upload the site and publish it.
  The workflow MUST keep the previous version available for a rollback.
- **FR-1605**: No secret MAY appear in a plan, IaC state, workflow file, log or audit entry (constitution IV). The app's secrets MUST reach Cloudflare from the repository's GitHub secrets at deploy time. GitHub Pages sites take no runtime secrets, and design says so when the app reads any.
- **FR-1606**: Custom domains:
  - **On Cloudflare:** each hostname MUST be a custom domain of the hosting project, with its certificate from Cloudflare.
  - **On GitHub Pages:** the custom domain MUST be set at GitHub before its DNS records are created. The records MUST be DNS-only, and HTTPS MUST be enforced once GitHub's certificate is issued.
  - OpsCrew MUST create GitHub's domain verification record, and MUST tell the user the one manual step that verification needs.
- **FR-1607**: On Cloudflare, every response MUST carry OpsCrew's security headers, the server-rendered responses included. The site's own header and redirect rules MUST be kept. Preview URLs and the `workers.dev` address MUST be off unless the user turns them on.
- **FR-1608**: `verify`, `status`, `drift`, `secure`, `promote` and `destroy` MUST work for both targets (US4):
  - a rollback to the previous version without a build;
  - destroy removing everything OpsCrew created, in a takeover-safe order for GitHub Pages;
  - GitHub's domain verification record kept unless the user asks.
- **FR-1609**: Environments MUST work for both targets, each with its own hosting project or Pages site and hostname. Promotion of the exact running version MUST work on Cloudflare (US5), and MUST be refused on GitHub Pages with the reason.
- **FR-1610**: `init` MUST check that the Cloudflare token holds the hosting permissions, and that the GitHub token can change the repository's Pages settings, before any change, naming what's missing.
- **FR-1611**: Retarget to and from these targets MUST be refused with a plain message.
- **FR-1612**: The user guide MUST have a page for each target:
  - when to choose it;
  - its costs and limits;
  - how deploys, rollbacks and destroy work;
  - for GitHub Pages: the manual verification step, the lack of headers, and GitHub's terms.

### Key Entities

- **Cloudflare hosting target:** an app's hosting project on Cloudflare: its name, its custom domains, its settings (the not-found handling, whether server code runs first, headers, the preview and `workers.dev` switches), its versions, and the version running.
- **GitHub Pages target:** a repository's Pages site: published by the workflow, with its custom domain, HTTPS state, certificate state, and the domain verification record.
- **Deployed version:** what runs now and what ran before, for status, rollback and promotion. On Cloudflare it's a version id; on GitHub Pages, the deployment of a workflow run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1601**: A static example goes live on the Cloudflare target in under 10 minutes from the start of `provision`, with plans approved by hash. It costs nothing at Cloudflare's free plan.
- **SC-1602**: A server-rendered example goes live on the Cloudflare target, rendering per request. Its secret is available to it, and appears in none of the run's outputs, files, plans, state or audit entries.
- **SC-1603**: A static example in a public repository goes live on GitHub Pages at its custom domain over HTTPS, once GitHub's certificate is issued.
- **SC-1604**: A rollback on Cloudflare puts the previous version back within one minute, with no build.
- **SC-1605**: After `destroy`, nothing OpsCrew created remains at Cloudflare or GitHub, apart from the domain verification record the user chose to keep. No DNS record points at GitHub Pages while no Pages site claims the domain.
- **SC-1606**: An app with a database, or a server-rendered app whose framework has no adapter, is never offered either target, and design says why in one sentence.

## Assumptions

Defaults the lead chose (2026-10-23), open for the founder to change.

- **Cloudflare's product:** Workers with static assets. Cloudflare's own Pages product is not used.
- **Server-rendered frameworks in the first version:** Astro, Next.js (OpenNext), Nuxt and SvelteKit, through their Cloudflare adapters. Others come when users ask.
- **Not supported:** apps that need a database, cache, queue, worker or cron job of their own, and Cloudflare's own storage and queue services. External services reached by URL are fine.
- **Previews:**
  - Cloudflare's preview URLs and the `workers.dev` address are off;
  - preview environments per pull request are feature 020;
  - GitHub Pages has no previews.
- **GitHub Pages:**
  - DNS-only hostnames, since Cloudflare's proxy breaks its certificates;
  - public repositories on any plan; private repositories only on a plan GitHub allows, and the site is public even then;
  - no runtime secrets, no headers.
- **Prices:** shown from each provider's published plans at design time, with the source named.
- **Out of scope:**
  - Cloudflare Pages (the product), Netlify and Vercel;
  - Cloudflare's storage and queue services (D1, KV, Durable Objects, Queues);
  - API-only back ends on Workers;
  - GitHub Enterprise Server;
  - access-controlled GitHub Pages sites;
  - retarget to and from these targets (feature 021).
