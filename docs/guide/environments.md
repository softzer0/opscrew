# dev, staging and prod: environments

One app can have several environments, for example `dev` on your computer, `staging` on a small
server and `prod` on the live server. Each environment has its own target, size, hostnames, deploy
secrets, infrastructure state and approvals. The app itself (how it is built, its components, its
port and its health route) is defined once and is the same in every environment.

A change can then be tried somewhere first, and the live site is never the first place it runs. When
it works in staging, you promote exactly that image to prod: nothing is rebuilt.

## Prod is the default environment

Every app starts with one environment, `prod`. Its files are `opscrew/plan.yaml`, `.opscrew/` and
`~/.opscrew/projects/<project>/`. While prod is the only environment, a command without `--env`
acts on prod. With several environments, it asks which one, or stops in a script.

## Adding an environment

```bash
npx opscrew env add staging
```

OpsCrew asks only what differs from prod, then designs the environment and shows its monthly cost
before anything is created:

- **Where it runs.** By default the same kind of target as prod: on Hetzner Cloud or DigitalOcean,
  its own server, the smallest size by default; on [a server you already have](own-server.md), the
  same server, beside prod (no extra cost); in [your Portainer](portainer-target.md), another stack.
  `dev` defaults to [this computer](localhost.md), which costs nothing.
- **Its size**, from the number of people who will use it each month.
- **Its hostname**, by default `staging.<your domain>`. Every environment needs its own hostname.
- **Where it gets new versions:** built and deployed on each push to your branch (the default), or
  promoted from another environment (see [Promotion](#promotion)).
- **Where its deploy job runs:** on GitHub's machines (the default), on a runner on the server, on
  a runner on this computer, or on a [runner machine](runners.md#runner-machines) of yours. See
  [Self-hosted runners](runners.md).
- **Where its image is built:** on GitHub's machines (the default), or on its own runner: a runner
  machine with the server's CPU, or this computer's runner. Never on the server. See
  [Builds on your own hardware](runners.md#builds-on-your-own-hardware).

In scripts, pass the answers as flags:

```bash
npx opscrew env add staging --target hetzner --from main --runner github
npx opscrew env add dev --target localhost --runner local
npx opscrew env add qa --target hetzner --runner host --runner-host home --build runner
```

| Flag | What it answers |
|---|---|
| `--target <provider>` | where it runs: `hetzner`, `digitalocean`, `own`, `portainer` or `localhost` |
| `--from <source>` | `main`, or the environment it is promoted from |
| `--runner <where>` | where its deploy job runs: `github`, `server`, `local` or `host` |
| `--runner-host <name>` | with `--runner host`: the runner machine (by default the project's only one) |
| `--build <where>` | where its image is built: `github` or `runner` |
| `--host-key <fingerprint>` | on a server you already have: its SSH host key fingerprint (`SHA256:…`), for the first connection when no one can confirm it in a terminal |
| `--option <id>` | the design option, without asking |

Then provision it like any deployment. Its own plans and approvals are asked for, and prod's plan,
state and site stay exactly as they are:

```bash
npx opscrew provision --env staging
```

An environment's name is 1 to 16 lower-case letters, digits or hyphens, starting with a letter. A
few names are reserved: `prod` (it is the plan without a name), `production`, `storage` and names
starting with `storage-`, names with `service` as one of their hyphen-separated parts (such as
`db-service`), and the names Windows reserves for devices (`con`, `nul`, `com1` and the like).

## Working with several environments

Every command that acts on a deployment takes `--env <name>`: `provision`, `destroy`, `drift`,
`status`, `verify`, `secure`, `retarget`, `secrets` and `promote`. In Claude Code, the matching
OpsCrew tools take an `environment` input.

- With one environment, `--env` may be left out.
- With several, a command without `--env` asks which one in a terminal. In a script it stops and
  lists the environments.

```bash
npx opscrew env list      # each environment: its target, where it gets new versions, where its deploy job runs (with its runner machine), whether it is deployed
npx opscrew status --env staging
npx opscrew destroy --env staging --confirm shop-staging
```

### What each environment has of its own

| | prod | Another environment `<env>` |
|---|---|---|
| Plan, runbook, security report, runtime files, recovery copy | `opscrew/` | `opscrew/environments/<env>/` |
| Its own answers (only those that differ from prod's) | `opscrew/requirements.yaml` | `opscrew/environments/<env>/requirements.yaml` |
| State, approvals, saved plans, records | `.opscrew/` | `.opscrew/environments/<env>/` |
| Infrastructure code | `opscrew/infra/prod` | `opscrew/infra/<env>` |
| Generated passwords, deploy key, known hosts | `~/.opscrew/projects/<project>/` | `~/.opscrew/projects/<project>/environments/<env>/` |
| Deploy workflow | `.github/workflows/opscrew-deploy.yml` | `.github/workflows/opscrew-deploy-<env>.yml` |
| App name (servers, containers, stacks) | `<app>` | `<app>-<env>` |

Because each environment's app name is its own (`shop-staging`), two environments can share a
server, a Portainer and a Cloudflare zone the way two apps do.

### What every environment shares

The app's build, its port, its health route, its release command, its workers and cron jobs, its
components (databases, caches and the other services), SQLite, its external services and image
signing come from prod's plan, `opscrew/plan.yaml`. `npx opscrew design --env <env>` copies them
into the environment's plan. When you change one of them, run `design` for each environment: each
shows the change as a pending change and applies it only with its own approved plan.
`npx opscrew provision --env <env>` refuses an environment whose copy differs from prod's, and says
to run `design` for it first.

The [scan report](security.md), `opscrew/ARCHITECTURE.md` and your own
[proxy rules](reverse-proxy.md#your-own-rules) in `opscrew/proxy/` are shared too.

## Where each environment's secrets live

While prod is the app's only environment, its deploy secrets are repository secrets.
Once the app has more than one environment, each environment's provision first checks what your
repository supports, instead of assuming it. It creates a throwaway GitHub environment named
`opscrew-probe-` and eight random hex characters. On it, OpsCrew tries a branch rule, then a required
reviewer and a wait timer, and reads back which of them GitHub kept. Then it deletes the throwaway
environment. If the delete fails, the error names the environment so you can remove it in
Settings → Environments. The check never touches your other environments, and OpsCrew never changes
the rules of an environment it did not create. That check is a change in your repository's
settings, so OpsCrew asks first (`--yes` approves it in scripts).

- **Where GitHub environments work**, the environment's deploy secrets go into a GitHub environment
  of that name. A named environment's secrets are called `OPSCREW_<ENV>_…` there too (for example
  `OPSCREW_STAGING_HOST`), so a missing staging secret can never fall back to prod's repository
  secret of the same name. Prod keeps its usual names.
- **Elsewhere** they are repository secrets named `OPSCREW_<ENV>_…`, and prod keeps its usual names.
- **The build values** (`OPSCREW_BUILD_ENV`, `OPSCREW_BUILD_SECRETS`, and `OPSCREW_<ENV>_BUILD_…`
  for another environment) are always repository secrets, because the build job runs in no GitHub
  environment.

OpsCrew says which applies after the check. When your GitHub plan changes (Free to Pro, or the
reverse), the next provision shows the move of the secrets as a planned change. When prod's secrets
move into `production`, prod's old repository secrets of the same names are deleted, so the
workflow can never read a stale one.

OpsCrew creates its GitHub environments without protection rules. Where your GitHub plan offers
them, you can add required reviewers or branch rules yourself in **Settings → Environments**;
OpsCrew keeps them.

### On a Free private repository

On GitHub Free, a private repository's GitHub environments hold secrets, but they have **no branch
rules, no wait timers and no required reviewers**. So any workflow in the repository that names the
environment can read its secrets. The separation protects against mistakes, such as a staging
deploy using prod's database password, not against someone who can push to the repository. There,
OpsCrew's own approval before every change is the only gate.

Public repositories, and private ones on GitHub Pro, Team or Enterprise, get branch rules as well.
Required reviewers on a private repository need GitHub Enterprise.

## Promotion

An environment gets new versions in one of two ways:

- **From your branch:** each push builds the image once and deploys it to this environment.
- **By promotion from another environment:** it is deployed only by `npx opscrew promote`, with
  exactly the image the other environment runs.

A new environment follows your branch unless you name its source with `--from`, and adding one never
changes another. To make prod take only what staging ran:

```bash
npx opscrew env set prod --from staging
npx opscrew provision --env prod      # prod's workflow becomes the promoted one, in its pull request
```

From then on a push deploys to staging only. After a healthy deploy, staging's workflow labels the
image it runs `opscrew-staging` in GitHub Container Registry, and the one before it
`opscrew-staging-previous`. When staging works:

```bash
npx opscrew promote --to prod
```

1. OpsCrew finds the image staging runs, by its digest.
2. It checks the image's [build provenance](supply-chain.md#what-is-in-an-image-and-where-it-came-from):
   the image must come from a push to this repository's default branch, built by this repository's
   own workflow run, at the commit the image is tagged with (`<commit>`, or `<commit>-<env>` for the
   environment that built it). A pull request from a fork never passes.
3. It checks that prod has no change waiting for `npx opscrew provision --env prod` (infrastructure,
   generated files, the server, Cloudflare rules or the Portainer stack), and that prod's workflow on
   the default branch is the one its plan generates. Otherwise it stops and says to provision prod
   first.
4. It shows the image, its provenance and prod's plan, with the promotion's hash, and asks for your
   approval. The approval is bound to the target, the source, the image's digest and prod's plan
   hash: if any of them changes, it no longer applies.
5. It starts prod's deploy workflow with the digest and waits for the run. The workflow's verify job
   checks the provenance again on GitHub's machines before the deploy job runs.

Prod then runs the identical image staging ran. Nothing is rebuilt.

**`--yes` never approves a promotion.** In a script, the first run stops and prints the command
with the hash; run it after you have reviewed the promotion:

```bash
npx opscrew promote --to prod                                        # shows the promotion and its hash
npx opscrew promote --to prod --digest sha256:… --approve <hash>     # deploys exactly that
```

In Claude Code, the `opscrew_promote` tool asks you in its approval dialog; Claude never approves it
for you.

Deploys of one environment never run at the same time, while different environments may deploy at
once. A promotion, like any deploy, waits for prod's running deploy; if several wait, GitHub keeps
only the newest.

### Without image signing, provenance is a consistency check

The provenance record sits next to the image in GitHub Container Registry. Without signing, anyone
who can push to the image's package could also write a matching record, so the check confirms that
the image is consistent with a build of your default branch, not that it really came from one.
[Signing](supply-chain.md#signing-images) (`supplyChain.sign: true`) is the real gate: with it,
prod's verify job checks the image's cosign signature before its deploy job runs, and fails closed
when the signature is missing or does not match. The promotion's approval says which applies.

Signing is shared by every environment, since the environment that builds signs and the promoted
one verifies.

### Rolling back

Promote the previous image. Its digest is the one labelled `opscrew-prod-previous`:

```bash
docker buildx imagetools inspect ghcr.io/<owner>/<repo>:opscrew-prod-previous   # shows its digest
npx opscrew promote --to prod --digest sha256:<that digest>
```

A rollback runs the same checks and asks for the same approval. `promote` accepts only the image
the source environment runs or the target's previous one, and it names both digests when you give
it another.

An environment that follows your branch rolls back this way: re-run its last good deploy run, or
revert the commit and push.

Image cleanup never deletes an image that an environment runs or ran just before (see
[Old images are cleaned up](supply-chain.md#old-images-are-cleaned-up)).

### The registry token for promote

`promote` reads the image's digest and provenance from GitHub Container Registry. The registry may
not accept GitHub's fine-grained tokens, so set `OPSCREW_GHCR_READ_TOKEN` to a classic token with
only the `read:packages` scope (<https://github.com/settings/tokens/new?scopes=read:packages>).
OpsCrew reads it from the environment variable and never saves it. Without it, OpsCrew tries your
GitHub token.

## Changing an environment

`env set` changes how an environment gets new versions, where its deploy job runs and where its
image is built:

```bash
npx opscrew env set staging --from main                        # built and deployed on each push
npx opscrew env set staging --runner host --runner-host home   # its deploy job on your runner machine
npx opscrew env set staging --runner host --build runner       # and its image built there too
npx opscrew env set staging --runner github                    # back to GitHub's machines
```

Each change is written to the environment's plan and checked like the answers of `env add` (a
runner machine's CPU against the server's, for example). Nothing else changes until
`npx opscrew provision --env staging`, which shows the workflow change, and the runner machine's
host plan, before it asks. `--runner-host` and `--build` go with `--runner`; without `--build`, an
environment that builds on its runner keeps doing so when the new runner can build.

## Removing an environment

```bash
npx opscrew destroy --env staging --confirm shop-staging
npx opscrew env remove staging
```

`destroy --env staging` removes only staging's server or stack, records, hostnames, Cloudflare
rule entries and deploy secrets, its runner on a [runner machine](runners.md#runner-machines), and
its GitHub environment when OpsCrew created it. Prod and the
other environments keep working. `env remove` then deletes staging's files, and refuses while
staging is still deployed or while another environment is promoted from it (set that one's source
first, for example `npx opscrew env set prod --from main`).

## The GitHub token

Environments need two more permissions on your GitHub token, besides the usual ones: Administration
(Read and write) and Environments (Read and write). See [The GitHub token](security.md#the-github-token).
