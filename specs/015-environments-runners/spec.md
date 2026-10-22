# Feature Specification: Environments, local runs and runners: the production stack on my own computer, dev/staging/prod with promotion, and self-hosted runners

**Feature Branch**: `main` (feature directory `specs/015-environments-runners`)
**Created**: 2026-10-21
**Status**: Draft
**Input**: The founder's roadmap row for 015 (agreed 2026-10-20), after a developer friend's QA feedback: "not everyone has a deploy host" and "test the whole pipeline: commit, push, CI, the job". Also the founder's note of 2026-10-21 that the macOS check runs on GitHub's macOS runners, and the research of 2026-10-21 (`research.md`).

## Why

Today every OpsCrew app has exactly one deployment, on a server in the cloud, on the user's own server, or in their Portainer. Three things are missing:
- **Not everyone has a deploy host.** A developer who wants to see their app run as it would in production must first rent or own a server. There is no way to run the exact production stack on their own computer.
- **One deployment is all there is.** Changes go straight to the live site. There is no staging, no way to try a change somewhere first, and no way to move a tested release forward unchanged.
- **Deploys reach the server over SSH from GitHub.** The server must accept SSH from GitHub's machines, and nothing can run the pipeline on the developer's own machine or on the server itself.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - My app's production stack on my own computer (Priority: P1)

The developer runs their app on their own computer exactly as production runs it: the same services, the same memory limits, the same proxy in front. They see it at a local HTTPS address, and they need no server, no cloud account and no domain.

**Why this priority**: it removes the first barrier, needing a deploy host. It is also the cheapest place to try every later feature with real containers.

**Independent Test**: on a computer with Docker, design an app with the localhost target and provision it. The app then answers at `https://<app>.localhost` with the production stack's services and limits, and destroy removes everything it created.

**Acceptance Scenarios**:

1. **Given** an app designed for the localhost target, **When** it is provisioned, **Then** its production stack runs in the computer's Docker: the app, its workers and cron, its backing services, their memory limits, and the proxy (Caddy or nginx). Only the documented local differences apply (FR-1504).
2. **Given** that stack, **When** it is running, **Then** the app answers at `https://<app>.localhost` (with a port when 443 is taken), only on the computer itself, never on its network.
3. **Given** the user chose to trust OpsCrew's local certificate authority, **When** they open the address, **Then** the browser shows no warning. Without that choice the site still works, with a warning, and OpsCrew says how to trust it and how to undo that.
4. **Given** a computer whose Docker has less memory than the stack's limits add up to, **When** the user provisions, **Then** OpsCrew stops before any change. It shows both numbers and how to give Docker more memory, or lower the limits.
5. **Given** Docker is not installed or not running, **When** the user provisions, **Then** OpsCrew says so plainly, and names the options and Docker Desktop's licence terms.
6. **Given** a computer with a different processor architecture than production's (Apple silicon), **When** the user provisions, **Then** the app's image is built for the computer by default, and OpsCrew says it differs from the production image. The production image under emulation is a choice.
7. **Given** a provisioned localhost stack, **When** the user runs `verify`, `status`, `drift` or `destroy`, **Then** each works as on a server. Destroy removes only what OpsCrew created, and the data only with `--delete-data`.
8. **Given** several apps on the same computer, **When** each is provisioned for localhost, **Then** they share one local proxy, each on its own address, as several apps share one server.

---

### User Story 2 - dev, staging and prod for one app (Priority: P1)

The developer gives one app several environments, for example dev on their computer, staging on a small server and prod on the live server. Each environment has its own target, size, hostnames, secrets, state and approvals. The app itself (how it is built, its services, its port) is defined once and is the same everywhere.

**Why this priority**: a change can be tried somewhere first, and the live site is never the first place it runs.

**Independent Test**: add a staging environment to an app already in production, provision it, and deploy a change to it. Prod's plan, state and site are unchanged throughout, and staging answers on its own hostname.

**Acceptance Scenarios**:

1. **Given** an app deployed before this feature, **When** the user upgrades OpsCrew, **Then** that deployment is the app's `prod` environment, with nothing moved and nothing to apply.
2. **Given** an app, **When** the user adds an environment, **Then** OpsCrew asks only what differs: its target, its size and its hostname (for example `staging.<domain>`), and shows its monthly cost. The app's own settings come from the shared definition.
3. **Given** several environments, **When** the user runs any command with `--env <name>`, **Then** it acts on that environment only: its plan, state, records, secrets and approvals. Without `--env` it acts on the only environment, or asks which one when there are several.
4. **Given** a change to the app's shared settings (a new service, another port), **When** the user runs `design`, **Then** every environment shows it as a pending change, and each is applied by its own approved plan.
5. **Given** a repository whose GitHub plan offers environments, **When** an environment is provisioned, **Then** its deploy secrets are kept in a GitHub environment of that name. Otherwise they are kept as repository secrets named for the environment, and OpsCrew says which applies and why.
6. **Given** an environment, **When** it is destroyed, **Then** only that environment's resources, records, secrets and hostnames go. The others keep working.
7. **Given** two environments on the user's own server (for example staging and prod), **When** both are provisioned, **Then** they run side by side as two apps on that server, each with its own hostname.

---

### User Story 3 - Move a tested release forward unchanged (Priority: P1)

A push to the main branch is built once and deployed to the first environment. When it works there, the developer promotes exactly that release, the same image, to the next environment, after approving it. A bad release can be rolled back by promoting the previous one.

**Why this priority**: it is the point of having staging. What runs in prod is exactly what was tested, never a rebuild.

**Independent Test**: push a change, let it deploy to staging, and promote it to prod. Prod then runs the identical image staging runs, and the approval named that image.

**Acceptance Scenarios**:

1. **Given** environments in order (for example dev, staging, prod), **When** a commit lands on the main branch, **Then** its image is built once and deployed only to the environment set to follow the main branch. The later ones are deployed only by promotion.
2. **Given** a release running in staging, **When** the user runs `opscrew promote --to prod`, **Then** OpsCrew shows the image staging runs and its build provenance, checks that provenance, and shows prod's plan. It deploys only after an approval bound to that plan and that image.
3. **Given** a promotion, **When** it is deployed, **Then** prod runs the identical image (the same digest) that staging ran. Nothing is rebuilt.
4. **Given** a release whose provenance cannot be verified, **When** the user promotes it, **Then** OpsCrew refuses and says why.
5. **Given** a bad release in prod, **When** the user promotes the previous release, **Then** it is deployed the same way, with the same checks and approval.
6. **Given** a repository whose GitHub plan enforces required reviewers for an environment, **When** OpsCrew sets prod up, **Then** it can require a reviewer there too. Otherwise the approval is OpsCrew's own, and OpsCrew says plainly that this guards against mistakes, not against someone who can push to the repository.
7. **Given** several environments, **When** old images are cleaned up, **Then** the image each environment runs, and the one before it, are kept.

---

### User Story 4 - Deploys that need no SSH from GitHub (Priority: P2)

The developer chooses, per environment, where its deploy job runs: on GitHub's machines as today, or on a runner OpsCrew installs on the server itself. With the server's runner, the deploy runs on the server, and GitHub never connects to it.

**Why this priority**: the deploy no longer depends on GitHub reaching the server over SSH, and no deploy key leaves the user's machine for GitHub. It is a step towards closing public SSH later.

**Independent Test**: set prod's runner to the server, provision, and push a change. The change deploys while the server refuses SSH from anywhere but the user's own address, and the runner shows as online.

**Acceptance Scenarios**:

1. **Given** an environment on a cloud server or the user's own server, in a private repository, **When** the user chooses the server's runner, **Then** the host plan shows installing it (a pinned version, checked by its checksum). It runs as the same user today's deploys use, and it is applied only after its approval.
2. **Given** that runner, **When** it is installed, **Then** it is registered with a token fetched only while the plan is applied. The token never enters a plan, a log, a file or the server's disk beyond the registration itself.
3. **Given** a change on the main branch for that environment, **When** the deploy workflow runs, **Then** the build runs on GitHub's machines and the deploy job runs on the server's runner, without SSH from GitHub.
4. **Given** a public repository, **When** the user chooses a self-hosted runner, **Then** OpsCrew refuses, explaining GitHub's warning, unless the repository requires approval for every outside contributor's workflow runs. OpsCrew can set that requirement through its own approved change.
5. **Given** the runner is offline or out of date, **When** the user runs `status` or `secure`, **Then** OpsCrew says so and what to do.
6. **Given** the environment is destroyed, or the runner choice goes back to GitHub's machines, **When** the plan is applied, **Then** the runner is unregistered and removed from the server.

---

### User Story 5 - The whole pipeline on my own computer (Priority: P2)

For an environment on the developer's own computer, the developer can also run the deploy job there: a runner on their computer picks up the workflow after a push, and the job deploys to their local Docker. Commit, push, CI and the deploy job then all run as in production, against localhost.

**Why this priority**: the developer can test the pipeline itself (the workflow, the build, the deploy steps) before it touches a server.

**Independent Test**: start the local runner for a localhost environment, push a commit, and see the new version answer at the local address, deployed by the workflow.

**Acceptance Scenarios**:

1. **Given** a localhost environment in a private repository, **When** the user starts the local runner, **Then** it registers for that environment only and runs until the user stops it.
2. **Given** the local runner is running, **When** a commit lands on the branch that environment follows, **Then** the workflow's deploy job runs on the user's computer and deploys to the local stack.
3. **Given** the user stops the runner, **When** they stop it, **Then** it is unregistered, and the environment can still be provisioned locally without it.

### User Story 6 - A runner machine of my own, for deploys and builds (Priority: P2)

The developer has a machine they control: a home server, a spare PC or a VM. They want the pipeline's jobs to run there. The deploy job, so it reaches servers from inside their own network; and the build, so the image is built on their own hardware instead of GitHub's machines. OpsCrew sets that machine up over SSH as a runner machine, the way it sets up the user's own server, and environments can choose it.

**Why this priority**: the founder asked for it (2026-10-22): builds on faster or arm64 hardware, and deploys from inside a private network.

**Independent Test**: add a runner machine over SSH, point an environment's runner and build at it, push a commit, and see the image built and the app deployed by jobs that ran on that machine.

**Acceptance Scenarios**:

1. **Given** an Ubuntu or Debian machine the user can reach over SSH with sudo, **When** the user adds it as a runner machine, **Then** OpsCrew shows its host plan (the deploy user, Docker, and one runner per environment that uses it) and applies it only after its hash is approved.
2. **Given** an environment whose runner is that machine, **When** a deploy runs, **Then** the deploy job runs on the runner machine and reaches the environment's server over SSH from there. GitHub's machines never connect to the server.
3. **Given** an environment that builds on its runner, **When** a commit lands, **Then** the image is built on that runner (the local runner or a runner machine), with the same provenance and SBOM as on GitHub's machines. A runner whose architecture differs from the target's is refused at design.
4. **Given** a runner machine several environments use, **When** one environment is destroyed, **Then** only that environment's runner on it is removed. The machine is removed only by its own command, and only when no environment uses it.

### Edge Cases

- **A repository that turns public** while a self-hosted runner serves it: `secure` reports it as high, and `provision` refuses to keep the runner until the repository is private again or outside contributors' runs need approval.
- **Two environments with the same hostname**, or a hostname another app in the zone uses: refused at design.
- **Promoting from an environment that has never been deployed**: refused, naming the environment.
- **A promotion while a deploy of the target environment is still running**: it waits its turn and never runs at the same time.
- **The GitHub plan changes** (Free to Pro, or the reverse): the next `provision` shows the move of the secrets between repository secrets and the GitHub environment as a planned change.
- **Localhost ports 80/443 are taken** (IIS on Windows, another local server): OpsCrew uses 8080/8443 and prints the port in every address.
- **The computer restarts**: the local stack comes back when Docker starts again. OpsCrew says that a local stack is not meant to run unattended.
- **Docker's memory was lowered** after the stack was provisioned: `status` reports that the limits no longer fit.
- **An environment is removed** while others depend on it as their promotion source: the next environment's source moves to the one before, or the user is asked.
- **The server's runner falls more than 30 days behind GitHub's runner release** (GitHub then sends it no jobs): `status` and `secure` say so before that happens, and `provision` updates it.
- **A runner machine that is offline**: its jobs wait in GitHub's queue; `status` warns, and `provision` says the deploy waits for it.
- **A runner machine that is the environment's own server**: OpsCrew says to use the server's runner instead.
- **A runner folder on a runner machine that belongs to another repository**: refused, never replaced.
- **A Portainer environment**: its deploys already need no SSH (Portainer redeploys the stack), so the server's runner is not offered there.

## Requirements *(mandatory)*

### Functional Requirements

**Localhost (User Story 1)**

- **FR-1501**: OpsCrew MUST offer "this computer" (localhost) as a target. The app's production stack then runs in the computer's Docker (Docker Desktop on Windows and macOS, Docker Engine on Linux, or Colima on macOS): the same Compose project, components, memory limits and proxy.
- **FR-1502**: Before any change, `provision` for localhost MUST check that Docker is installed and running, that Compose is new enough, that Docker's memory holds the sum of the stack's limits, and which of ports 80/443 are free. It stops with a plain message, and the fix, when a check fails.
- **FR-1503**: The localhost stack MUST be planned and applied like a server: a plan of what it creates (containers, networks, volumes, the proxy, the local certificate), shown and applied only after an approval bound to its hash.
- **FR-1504**: The local differences from production MUST be exactly these, each stated in the plan and the guide:
  - no SSH, no server hardening, no firewall, no DNS records and no Cloudflare;
  - published ports bound to 127.0.0.1 only;
  - certificates from OpsCrew's local certificate authority instead of a public one;
  - the image built on the computer for its own architecture by default (FR-1507);
  - files the server keeps on disk are kept in Docker volumes where the computer's Docker needs it;
  - the Compose project is named `opscrew-<app>`, so it never collides with the user's own Compose projects on the computer;
  - no HSTS header, since a browser would then remember HTTPS-only for the `.localhost` name (the founder agreed, 2026-10-22).
- **FR-1505**: The app MUST be served at `https://<app>.localhost`, and an environment other than the computer's only one at `https://<env>.<app>.localhost`, on port 443 when free, else on 8443. OpsCrew's own checks MUST reach the app without relying on the computer resolving these names.
- **FR-1506**: OpsCrew MUST create a local certificate authority per computer, whose private key stays only in the user's OpsCrew folder and is never committed or copied. Trusting it is a separate, explicit step that names what it changes on the computer (it may ask for an administrator password) and prints the command that undoes it.
- **FR-1507**: On a computer whose architecture differs from production's, the app's image MUST be built locally for the computer by default, and OpsCrew MUST say the image differs from production's. Running the production image under emulation MUST be available as a choice.
- **FR-1508**: `verify`, `status`, `drift`, `secure` and `destroy` MUST work for localhost:
  - `secure` checks only what applies to a local stack;
  - `destroy` removes only what OpsCrew created, and data volumes only with `--delete-data`.
- **FR-1509**: When Docker Desktop is the runtime, OpsCrew MUST state its licence terms once (free under 250 employees and US$10M revenue, free for personal and open-source use) and name the free alternatives. It enforces nothing.

**Environments (User Story 2)**

- **FR-1510**: An app MUST be able to have several environments, each with a name of lowercase letters, digits and hyphens. Each has its own:
  - target, size and hostnames;
  - plan, infrastructure state, records and saved plans;
  - deploy secrets;
  - approvals.

  The app's build, components, port and health route MUST be defined once and shared by every environment.
- **FR-1511**: An app deployed before this feature MUST become its `prod` environment, with every file where it is today and nothing to apply.
- **FR-1512**: Every command that acts on a deployment (provision, destroy, drift, status, verify, secure, retarget, secrets, promote) and every matching MCP tool MUST accept the environment's name.
  - With one environment, the name may be left out.
  - With several, a command run without it asks which one, and fails with the list in scripts.
- **FR-1513**: Adding an environment MUST ask only what differs from the others (target, size, hostname, deploy source, runner) and show its monthly cost before anything is created.
- **FR-1514**: The deploy secrets of each environment MUST be kept apart:
  - in a GitHub environment of the same name when the repository's GitHub plan supports it (checked, not assumed);
  - otherwise as repository secrets named for the environment.

  OpsCrew says which applies. Moving between the two after a plan change is a planned change.
- **FR-1515**: Destroying an environment MUST remove only that environment's resources, records, secrets, hostnames and rules, and leave every other environment working.
- **FR-1516**: OpsCrew's shared Cloudflare rules (feature 011) MUST include each environment's own hostnames, and remove them when that environment is destroyed.

**Promotion (User Story 3)**

- **FR-1517**: Environments MUST have an order. Each environment's deploy source MUST be either the main branch (built and deployed on each push) or promotion from the environment before it. A new environment follows the main branch unless the developer names its source, and adding one never changes another environment. Changing an existing environment's source (for example, prod promoted from staging) is its own explicit step, applied at that environment's next provision.
- **FR-1518**: `opscrew promote --to <env>` MUST:
  1. find the image the source environment runs, by digest;
  2. verify its build provenance;
  3. show the target environment's plan and the image;
  4. deploy that image only after an approval bound to both the plan's hash and the image's digest.

  It never rebuilds the image.
- **FR-1519**: Promotion MUST refuse when the source environment has no deployed image, or the image's provenance cannot be verified, and say which.
- **FR-1520**: Promoting an earlier image (a rollback) MUST work the same way, with the same checks and approval.
- **FR-1521**: Where the repository's GitHub plan enforces required reviewers for an environment, OpsCrew MUST offer them for the environments that are promoted to. Otherwise it MUST say plainly that its own approval guards against mistakes, not against someone with write access to the repository.
- **FR-1522**: Image cleanup MUST keep, for every environment, the image it runs and the one before it.
- **FR-1523**: Deploys of one environment MUST never run at the same time as each other. Deploys of different environments may.

**Runners (User Stories 4 and 5)**

- **FR-1524**: Each environment MUST have a runner choice for its deploy job: GitHub's machines (the default), the server's runner (cloud or own servers), or the local runner (localhost). The build keeps running on GitHub's machines.
- **FR-1525**: The server's runner MUST be installed, updated and removed only through the host plan, approved by its hash. The runner:
  - is a pinned version checked by its checksum;
  - runs as the user today's deploys use, never as root;
  - carries a label naming the app and the environment, so it takes only that environment's deploy jobs.
- **FR-1526**: The registration and removal tokens MUST be fetched only while the plan is applied, used once, and never enter a plan, a log, an audit entry, a report, the state or a committed file.
- **FR-1527**: A self-hosted runner MUST be refused for a public repository, unless every outside contributor's workflow runs need approval. OpsCrew may set that requirement only through its own approved change.
- **FR-1528**: With the server's runner, the deploy job MUST deploy on the server itself, with no SSH connection from GitHub. OpsCrew's own management of the server keeps using SSH from the user's computer, and the guide says so.
- **FR-1529**: The local runner MUST run on the user's computer as the user, for a localhost environment only, from start until the user stops it. It is unregistered when stopped.
- **FR-1530**: `status` and `secure` MUST report a self-hosted runner's state: online or offline, its version against GitHub's current release, and the repository's visibility. `provision` keeps it current.

**Runner machines and builds on self-hosted runners** (the founder, 2026-10-22)

- **FR-1532**: A runner machine MUST be added and removed through its own host plan, approved by its hash, over SSH with the user's key and a pinned host key, as for the user's own server. It installs the deploy user, Docker, and one runner per environment that uses it, each as the deploy user's service. Its address is never written to a plan or a committed file, and OpsCrew does not harden it (it may be a desktop).
- **FR-1533**: An environment on a target reached over SSH (a cloud or own server) MUST be able to choose a runner machine for its deploy job. The job then deploys to the target over SSH from the runner machine, as a GitHub-hosted job does today.
- **FR-1534**: An environment that follows main MUST be able to build its image on its self-hosted runner when that runner is the local runner or a runner machine, never the production server's runner. The build keeps its provenance, SBOM and optional signature. A runner whose architecture differs from the target's is refused, naming the server types that match.
- **FR-1535**: Destroying an environment MUST remove only its runner from a runner machine. Removing the machine MUST be refused while an environment uses it. A runner folder that belongs to another repository is never replaced.

**Coverage**

- **FR-1531**: The localhost target MUST be checked automatically on Linux, and on macOS on GitHub's Intel macOS runners with Colima. Windows is checked by hand on the founder's computer. Docker on Apple silicon MUST be listed as not tested live, since GitHub's Apple silicon runners cannot run it.

### Key Entities

- **Environment:** a name, its place in the order, a target, hostnames, a size, a deploy source (the main branch, or promotion from the environment before), a runner choice, and where its deploy secrets live (a GitHub environment or prefixed repository secrets).
- **Shared app definition:** what every environment has in common: the build, the components, the port and the health route.
- **Promotion:** the source environment, the target environment, the image digest, the result of the provenance check, the target's plan hash and the approval bound to both.
- **Runner machine:** its name, its SSH login and address (kept on the user's computer only), its architecture, whether it has Docker, and the environments it serves.
- **Self-hosted runner:** its kind (server, local or runner machine), the environment it serves, its label, its version, and whether it is registered and online.
- **Local certificate authority:** one per computer, with its root certificate, its private key in the user's OpsCrew folder, and whether the user trusted it.
- **Localhost target:** the computer's Docker, the ports in use, the computer's architecture, and where the image comes from (built locally, or the production image).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-1501**: On a computer with Docker, a user goes from a designed app to the app answering at its local address in under 10 minutes, apart from downloading images.
- **SC-1502**: The localhost stack differs from the production stack only by the differences FR-1504 lists. A comparison of the two rendered stacks shows nothing else.
- **SC-1503**: In 100% of promotions, the target environment runs exactly the image digest the source environment ran.
- **SC-1504**: Adding, provisioning and destroying a staging environment changes nothing in prod: prod's plan hash is the same, and no request to prod fails during it.
- **SC-1505**: With the server's runner, every deploy succeeds while the server refuses SSH from GitHub's machines.
- **SC-1506**: None of the following appears in any plan, log, audit entry, report, committed file, state or pull request: a runner token, a deploy secret, the local certificate authority's key, or a generated value of any environment.
- **SC-1507**: With the local runner running, a pushed commit answers at the local address within 10 minutes.
- **SC-1508**: Every change in this feature is applied only after an approval bound to its plan's hash, and a promotion's approval also names the image digest. The changes are the localhost stack, each environment's plans, the runner's install and removal, the repository settings OpsCrew changes, and each promotion.
- **SC-1509**: The localhost target passes on Linux and on Intel macOS in CI, and by hand on Windows once for the feature. The coverage page lists Apple silicon as not tested live.
- **SC-1510**: With a runner machine, the build and the deploy job of a pushed commit both run on it, and GitHub's machines never connect to the environment's server.

## Assumptions

Defaults the lead chose while the founder was away (2026-10-21). Each is open for the founder to change.

- **Each environment is a full plan of its own.** It is derived from the one shared app definition, so the phases keep working on one plan at a time.
- **Today's deployment is `prod`.**
  - Its files stay where they are, and a new environment's live next to them.
  - Names other than dev, staging and prod are allowed.
- **Default targets:**
  - dev is localhost;
  - staging is its own smallest server at prod's provider, with the cost shown, and sharing the user's own server with prod is allowed;
  - in a Portainer, staging is another stack.
- **The deploy source:** a new environment follows the main branch unless `--from` names its source. Making prod promoted from staging is an explicit `env set prod --from staging`, so adding an environment never changes prod. A localhost environment without the local runner is provisioned from the computer itself.
- **GitHub plans:** environments, environment secrets and branch rules need GitHub Pro, Team or Enterprise on a private repository, and required reviewers on a private repository appear to need Enterprise. OpsCrew checks what the repository actually supports instead of assuming. Without them, secrets are prefixed repository secrets, and the approval is OpsCrew's own.
- **The server's runner** runs as the existing deploy user, the same privilege as today's SSH deploys. It is persistent, not one job per runner, because a per-job runner would need a long-lived administrator token on the server.
- **The local runner** runs interactively as the user, not as a system service.
- **Localhost certificates** come from one OpsCrew certificate authority on the computer, for both Caddy and nginx. Trusting it is optional.
- **The local image** is built on the computer for its architecture by default.
- **Tokens:** the GitHub token needs repository Administration (environments, runner registration, the outside contributors setting) and Environments (environment secrets) only when these features are used. OpsCrew says so when it asks.
- **Out of scope:**
  - closing public SSH (016's private network);
  - preview environments per pull request;
  - Kubernetes;
  - CI other than GitHub Actions;
  - Windows containers;
  - organisation-level runner groups;
  - a runner machine reaching servers through 016's private network (the founder, 2026-10-22: in 016, for every self-hosted runner);
  - a runner per job.
