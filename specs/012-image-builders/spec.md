# Feature Specification: Image builders, zero-downtime deploys and the image supply chain

**Feature Branch**: `main` (feature directory `specs/012-image-builders`)
**Created**: 2026-10-18
**Status**: Draft
**Input**: Founder decisions of 2026-10-13 and 2026-10-14 (three builders chosen per project, the
security baseline, zero-downtime deploys with docker-rollout, Dependabot, an SBOM and provenance,
deploy tags off by default) and the research refreshed on 2026-10-18 (`research.md`).

## Why

Today OpsCrew can package an app into a container image without a model only for Node and Python
projects. Every other language gets its Dockerfile from the Code-change agent, which is slower,
costs model usage, and varies from run to run. Two widely used, maintained tools already package
most projects well:
- **Cloud Native Buildpacks:** non-root by default and with a bill of materials, but no pnpm, Bun or
  Rust support, and PHP only on a builder being retired.
- **Railpack:** covers what Buildpacks lacks, but its images run as root.

OpsCrew should pick the right one per project, hold every builder to the same security baseline,
and fall back to its own Dockerfile when neither fits.

A deploy also takes the app down for a few seconds today: the old container stops before the new
one is ready. Users should not see errors during a deploy, and a broken new version should never
replace a working one.

Finally, the images OpsCrew builds should say what is in them and where they came from, and stay up
to date. Base images and Compose service images are not pinned by digest today, nothing proposes
updates, and the image carries no bill of materials or build provenance.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The right builder for my project, chosen for me (Priority: P1)

A user runs OpsCrew on a Go, Rails, Laravel, Spring Boot, .NET, Rust, Node or Python project.
OpsCrew picks a builder, says which one and why, and records the choice in `plan.yaml`. The user
can change it there. The first deploy builds the image with that builder in GitHub Actions. The
app runs as a non-root user, every tool and base image is pinned, no secret lands in the image, and
the image is scanned.

**Why this priority**: it is the core of the feature. It extends model-free packaging to most
languages.

**Independent Test**: run `opscrew adapt` and a deploy on each example app in the acceptance matrix.
Each builds with the expected builder, starts, and answers its health route. Inspecting the image
shows a non-root user and no secret values.

**Acceptance Scenarios**:

1. **Given** an npm Node, Python, Go, Java, Ruby or .NET project that Buildpacks fully supports,
   **When** OpsCrew designs the deployment, **Then** it picks Buildpacks and gives the reason in one
   sentence.
2. **Given** a pnpm or Bun project, a Rust project or a PHP project, **When** OpsCrew designs the
   deployment, **Then** it picks Railpack if Railpack's image can meet the baseline. Otherwise it
   picks the generated Dockerfile, says what Railpack lacks, and gives the fallback.
3. **Given** a user who sets the builder in `plan.yaml` to the generated Dockerfile, **When** they
   run `opscrew adapt`, **Then** OpsCrew writes its Dockerfile and the deploy uses it.
4. **Given** a server whose architecture a builder cannot target, **When** OpsCrew designs or
   retargets, **Then** it picks a builder that can, and says why.
5. **Given** nothing changed, **When** the user runs design, adapt or provision again, **Then** the
   builder choice and the generated files stay the same.

---

### User Story 2 - My own Dockerfile is respected and checked (Priority: P2)

A user's repository already has a Dockerfile. OpsCrew uses it as before, checks it against the
baseline, and lists what falls short: running as root, an unpinned base image, a secret in a build
argument. When the image built from it does not start or fails its health check, OpsCrew says so,
names the builder it would use instead, and says how to switch with one setting.

**Why this priority**: a project's own Dockerfile is a deliberate choice and must keep working. A
broken one should lead to a working deploy rather than a dead end.

**Independent Test**: use a project whose Dockerfile runs as root and one whose start command points
to a missing file. The first gets the baseline findings. The second gets a failed-deploy message
naming the builder to switch to, and switching makes the next deploy succeed.

**Acceptance Scenarios**:

1. **Given** a project with its own Dockerfile, **When** OpsCrew designs and adapts, **Then** the
   builder is "your Dockerfile", the file is untouched, and every baseline finding is listed with
   its fix.
2. **Given** an image built from the user's Dockerfile that never becomes healthy, **When** the
   deploy stops, **Then** the old version keeps serving and the message names the builder OpsCrew
   would pick and how to choose it.

---

### User Story 3 - Deploys without downtime on my server (Priority: P2)

A user merges a change. The deploy starts the new version next to the running one, waits until it
answers its health check, and only then sends traffic to it. It lets the old version finish its
requests, then removes it. Visitors see no errors during the switch. If the new version never
becomes healthy, it never gets traffic, the old version keeps serving, and the deploy fails with a
plain message.

**Why this priority**: deploys happen often, and every one is a short outage today.

**Independent Test**: deploy under steady load and with a slow request in flight. Count failed
requests (none), check that the slow request completes, and check that the database and cache
containers were not restarted. Then deploy a version that never gets healthy: no request fails and
the old version still answers.

**Acceptance Scenarios**:

1. **Given** an app on Hetzner, DigitalOcean or the user's own server, **When** a new version
   deploys, **Then** no request fails during the switch, and the database and cache keep running.
2. **Given** a new version that fails its health check, **When** the deploy runs, **Then** the old
   version keeps serving, the new one is removed, and the run says why.
3. **Given** a migration (the release command), **When** the deploy runs, **Then** the migration
   runs before the new version starts, as today. The guide says migrations must keep working with
   the version still running.
4. **Given** a server without enough memory for two copies of the app, **When** OpsCrew designs the
   deployment, **Then** it uses the current stop-and-start switch and says why, and the user can
   change that in `plan.yaml`.
5. **Given** an app in the user's Portainer, **When** it redeploys, **Then** OpsCrew says plainly
   that Portainer recreates the stack, with a short gap.

---

### User Story 4 - I know what is in my image, and it stays current (Priority: P3)

Every image OpsCrew builds comes with a bill of materials (SBOM) and a provenance record. The
provenance says which repository, commit and workflow built it. Both are stored with the image in
the registry, and the guide shows the command that reads them. Signing the image is available as
an opt-in, and OpsCrew warns that for a private repository the public signature log shows the
repository's name.

OpsCrew also adds a Dependabot configuration to the repository. It covers the app's package
ecosystems, the GitHub Actions in the workflow, and the base and service images, which are now
pinned by digest. Update proposals come grouped, so the user gets few pull requests.

**Why this priority**: it hardens the supply chain and keeps it current, building on User Stories 1
and 3.

**Independent Test**: after a deploy, read the SBOM and provenance of the pushed image with the
documented command. Check that the repository's Dependabot configuration lists every detected
ecosystem plus Actions and Docker. Check that every image reference OpsCrew generates is pinned by
digest.

**Acceptance Scenarios**:

1. **Given** a deployed app, **When** the user runs the guide's command on the image digest,
   **Then** they see its SBOM and its provenance (repository, commit, workflow run).
2. **Given** a repository without a Dependabot configuration, **When** OpsCrew opens its adapt pull
   request, **Then** it includes one covering the detected ecosystems, the Actions and the images,
   with grouped updates.
3. **Given** a repository that already has a Dependabot configuration, **When** OpsCrew adapts,
   **Then** it leaves the file as it is and lists the entries it would add.
4. **Given** Dependabot updates a pinned image or action, **When** the user provisions again,
   **Then** OpsCrew keeps the updated pin and does not revert it.
5. **Given** a user who turns signing on for a private repository, **When** OpsCrew shows the
   change, **Then** it says the repository's name and workflow will appear in a public log.

---

### User Story 5 - Each deploy is tagged, if I want it (Priority: P4)

The interview offers to tag each successful deploy, off by default. When it is on, every deploy
that passes its health check gets a git tag, and optionally a GitHub Release with the image digest.
The tag names the deployed commit, so the user can see what ran when and find the version to go
back to.

**Why this priority**: useful history, but optional.

**Independent Test**: turn tagging on, deploy twice, and check that two tags (and releases, if
chosen) point at the deployed commits. Turn it off and check that no tag is created.

**Acceptance Scenarios**:

1. **Given** tagging is off (the default), **When** a deploy succeeds, **Then** no tag or release
   is created.
2. **Given** tagging is on, **When** a deploy succeeds, **Then** a tag points at the deployed commit
   and, if chosen, a release names the image digest.
3. **Given** tagging is on, **When** a deploy fails, **Then** no tag or release is created.

### Edge Cases

- **Monorepo:** an app in a subfolder of a workspace (pnpm, npm, Yarn or Bun workspaces) builds from
  the workspace root, so its workspace dependencies are included. A builder that cannot do that is
  not chosen.
- **Build-time values the app needs** (a private registry token, a public API base URL): secret
  ones reach the build only as secret mounts, never as build arguments. They are never in a layer,
  the image config or the provenance record. Non-secret ones may be baked in, and OpsCrew says so.
- **The app does not listen on the port OpsCrew sets:** the health check fails, and the message
  says the app must listen on the given port, with the setting to change it.
- **Several process types in a Procfile:** OpsCrew runs `web`. Workers and cron come with feature
  013, and OpsCrew says so.
- **Static sites:** served by a web server that runs as non-root, whichever builder is chosen.
- **A Next.js app whose release command needs a CLI** (for example `prisma migrate deploy`): the
  image keeps that tool.
- **The build fails** (a missing lockfile, an unsupported runtime version): the run names the
  builder, the failing step, and what to change.
- **A builder's new release changes behaviour:** builders and their images are pinned and only
  upgraded on purpose, with OpsCrew releases or Dependabot pull requests.
- **The new version and the old one run at the same time:** WebSockets and long uploads on the old
  copy get a drain period before it stops. The guide names the limit.
- **A health check needs a tool the image lacks** (curl or wget in a slim image): the check works
  without tools the image may not have.
- **`retarget` to a provider with another architecture:** the builder is checked for the new
  architecture first. If it cannot build for it, OpsCrew changes the builder and says so before
  anything is created.
- **GitHub's own artifact attestations need a plan the user does not have:** the SBOM and provenance
  attached to the image still work. OpsCrew uses GitHub's attestations only where they are
  available.
- **A tag made by the deploy** never starts other workflows. The guide says so.

## Requirements *(mandatory)*

### Functional Requirements

**Builders**

- **FR-1201**: OpsCrew MUST choose the builder per project, deterministically:
  - Cloud Native Buildpacks where its builder fully supports the project's language, package
    manager and layout, and the server's architecture;
  - Railpack where Buildpacks cannot, provided Railpack's image meets the baseline (FR-1203);
  - otherwise the generated Dockerfile.
  The choice and a one-sentence reason MUST be recorded in `plan.yaml` and shown at design.
- **FR-1202**: The user MUST be able to set the builder in `plan.yaml` to:
  - automatic;
  - Buildpacks;
  - Railpack;
  - the generated Dockerfile;
  - their own Dockerfile, with its path.
  OpsCrew MUST respect the setting and refuse only a choice that cannot meet the baseline or the
  server's architecture, saying why.
- **FR-1203**: Every image OpsCrew builds MUST meet the security baseline:
  - the app runs as a non-root user;
  - every base image, builder image and build tool is pinned to an exact version or digest, and
    downloaded tools are verified by checksum;
  - no secret value is in any layer, the image configuration or the provenance record;
  - the image is scanned.
  A builder that cannot meet the baseline for a project MUST NOT be used for it, and OpsCrew MUST
  say why and what it uses instead.
- **FR-1204**: The generated Dockerfile MUST pin its base images by digest. It MUST keep the tools
  the release command needs in the image.
- **FR-1205**: A project's own Dockerfile MUST be used as it is, unless the user chooses another
  builder. OpsCrew MUST check it against the baseline and list each finding with its fix.
- **FR-1206**: When a deploy's new version fails to start or fails its health check, the message
  MUST name the builder OpsCrew would choose automatically and the one setting that switches to it.
- **FR-1207**: Builds MUST run in the repository's GitHub Actions, for every target (Hetzner,
  DigitalOcean, the user's own server, Portainer). They MUST produce the image for the server's
  architecture and push it to GHCR by digest, as today.
- **FR-1208**: Secret build-time values MUST reach the build only as secret mounts. Non-secret
  build-time values MUST be listed as baked into the image.
- **FR-1209**: The acceptance matrix MUST add Go, Rails, Laravel, Spring Boot, .NET and Rust example
  apps. Every example MUST build, start and answer its health route with the automatically chosen
  builder, without a model.
- **FR-1210**: A comparison of the builders on the example apps MUST record, per builder and app:
  - image size;
  - cold and warm build time;
  - the runtime user;
  - HIGH and CRITICAL vulnerability counts;
  - whether the app starts on OpsCrew's port.
  The automatic choice MUST NOT ship before the founder has seen these numbers, if Buildpacks is
  larger, slower or more vulnerable than the alternatives for the projects it would be chosen for.

**Zero-downtime deploys**

- **FR-1211**: On the server targets (Hetzner, DigitalOcean, the user's own server), a deploy MUST:
  1. start the new version next to the running one;
  2. route traffic to it only after it passes its health check;
  3. give the old version a drain period for open requests;
  4. remove the old version.
  The database, cache and proxy MUST NOT be restarted by an app deploy.
- **FR-1212**: When the new version does not become healthy within the deploy's time limit, it MUST
  be removed without ever receiving traffic. The old version MUST keep serving, and the deploy MUST
  fail with a plain message.
- **FR-1213**: The release command MUST run before the new version starts, as today. The guide MUST
  say that migrations must stay compatible with the version still running.
- **FR-1214**: The app service MUST have a health check on its health route that works for every
  builder's image, without relying on tools the image may lack.
- **FR-1215**: The deploy strategy MUST be recorded in `plan.yaml`. Rolling is the default where the
  server has room for two copies; otherwise it is stop-and-start, and OpsCrew says why. The user
  can change it.
- **FR-1216**: The tool that runs the switch MUST be pinned and checksum-verified on the server. It
  MUST be installed without new root access for the deploy user.
- **FR-1217**: On the Portainer target, OpsCrew MUST say plainly that a redeploy recreates the
  stack, with a short gap.

**Supply chain**

- **FR-1218**: Every pushed image MUST have an SBOM and a provenance record bound to its digest
  (repository, commit, workflow run), stored with the image in the registry. The guide MUST show the
  command that reads them.
- **FR-1219**: Signing the image MUST be opt-in. For a private repository, OpsCrew MUST say that the
  repository's name and workflow appear in a public log before the user turns it on.
- **FR-1220**: Every image reference OpsCrew generates MUST be pinned by digest. This covers the
  app's base images and the database, cache, proxy and helper service images.
- **FR-1221**: OpsCrew MUST add a Dependabot configuration to the adapt pull request when the
  repository has none. It MUST cover the detected package ecosystems, GitHub Actions and the
  pinned images, with updates grouped to keep pull requests few. An existing configuration MUST be
  left as it is, with the missing entries listed.
- **FR-1222**: A pin updated by the user or by Dependabot MUST NOT be reverted by OpsCrew's next
  provision.

**Deploy tags**

- **FR-1223**: Tagging deploys MUST be offered and off by default. When it is on, each deploy that
  passes its health check MUST get a git tag on the deployed commit and, if chosen, a GitHub Release
  naming the image digest. A failed deploy MUST get neither. The permission to write tags MUST be
  limited to that step.

**Everywhere**

- **FR-1224**: The CLI, the MCP tools and the plugin MUST show the same builder choice, deploy
  strategy and supply-chain settings, and accept the same overrides.
- **FR-1225**: No token, secret or server address MUST appear in the generated files, the image,
  the SBOM, the provenance, tags, releases or output.
- **FR-1226**: The user guide MUST explain:
  - the builders and how OpsCrew chooses;
  - how to switch;
  - the baseline;
  - zero-downtime deploys and their limits;
  - reading the SBOM and provenance;
  - signing;
  - Dependabot;
  - deploy tags.
- **FR-1227**: The gated live tests MUST build with each builder on at least one server target and
  check the baseline on the pushed image. They MUST deploy under load with no failed requests,
  deploy a broken version that never receives traffic, and read the SBOM and provenance.

### Key Entities

- **Builder choice**: the builder (automatic result or user setting), the reason, the server
  architecture it targets, and the baseline result.
- **Baseline result**: per check (non-root, pinned, no secrets, scanned), passed or the finding and
  its fix.
- **Image record**: the pushed digest, its SBOM and provenance, and its signature if signing is on.
- **Deploy strategy**: rolling or stop-and-start, the drain period, and the reason when not
  rolling.
- **Deploy tag**: the tag name, the deployed commit, and the release with the image digest if
  chosen.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1201**: Every app in the acceptance matrix (the 19 of today plus Go, Rails, Laravel, Spring
  Boot, .NET and Rust, 25 in all) is packaged, starts and answers its health route without a model.
- **SC-1202**: All images OpsCrew builds run as a non-root user, and a search of their layers,
  configuration and attestations finds no secret value.
- **SC-1203**: During a deploy under steady load (at least 20 requests per second), no request
  fails. A request that is in flight when the switch starts completes.
- **SC-1204**: A new version that never becomes healthy causes no failed request, and the previous
  version still answers afterwards.
- **SC-1205**: The SBOM and provenance of a deployed image can be read with one documented command.
- **SC-1206**: After the first Dependabot run, the user gets at most one grouped pull request per
  ecosystem for minor and patch updates.
- **SC-1207**: The comparison table covers every example and every builder that applies to it, and
  is published in the guide.
- **SC-1208**: Running design, adapt or provision again with nothing changed changes no file and
  asks for no approval.

## Assumptions

- Builds keep running in the user's GitHub Actions. Local `opscrew` on Windows only prepares files.
- The app reads its port from the `PORT` variable OpsCrew sets, or listens on the port recorded in
  `plan.yaml`. Neither builder sets the port itself.
- Server targets have the memory for two app copies when rolling deploys are chosen. A
  1 GB server is checked in the comparison task and may default to stop-and-start.
- GitHub's own artifact attestations may be unavailable for private repositories on some plans.
  The SBOM and provenance attached to the image work on every plan.
- Workers, cron, extra services and several apps on one server stay in feature 013. Images are
  built for the server's own architecture only.
- The switch runs through kamal-proxy, the founder's named fallback, behind Caddy. In the local
  spike (research R3 results), docker-rollout behind Caddy let a release that failed its health
  check serve visitors for about 20 s, which breaks FR-1212. kamal-proxy sent it no request. The
  user-visible behaviour in User Story 3 is unchanged (lead, confirmed by the founder, 2026-10-18).
- Nothing is released yet, so `plan.yaml` and the generated files change directly, without
  migrations.
