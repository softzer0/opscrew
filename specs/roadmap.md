# OpsCrew roadmap: the features after the current one

The features still to come, in order, with their scope and the founder's decisions so far. A
feature gets its own `specs/NNN-name/` folder when it starts, and its section here then points
there. The lead keeps this file current. Research for a feature goes in that feature's
`research.md`, never only in an agent's memory, so every session on every machine has it.

Done: 000–023. 022's two opt-ins (previews on another environment's server, and below the app's
own zone), [023 retarget anywhere](023-retarget-anywhere/) and 019's database rollback (below)
were built and passed their live passes on 2026-11-06, and shipped together as 0.2.4 that day.
Next: 024 snapshots and restores as commands, once the founder gives the go-ahead.

## 019 Rollback

`opscrew rollback` puts an app's environment back on its previous deployment with one command,
or on an earlier version the user picks (founder, 2026-10-31). It became a feature of its own, right after 018, when the first outside feedback asked
how a failed deploy is recovered before pointing OpsCrew at a real app. Today OpsCrew has no
command that undoes a release which deployed fine but is wrong.

The lead's sketch, to settle in the spec:
- **The main case:** `opscrew rollback` with no arguments goes back to the deployment before the
  current one, whether the current one failed later or simply turned out wrong.
- **What it deploys:** an image the environment ran before, with no build. `promote` already
  deploys an image that exists, so rollback reuses that path, through the same switch, health
  check and check from outside as any deploy. It lists the recent versions and defaults to the one
  before the current.
- **Data is never rolled back:** migrations stay applied, so the earlier version must work with
  the newer schema (the guide's rule: add in one release, remove in a later one). OpsCrew says so
  before it switches.
- **Every target:** servers OpsCrew creates, the user's own server, Portainer and this computer.
  Cloudflare Workers and GitHub Pages through their own version history, where they keep one.
- **After a rollback:** what the next merge does (deploys forward again, or deploys stay paused
  until the user resumes them) is a spec question.
- **Research first:** how long earlier images stay in GitHub Container Registry and on the
  servers, and what each target's own rollback offers.
- **What exists to build on** (found while writing the failed-deploy guide page, 2026-10-31):
  - a healthy deploy labels the image it replaced `opscrew-<env>-previous` and keeps it on the
    server;
  - `promote --digest` redeploys an image, but refuses an environment that deploys from a
    branch, which is the default prod;
  - sites on Cloudflare's hosting or GitHub Pages already have `promote --version`, branch or not.
- **Also in scope, the rest of recovery:**
  - keep a failed copy's last log lines: today `docker rm -f` removes the copy that failed its
    health check together with its logs, so `opscrew logs` cannot show why;
  - a worker's failure hint (`docker compose logs <service>`) shows the old version's lines
    after the switch back;
  - say what to do about a migration that was half-applied when the release command failed.

**019 follow-up: a rollback undoes the database too** (founder, 2026-11-06, in the same release
as 023). 019 left the data and the schema as they are, so the earlier version had to work with the
newer schema. Now a rollback asks how to undo the database:
- **A snapshot before every release, the default:** before a deploy runs the release command
  (migrations), OpsCrew dumps the app's databases on the server; a rollback restores the dump taken
  just before the version being undone migrated. It works for every migration tool and can't stop
  halfway, but loses what was written since. **On by default for every environment except prod**;
  prod keeps its data as it is unless the user turns snapshots on.
- **Down migrations, per framework, when the user picks them:** the current image migrates the
  database down to the version the earlier one ran. Offered only where the app's migration tool
  has down migrations; rows the undone migrations don't touch stay.
- Done (2026-11-06, released in 0.2.4): [research R9](019-rollback/research.md), [spec US8](019-rollback/spec.md),
  [plan section 12](019-rollback/plan.md), [tasks T1930–T1938](019-rollback/tasks.md) and ADR 0028.

**Also in 019: logins for Kafka, Redpanda and OpenSearch** (founder, 2026-11-01). They get a login
of their own, generated like every other service's password. Today only the network protects
them: the app's Docker network on its server, the private network on another one. A login keeps
them closed when something else on the app's server is compromised. The lead's sketch:
- **Kafka and Redpanda:** SASL/SCRAM, opt-in per service, because a client sends a login only when
  the app's code configures it (kafkajs, librdkafka and sarama share no environment-variable
  convention). Turning it on gives the app the user, password and mechanism as variables, and the
  analyst says whether the app's code reads them. Redpanda's admin user must exist before SASL
  turns on (its bootstrap user), or nothing can log in.
- **OpenSearch:** its security plugin, with the HTTP API kept on plain HTTP and the login in the
  URL (`http://user:password@host:9200`), which its clients accept, so an app that reads one URL
  variable needs no change. The plugin also needs certificates for the traffic between its nodes,
  even with one node: OpsCrew generates them on the server, and they never leave it.
- **Between servers,** WireGuard already encrypts every packet (018), so no TLS goes on top.
- **Research first:** each pinned image's settings (Kafka's SCRAM users in KRaft mode, Redpanda's
  bootstrap user, OpenSearch's initial admin password and its security setup without the demo
  certificates), and what the detectors can read from the app's code.

## 020 Self-hosted monitoring

Done (2026-11-04): [spec](020-self-hosted-monitoring/spec.md), [plan](020-self-hosted-monitoring/plan.md),
[tasks](020-self-hosted-monitoring/tasks.md), ADR 0024, and the guide page `docs/guide/monitoring.md`. The sketch below is the
roadmap's, kept as the founder's input.

A private, self-hosted monitoring stack, opt-in (founder, 2026-10-18). Feature 017 left it out
by oversight, and on 2026-10-30 the founder made it a feature of its own, right after 018, since
it runs on 018's private network and extra servers. On 2026-10-31 rollback went in before it.

- **The stack:** Prometheus, Loki and Grafana, with node-exporter and cAdvisor (or Alloy), plus
  ready-made dashboards for the server, the containers, the app's HTTP traffic, Postgres and Caddy.
- **Where it runs:** by default on a separate small monitoring server (about €4–5 a month at
  Hetzner) that watches all of the user's OpsCrew servers. On the app's server only when it has at
  least 4 GB; the stack needs about 1–1.5 GB.
- **Reached only through 018's private network:** the dashboards listen on the network's address
  only, and the app servers send their metrics and logs over it.
- **Same gate as everything else:** plans approved by hash, pinned versions, and destroy removes
  only what OpsCrew installed.
- **Licences:** Grafana and Loki are AGPL-3.0, which is fine run as containers (never linked into
  the CLI); OpsCrew says so when the user turns it on.
- **Research first:** memory sizes, retention and disk use.
- **Loki rather than Elasticsearch** for logs (lead, 2026-10-30): Loki indexes only labels, so it
  fits a small server; Elasticsearch indexes every word and needs gigabytes of JVM heap. No
  Elasticsearch and Kibana stack on any provider (founder asked, 2026-10-30). Full-text search over
  large log volumes (OpenSearch with OpenSearch Dashboards on the monitoring server) is a later
  opt-in, only if users ask.
- **Not here:** dashboards across several projects, team notifications and spend alerts belong to
  the hosted control plane. On AWS (027), the light checks map to CloudWatch alarms.

## 021 Advise

Done (2026-11-05): [spec](021-advise/spec.md), [plan](021-advise/plan.md),
[tasks](021-advise/tasks.md), ADR 0025, and the guide pages `docs/guide/advise.md` and
`docs/guide/retarget.md`. The sketch below is the roadmap's, kept as the founder's input.

`opscrew advise` (founder, 2026-10-18: "analyze the current setup and then propose what to change
and how to scale"). It reads the live deployment (017's resource figures, and their history when
Beszel, Grafana Cloud or 020's stack is on), `plan.yaml`, the interview's expected traffic and
budget, and live provider prices. It proposes concrete changes, each explained, backed by the
figures and priced:
- **Size:** resize up or down; a disk that is filling.
- **Components:** add the cache the app already supports; move uploads to object storage; give a
  busy database its own server (018).
- **Cost:** a cheaper server type or location; spend above the interview's budget.
- **Reliability:** backups off; restart loops; a flapping health check; no uptime alert.
- **Upkeep and security:** waiting Dependabot updates; pending OS security updates; `secure`
  findings; tokens about to expire.
- **Moving:** `retarget` to a cheaper provider (023), or to AWS (027) when an app outgrows one
  server.

It changes nothing itself: each proposal is applied through the existing flows (a plan and a
hash-bound approval). Deterministic first (thresholds on the figures); a model only for the
judgment it adds. Placed by the lead after the figures exist and before AWS, so AWS's
managed-service choices reuse the same advice; the founder can move it.

## Later, if users ask: monitoring for several apps on one of the user's own servers

A server runs one Grafana Alloy, rendered from one app's plan, so a second OpsCrew app on the same
own server is refused Grafana Cloud and the self-hosted monitoring (017, 020). The founder asked
for it on 2026-11-04 and left the call to the lead, who left it out of 021: it needs several
OpsCrew apps on one own server with more than one wanting monitoring, the first app's monitoring
already shows the whole server, Beszel shows every container, and the change would rework the
Alloy path just released in 0.2.1. A design that works (one Alloy per server, a configuration
folder with one file per app, written by that app's own repository) is in
[021's research R4](021-advise/research.md).

## 022 Preview environments per pull request

Done (2026-11-05): [research](022-preview-environments/research.md),
[spec](022-preview-environments/spec.md), [plan](022-preview-environments/plan.md),
[tasks](022-preview-environments/tasks.md), ADR 0026, constitution 1.7.0 (the standing approval), and
the guide page `docs/guide/previews.md`. Previews live on a Cloudflare zone of their own at
`pr-<n>-<random>.<zone>` (research R6). Two opt-ins follow it (founder, 2026-11-05, research R7,
constitution 1.8.0): another environment's server (never prod's), and a name below the app's own
zone with Advanced Certificate Manager. The sketch below is the roadmap's, kept as the founder's
input.

Founder agreed, 2026-10-23. A short-lived environment per pull request: created when it opens,
updated on each push, destroyed on close or merge, at `pr-<n>.<domain>`.
- Previews run as extra apps on one shared, small preview server (013's several apps per server).
- Each has its own empty or seeded databases (never prod's data) and its own secrets.
- Secrets are never given to a fork's pull request (the `pull_request_target` trap).
- A cap on how many run at once, and automatic cleanup.
- **The approval model is the design question:** a standing approval of the preview recipe
  (server, size, cap, rules), approved once by hash. CI creates each preview within it
  automatically, and anything outside it stops. An ADR extends constitution I for it.

Placed after advise (its spend figures and budget checks cap previews) and before retarget and
AWS, so both support previews from the start. More relevant to teams than to solo users.

## 023 Retarget anywhere

Done (2026-11-06, released in 0.2.4): [research](023-retarget-anywhere/research.md),
[spec](023-retarget-anywhere/spec.md), [plan](023-retarget-anywhere/plan.md),
[tasks](023-retarget-anywhere/tasks.md). The sketch below is the roadmap's, kept as the founder's
input.

`opscrew retarget` from any target to any target: cloud ↔ own server ↔ Portainer (and AWS once it
exists), with all the app's data. Founder agreed, 2026-10-20 ("moving from every to every provider
no matter which should be supported"). Today's move is generic over cloud providers but refuses
own servers, Portainer, and stateful services other than Postgres and Valkey. The missing pieces:
- a dump and restore per catalog kind: MySQL, MongoDB, the brokers and engines, the SQLite and
  Garage volumes, and Valkey, Redis 8 and Dragonfly (which today start empty, so queued jobs are
  lost: copy their snapshot in the maintenance window);
- **buckets** (founder, 2026-10-20): a bucket at the provider being left (Hetzner Object Storage,
  Spaces) moves to the new provider's storage: a new bucket, the files copied, the app switched to
  it, and the old bucket deleted at `--finish`. Size, copy time and egress cost are shown first.
  It is the default when leaving that provider entirely, since the old bucket keeps billing;
  keeping it is the user's choice. R2 stays, since it is Cloudflare's;
- the copy on Portainer through a one-off container via its API (no SSH there);
- the own server's host plan on the target side;
- a choice per stateful component: copy its data (the default for databases, queues and brokers)
  or start empty (fine for a cache or a search index the app rebuilds);
- keeping a component on the old server while the app moves, through 018's private network;
- keeping (never deleting) the user's own old server on `--finish`.

Placed before AWS so AWS joins as just another target.

## 024 Snapshots and restores as commands

Placed before AWS by the founder on 2026-11-06. Today a snapshot is taken only by `destroy`, and
a restore is done by hand in the provider's console or from a database dump (lead, 2026-10-31,
from the failed-deploy guide page). 019's database rollback (in the same release as 023) dumps
the app's databases before each release; this feature turns that into commands the user runs:
take a snapshot of an environment's databases or its whole server, list them, and restore one,
each restore approved like any other change that deletes data.

It reuses the database rollback's dump and exact restore, its files on the server, its disk check
and rotation. It also covers every case the database rollback leaves out, where viable (founder,
2026-11-06):
- Portainer, through 023's Docker API path;
- the app's own files (a SQLite database, uploads), with a safe copy while the app writes;
- a database on another server (018);
- the other services that keep data: Valkey and Redis queues, the brokers, the search and
  analytics engines, Garage.

The rollback's snapshot choice then works for them too.

New beside the rollback's snapshots:
- a restore without a rollback, checked against today's schema;
- whole-server snapshots at Hetzner and DigitalOcean, whose restore rebuilds the server;
- **scheduled snapshots, like backups** (founder, 2026-11-06, the lead's recommendation):
  - a timer on the server runs the same snapshot at the interval the user picks and keeps the last
    N; on Portainer, which has no timer, a scheduled container in the stack does;
  - off by default, turned on per environment;
- **an opt-in copy off the server** (founder, 2026-11-06), so that losing the server doesn't lose
  the data: each snapshot is encrypted on the server before it leaves, then copied to object
  storage (R2, Hetzner Object Storage or Spaces), with its own retention.
  - **Your own server and Portainer get real backups this way.** Today they have none, and the
    guide says backups are the user's to set up. This changes with 024.
  - Design proposes them when the interview says the data matters, as it turns on the cloud
    providers' backups today.
  - This supersedes the founder's 2026-10-13 decision that provider backups are enough.

## 025 Credential rotation

The founder asked for it on 2026-11-06 and placed it after 024, as the lead suggested: security
work that depends on no provider, with 024's snapshots in place to recover from a rotation that
goes wrong. Today OpsCrew rotates only the recovery copy's key (`opscrew secrets rotate`); every
other credential it generates is made once (019's guide says so for Kafka's and Redpanda's
logins), and a few guides (Beszel, Grafana Cloud, Portainer) rotate a token by hand.

What it rotates, each change a plan approved by its hash, the recovery copy updated each time, and
no old or new value in any output or log:
- **the services' passwords** OpsCrew generated: PostgreSQL, MySQL and MariaDB (app and root),
  MongoDB, Valkey and Redis, RabbitMQ, Kafka and Redpanda, OpenSearch, Elasticsearch,
  Meilisearch, Typesense, ClickHouse and Neo4j, without breaking the running app. Where a service
  takes two passwords for a moment (MySQL's `RETAIN CURRENT PASSWORD`, Valkey's ACL users) the
  switch is seamless; elsewhere (PostgreSQL) a short ordered swap: the database, the server's env
  files, then a rolling redeploy;
- **the app secrets OpsCrew generated** (`SECRET_KEY_BASE`, Laravel's `APP_KEY` and the like),
  each with its consequence said first (every user logged out, encrypted data unreadable), or
  refused;
- **the deploy SSH key:** a new key on the servers, the GitHub secret updated, the old key removed;
- **WireGuard keys** of the servers and the user's devices (018), and the GHCR pull entries on
  Portainer;
- **the user's own tokens** (Hetzner, Cloudflare, GitHub), which OpsCrew can't make: their age and
  expiry checked, and when to replace them said (advise does this for the GitHub token today);
- optionally on a schedule: advise or the scheduled check flags credentials older than a chosen
  age.

Research first: each service's way to change its password while clients are connected.

## 026 Contabo, opening with the provider plugin system

The founder placed Contabo before AWS and the other hyperscalers on 2026-11-06. It is a cheap
VPS provider, so it joins as another server target like Hetzner and DigitalOcean: its connector,
profile, prices and IaC module, through `vpsConnector` and `providerProfile`.

**Research first:** Contabo's API and its official CLI `cntb`
(https://github.com/contabo/cntb, founder, 2026-11-06). The CLI's source shows the API's calls,
login and quirks. OpsCrew calls the API through its own typed connector and the IaC engine,
never through `cntb` (constitution IV).

**It opens with the provider plugin system** (founder, 2026-10-16; moved here from AWS on
2026-11-06, built before the Contabo part):
- Each provider becomes its own package (`@opscrew/provider-aws`: connector, profile, interview,
  design options, IaC modules, templates and its own Claude Code skills), loaded through a
  versioned contract and installed when first needed (`opscrew plugin add aws`, or offered by the
  interview), so the core CLI stays small.
- The safety gate stays in core: plugins only produce plans; hash-bound approval, policy, apply
  through the IaC engine and redaction are core's (constitution I and IV).
- Only official `@opscrew/*` packages at first, pinned and checked with npm provenance;
  third-party plugins later, behind an explicit opt-in.
- Hetzner, DigitalOcean, own server and Portainer move behind the same contract but stay built in,
  in the `opscrew` npm package and the `opscrew@opscrew` Claude Code plugin; one can move out
  later if it grows.
- Contabo is built in, like Hetzner and DigitalOcean, as an everyday VPS provider. AWS (027)
  ships as the first separately installed plugin, then Azure and Google Cloud.
- The Claude Code side follows the same split: one provider = one npm package plus one Claude
  Code plugin `opscrew-<provider>@opscrew`, released together; the core plugin keeps only the
  provider-neutral flow skills; one MCP server serves the tools of whichever provider packages are
  installed. One ADR covers both.

## 027 AWS

The first hyperscaler. **Direction (founder, 2026-10-13):** the most suitable setup using AWS's
managed services for each app, not just the backend on Fargate or EC2, while the user keeps
control of every decision:
- The Architect maps the detected needs (web/SSR, workers, cron, websockets, Postgres/Redis,
  files, email, queues) and the interview's answers (scale, budget, uptime, data criticality,
  region) to managed services.
- Cost traps are explicit decisions, with live prices: NAT gateway vs endpoints, Multi-AZ, load
  balancer minimums.
- `plan.yaml` records per component the choice, a plain-English why, the alternatives and the
  monthly cost. Presets: lean, balanced, production-HA. Overrides through interactive design,
  `opscrew design --set <component>.<field>=…`, or editing `plan.yaml` (validated, re-priced, the
  difference shown before apply). User pins: region, budget cap, no NAT, an existing VPC or
  database, keep Cloudflare DNS.
- Guardrails on by default (private database, encryption, backups, least privilege). Relaxing one
  is an explicit, recorded exception with a reason, never silent.
- Readable vendored modules per component (pinned **terraform-aws-modules**), **Infracost** for
  prices, keyless CI (GitHub OIDC), drift flags hand edits. Start with an ADR and the plan schema
  for components and overrides, before any provider code.

**Compute, chosen per use case:**
- EC2 + Compose (and Lightsail) for small steady apps; it plugs into the VPS seam and enables
  `retarget --to aws`;
- ECS Fargate for web plus workers, uptime needs or spiky load;
- App Runner for simple stateless HTTP;
- ECS on EC2 for large steady load or GPUs;
- Lambda only for small jobs. **Read first:** AWS's October 2026 announcement of Lambda web
  functions (https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/); if it
  makes Lambda a real option for serving web apps, weigh it per use case like the others
  (founder, 2026-10-14).

**Per component:** RDS or Aurora Serverless v2; ElastiCache (Valkey, no eviction for queues); S3
(+ CloudFront); SES; Secrets Manager or Parameter Store; EventBridge Scheduler for cron; SQS/SNS
when the app already uses them (otherwise a recommendation only); SNS for OpsCrew's alerts.

**Databases (founder, 2026-10-16):** a managed service only when the app's existing driver works
with it unchanged; the app's code is never rewritten for a cloud service:
- Postgres → RDS/Aurora; MySQL → RDS/Aurora MySQL; Redis → ElastiCache (Valkey);
- MongoDB → MongoDB Atlas on AWS, or DocumentDB with a compatibility warning;
- Elasticsearch/OpenSearch → Amazon OpenSearch Service (OpenSearch clients, Elasticsearch clients
  up to 7.10), else Elastic Cloud on AWS or a container;
- ClickHouse → ClickHouse Cloud (AWS Marketplace) or a container on EC2 (Redshift's SQL differs);
- Neo4j → Neo4j AuraDB or a container on EC2 (never Neptune: Neo4j's drivers can't talk to it);
- Cassandra → Amazon Keyspaces (CQL).
- A container on EC2 with EBS stays a cheaper choice the user can pick; Fargate is not used for
  databases.

**Observability on AWS (founder, 2026-10-30):** the same layers as 017 and 020, with AWS's own
services, each one explained, priced at design and changeable:
- **Logs:** CloudWatch Logs (ECS and App Runner send container logs there; EC2 through the
  CloudWatch agent), queried with Logs Insights. `opscrew logs` reads them through AWS's API.
  Retention and sampling are settings with their price shown.
- **Figures:** CloudWatch metrics and Container Insights, plus RDS's and ElastiCache's, read on
  demand by `opscrew status`.
- **Alerts:** CloudWatch alarms to SNS (email or a chat webhook) for health, errors, CPU, memory
  and database storage. The GitHub-issue check (017) can stay too.
- **Dashboards and history, opt-in:** Amazon Managed Grafana with Amazon Managed Service for
  Prometheus. Grafana reads CloudWatch Logs directly, so there is no second log store. CloudWatch
  dashboards are the cheaper default. Grafana Cloud (017) stays an option.
- **Full-text log search, opt-in:** Amazon OpenSearch Service with OpenSearch Dashboards (the
  Kibana equivalent), only for large log volumes or users who already work that way. A
  provisioned domain bills around the clock, and serverless has a minimum capacity charge, so
  design says so plainly. Not the default: indexing every word costs far more memory and money
  than CloudWatch Logs or Loki's label index. Elastic Cloud (Elasticsearch and Kibana, Elastic
  License) stays the user's own choice.
- **Traces, opt-in:** X-Ray or CloudWatch Application Signals.
- **Collection** through OpenTelemetry (the AWS Distro for OpenTelemetry), so the destination is a
  setting. Research first: current prices and free tiers, Container Insights' cost per container,
  and what each compute choice sends by default.
- Azure and Google Cloud follow the same pattern with Azure Monitor and Google Cloud Monitoring
  and Logging.

**Builds on 026's provider plugin system:** AWS ships as the first separately installed plugin
(`@opscrew/provider-aws`, `opscrew plugin add aws`), then Azure and Google Cloud.

**Testing (founder, 2026-10-18):** the **floci** AWS emulator (https://github.com/floci-io/floci;
MIT; one Docker image, `floci/floci`, on port 4566; Terraform and OpenTofu through the standard
AWS provider; EC2, ECS, ECR, RDS, ElastiCache, S3, SQS/SNS, Secrets Manager/SSM, IAM/STS,
Route 53, ACM, CloudWatch, EventBridge Scheduler, Lightsail, ELB and more; RDS, ECS and Lambda
need the Docker socket) for nearly all tests, OpenTofu plan and apply included, instead of a real
account. What it can't show:
- IAM permissions (not enforced: any credentials work), so least privilege goes untested;
- GitHub OIDC trust against real AWS;
- real networking, load balancers and certificates; its prices are a static snapshot.

A small optional live pass on a throwaway account covers only those three, rarely run. If it
never runs, they stay "not tested live" on the coverage page.

## Later, not yet placed

- **Down migrations for Alembic projects with several heads, if users ask** (founder, 2026-11-06,
  from 019's database rollback): Alembic's several bases or `branch_labels`, which modular
  codebases use on purpose; no widely used package is known to ship its own branch. Since T1943
  they deploy with `alembic upgrade heads` and their rollback offers the snapshot or keep. Down
  migrations would record one revision per head and migrate each branch down
  (`alembic downgrade <branch>@<rev>`, to check against a real container).
- **A password in front of an environment, as a follow-up to 022** (founder, 2026-11-05, from
  022; kept for later as 022's follow-up, founder, 2026-11-06): HTTP basic authentication in the
  Caddy site (a bcrypt hash made on the user's computer; the health route left open), opt-in per
  environment, because a login can break what calls the app (webhooks, OAuth callbacks, API and
  mobile clients). 022 gave previews and the other environments hidden addresses instead (022
  research R6). Cloudflare Access in front of Cloudflare-hosted sites belongs here too.
- **Moves between a site and a server, through a Cloudflare Tunnel, or between two Portainer
  environments** (lead, 2026-11-05, from 023's plan): `retarget` moves between any two server
  targets and between site hosts. A site becoming a server app (or back) changes its whole design.
  A tunnel on either side needs two DNS changes with an outage between them. Two Portainer
  environments would share one deploy branch and webhook. All three stay refused with the steps to
  do them by hand.
- **Azure and Google Cloud** after AWS, as provider plugins, reusing Azure Verified
  Modules, terraform-google-modules and Infracost.
- **Tailscale or Headscale as the private network** (lead proposal, 2026-10-18; the founder is
  interested in Headscale), next to 018's plain WireGuard:
  - Tailscale for users with a tailnet: OpsCrew joins the servers with tags and writes the ACLs,
    with an auth key. Its free Personal plan is for non-commercial use only, and OpsCrew says so.
  - Headscale (BSD-3-Clause) coordinates the official Tailscale apps from the user's own server,
    with no Tailscale account. Research first: its version, how far its ACL support goes, and the
    mobile apps' custom-server setting.
- **A Docker Swarm the user already runs, and Swarm environments in Portainer** (founder,
  2026-10-21). Swarm gives true zero-downtime redeploys (`deploy.update_config.order:
  start-first`). It needs a Swarm variant of the stack: Portainer's swarm-stack API,
  `deploy.resources` for memory limits, overlay networks, no `depends_on` conditions, and no
  `env_file: stack.env`. Do it when users with Swarm ask. 018's research chose WireGuard plus
  Compose over Swarm for OpsCrew's own servers.
- **Proxmox VE as a provider, maybe** (founder, 2026-10-15): OpsCrew creates the VM through the
  Proxmox API from a cloud-init template, then 009's host setup and tunnel path (Terraform
  provider `bpg/proxmox` to be researched). Until then, Proxmox users create a VM themselves and
  use their own server (009) or their Portainer (010).
- **Other code hosts and CI** (founder, 2026-10-14): GitHub Actions stays first; next GitLab
  (merge requests, protected and masked CI/CD variables, `.gitlab-ci.yml`, gitlab.com and
  self-managed), then Azure DevOps (pull requests, variable groups, `azure-pipelines.yml`,
  workload-identity service connections; pairs with Azure). Each needs a code-host connector, not
  only a pipeline template. Jenkins is not planned; Ansible is not used.
- **Kubernetes:** out of v1. Later, deploying into a cluster the user already runs (EKS, GKE,
  AKS, DOKS, k3s) with Helm charts and the same plan, approval and security gates; OpsCrew never
  creates clusters.
