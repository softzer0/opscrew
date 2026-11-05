# Previews: a link for every pull request

A change is easiest to judge running. With previews, every pull request that changes your app gets
its own copy of the app, at its own address, with its own data:

```text
https://pr-42.shop.example.com
```

GitHub Actions builds it when the pull request opens, updates it on each push and removes it, with
its data, when the pull request is closed or merged. Nobody runs anything: a comment on the pull
request gives the address and says what happened.

Previews run on one small server of their own, beside nothing else: no prod, no staging, no other
app. That server is their whole cost. OpsCrew shows its monthly price, against your budget, when it
designs the previews, before anything is created.

Previews are an [environment](environments.md), named `preview` by default, so they have their own
files, secrets, plans and approvals, and prod's plan, state, site and secrets stay exactly as they
are.

## Setting up previews

Previews need an app with a domain on [Cloudflare](cloudflare.md). Then:

```bash
npx opscrew env add preview --previews
```

OpsCrew asks only what previews need:

- **Where they run.** A new small server at Hetzner Cloud or DigitalOcean (prod's provider by
  default), or [a server you already have](own-server.md) with a public address and nothing else
  on it. OpsCrew refuses a server another environment or app runs on: a pull request's code would
  run beside it.
- **How many run at once:** the cap, 3 by default (1 to 20). The server's size follows from the
  memory each preview needs, the app and its own services. Or you pick the size and the cap
  follows.
- **Their addresses:** `pr-<number>.<your app's hostname>` by default, or under another name in a
  Cloudflare zone of yours.
- **Their data:** the seed command OpsCrew found in your app (for example
  `php artisan db:seed --force`), to confirm, another command, or none. See
  [Data and seeds](#data-and-seeds).
- **How long an idle preview lives:** 7 days without a push by default (1 to 30).

The previews' own values come from `.env.preview`, never from prod's `.env`. See
[The preview values](#the-preview-values-test-keys-only).

In scripts, pass the answers as flags:

```bash
npx opscrew env add preview --previews --cap 2 --lifetime 3 --no-seed
npx opscrew env add preview --previews --target own --domain preview.example.com --seed "npm run seed"
```

| Flag | What it answers |
|---|---|
| `--cap <n>` | how many previews run at once (the server's size follows) |
| `--size <type>` | the new server's type instead (the cap follows); not on a server you already have |
| `--lifetime <days>` | how many days without a push before a preview is removed |
| `--domain <name>` | the name previews' addresses go under, in a Cloudflare zone of yours |
| `--seed <command>` | the command that fills a new preview's database, once |
| `--no-seed` | no seed: each preview starts with empty databases |
| `--target <provider>` | where they run: `hetzner`, `digitalocean` or `own` |

Previews are always built and deployed on GitHub's machines: a pull request's code runs in the job,
so a [self-hosted runner](runners.md) of yours is not offered for them.

Then provision the environment:

```bash
npx opscrew provision --env preview
```

It shows the plans: the server and one wildcard DNS record, then the preview recipe on the server.
You approve each by its hash, as any plan. The preview workflow arrives in the deploy-setup pull
request, as every workflow does. There is no first deploy: previews come from pull requests.

## The one approval you give

A preview is created by GitHub Actions, with nobody at a terminal, so OpsCrew can't ask you before
each one. Instead you approve, once, a **recipe**: the bounds every preview stays within. The
approval says, in plain words, that GitHub Actions will create, update and delete previews of
same-repository pull requests within these bounds without asking again, and that each preview's
data is deleted when it ends. Then it lists every bound:

- the cap and the idle lifetime;
- the address pattern, `pr-<number>.<base>`;
- the only image a preview may run: your app's own image, pinned by its digest;
- what each preview runs: its services, their memory limits and networks, its site on the server's
  reverse proxy, and the scripts that start it and put the previous version back;
- the seed command;
- the names of the preview values (never the values themselves).

Because previews' data is deleted without asking, the approval also asks you to type
`<app>-preview` (for example `shop-preview`) to confirm it.

**The server itself enforces the recipe.** The only key GitHub gets for the preview server is
restricted: it can start or update a preview, remove one, or list them, and nothing else. It opens
no terminal and forwards nothing. The server checks every request: a pull request number that isn't
a number, an image other than your app's own, a preview beyond the cap. Everything a preview runs
(its services, limits, address and values) comes from the approved recipe on the server, never from
the request. So a pull request that edits the preview workflow can still do only what the recipe
allows, and it can't reach prod. The preview server's unrestricted key never leaves your computer.

**Changing a bound is a new approval.** See [Changing the recipe](#changing-the-recipe).

The recipe, without its values, is committed in your repository in
`opscrew/environments/preview/previews/`, so you can read it like every other file OpsCrew writes.

## The secrets check

A pull request's job runs the pull request's own workflow file, so it can read every secret that
job can reach. Before any change, `opscrew provision --env preview` checks that every environment
of every app in the repository keeps its deploy secrets where a pull request can't read them: in a
GitHub environment that only its own branch may use (see
[Where each environment's secrets live](environments.md#where-each-environments-secrets-live)).

When one doesn't (its secrets are repository secrets, or its GitHub environment has no branch
rule), provision refuses and names it. Provision that environment first, which moves its secrets
into a GitHub environment only its branch can use, then provision previews again:

```bash
npx opscrew provision --env prod
npx opscrew provision --env preview
```

Add `--app <key>` in a repository with [several apps](several-apps.md). Once a repository has
previews, every app's environments, prod-only apps included, keep their deploy secrets this way.

**On a GitHub Free private repository**, GitHub enforces no branch rules on environments (see
[On a Free private repository](environments.md#on-a-free-private-repository)). There, any workflow,
a pull request's included, can already read every secret of the repository. OpsCrew can't change
that, so the approval says so plainly before you give it.

## Which pull requests get a preview

A pull request gets a preview when:

- it comes from a branch of the same repository. Pull requests from forks never get one, and their
  job never sees a secret;
- it isn't a draft. A draft gets its preview when it is marked ready for review;
- it isn't from Dependabot;
- it changes your app's files, by the same rules as [push deploys](when-deploys-run.md).

It is created when the pull request opens (or is reopened, or marked ready), and updated on each
push. When you push twice in quick succession, the newest push wins: the run in progress is
cancelled. A skipped fork or Dependabot pull request gets no comment (its job can't write one); its
job's summary says why.

### What the comment says

One comment on the pull request, kept up to date, holds the address, the commit the preview runs and
its state:

| State | What it means |
|---|---|
| Runs | the preview is up at its address, on that commit |
| Runs, but the seed failed | the preview is up, but its data may be missing; the next push tries the seed again |
| The cap is reached | the server already runs as many previews as its cap; nothing running was stopped (see [The cap and cleanup](#the-cap-and-cleanup)) |
| Failed at a step | pulling the image, the release command, starting the app, its health check, or routing the address; a preview that ran before keeps its earlier version, a new one isn't served |
| The image did not build | the comment links the workflow run that says why |
| Refused | the server refused the request and nothing changed; if the workflow file was changed, `opscrew provision --env preview` writes it again |
| Busy, or unreachable | nothing changed; re-run the workflow or push again |
| Removed | the pull request was closed or merged, and the preview was removed with its data |

The comment never holds a secret or a log line. For the logs, run `opscrew preview logs <number>`.
The pull request's **View deployment** button opens the preview too.

## Addresses and certificates

Each preview's address is `pr-<number>.<your app's hostname>`, or under the name you gave with
`--domain`. Provision creates one DNS record for all of them, the wildcard `*.<hostname>`, pointing
at the preview server. It is **DNS only**, not proxied by Cloudflare, even when prod is: for an app
on a subdomain the names are two levels below your zone, which Cloudflare's free certificate doesn't
cover. Provision
refuses when the zone already has a record at that wildcard.

When your app runs on the zone's apex (`example.com` itself), the wildcard is `*.example.com`, so
every name in the zone without its own record reaches the preview server, which answers none of
them. Setup says so; `--domain preview.example.com` keeps previews under a name of their own.

The preview server gets each preview's certificate from Let's Encrypt. Let's Encrypt issues at most
**50 new certificates a week per registered domain**. When that runs out, the server falls back to
ZeroSSL. A team that opens more previews than that a week should give previews a base name under
another domain, with `--domain`.

**Previews are public.** Anyone with the address can open them; there is no login in front. They
tell search engines not to index them (`X-Robots-Tag: noindex`). The preview server's address is
visible in DNS; it holds nothing of prod's.

## Data and seeds

Each preview runs its own copies of your app's databases and other services, on its own network,
with their own volumes. They start empty. Then:

1. the release command (your migrations) runs before the app starts, on every update;
2. the seed command runs once, when the preview is created. If it fails, the preview still starts
   and the comment says so; the next push tries the seed again.

A preview's generated passwords are made on the preview server and never leave it. Nothing in a
preview reads or changes prod's data, or any other environment's. A pull request reopened after
its preview was removed gets a new one, empty and seeded again.

### The preview values: test keys only

Your app's own values for previews (API keys, mail settings, and the like) come from `.env.preview`,
which `opscrew provision --env preview` reads. Prod's `.env` never goes to previews.

**Put test keys only in `.env.preview`.** Anyone who can push a branch to the repository can run
their code on the preview server, and so read these values. Use a payment provider's test mode, a
sandbox mail service, a separate API key you can revoke.

Services that live elsewhere, such as a bucket for uploads or a hosted database, are whatever
`.env.preview` names: a preview environment creates no bucket of its own. Point them at test
resources too.

## The cap and cleanup

The server never runs more previews than its cap. A pull request that opens while the cap is
reached gets a comment saying so and how to free a place: close or merge another pull request that
has a preview, or wait until one is removed for being idle, then push again. Nothing running is
stopped.

Nothing lingers:

- **Closed or merged:** the preview's containers, volumes, site and address are removed, and its
  images are deleted from GitHub Container Registry.
- **Idle:** a timer on the server removes a preview that has had no push for its lifetime (7 days
  by default). Its next push brings it back, empty and seeded.
- **Images:** every preview run also deletes the images of pull requests no longer open, and your
  deploy workflows' image cleanup deletes preview images older than 31 days.

## The commands

```bash
npx opscrew preview list            # each preview: its pull request, address, commit, age and state
npx opscrew preview logs 42         # the last lines of preview 42's containers
npx opscrew preview destroy 42      # removes preview 42, as if its pull request closed
```

`list` and `logs` change nothing. `destroy` asks you to type `pr-42` first (`--confirm pr-42` in
scripts). They use your own key for the preview server, so you never need SSH.

The usual commands work on the preview server with `--env preview`: `status` shows the server and
its previews, `verify` checks the server and each preview's address, `drift` compares the server's
recipe with the one committed in your repository, and `secure` and [`advise`](advise.md) work as on any
server. `promote`, `rollback` and `retarget` don't apply to previews and say so.

## Changing the recipe

To change the cap, the size, the lifetime or the seed, design the environment again, then provision
it:

```bash
npx opscrew design --env preview
npx opscrew provision --env preview
```

To change the preview values, edit `.env.preview` and run `opscrew provision --env preview`.

A changed recipe, or changed values, makes provision ask for your approval again. Running previews
take the new recipe at their next push. A service the recipe no longer has is removed from them with its
data, as the standing approval allows.

A pull request that adds a service (a new cache, a queue) previews without it: previews run only
the recipe's services. Once the recipe is changed and provisioned again, each preview gets the
service at its next push.

## Removing previews

```bash
npx opscrew destroy --env preview --confirm shop-preview
npx opscrew env remove preview
```

`destroy --env preview` removes every preview, the server (or, on a server you already have, the
recipe and everything OpsCrew installed for it), the wildcard record, the environment's GitHub
secrets and its GitHub environment. Prod and the other environments keep working. Images of
previews that were still running are deleted by your deploy workflows' image cleanup within 31
days. `env remove` then deletes the environment's files, the preview workflow and the committed
recipe.

## What previews don't do

- **Pull requests from forks** get no preview.
- **No login in front:** previews are public to anyone with the address.
- **Not for sites** on [Cloudflare's hosting](cloudflare-hosting.md) or
  [GitHub Pages](github-pages.md), and not on [a Portainer](portainer-target.md) or
  [this computer](localhost.md): previews need a server of their own.
- **No copies of prod's data**, or of any other environment's.
- **Not several apps wired to each other:** in a repository with [several apps](several-apps.md),
  each app has its own preview environment and server, and a pull request touching two apps gets
  two separate previews.
- **Not one server shared by several apps' previews.**
- **No monitoring or alerts** for previews.
