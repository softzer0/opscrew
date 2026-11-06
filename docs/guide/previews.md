# Previews: a link for every pull request

A change is easiest to judge running. With previews, every pull request that changes your app gets
its own copy of the app, at its own address nobody can guess, with its own data:

```text
https://pr-42-k3x9q7m2ab.example.net
```

[GitHub Actions](https://github.com/features/actions) builds it when the pull request opens, updates it on each push and removes it, with
its data, when the pull request is closed or merged. Nobody runs anything: a comment on the pull
request gives the address and says what happened.

Previews run on one small server of their own, beside nothing else: no prod, no staging, no other
app. That server is their whole cost. OpsCrew shows its monthly price, against your budget, when it
designs the previews, before anything is created. If you'd rather run them on your dev or staging
server, or below your app's own domain, see [Fewer servers or one domain](#fewer-servers-or-one-domain).

Previews are an [environment](environments.md), named `preview` by default, so they have their own
files, secrets, plans and approvals, and prod's plan, state, site and secrets stay exactly as they
are.

## Setting up previews

Previews need a domain of their own on [Cloudflare](cloudflare.md): a zone used only for previews,
not your app's domain. If your app runs at `shop.example.com`, previews could use `example.net`. A
domain costs about $10 a year, and [`opscrew domain buy`](domains.md) buys one and sets it up in
your Cloudflare account. See [Addresses nobody can guess](#addresses-nobody-can-guess) for why.
Then:

```bash
npx opscrew env add preview --previews --domain example.net
```

OpsCrew asks only what previews need:

- **Where they run.** A new small server at [Hetzner Cloud](https://www.hetzner.com/cloud) or [DigitalOcean](https://www.digitalocean.com/) (prod's provider by
  default), or [a server you already have](own-server.md) with a public address and nothing else
  on it. OpsCrew refuses a server another environment or app runs on: a pull request's code would
  run beside it. Another environment's server is offered too, after a warning: see
  [On another environment's server](#on-another-environments-server).
- **How many run at once:** the cap, 3 by default (1 to 20). The server's size follows from the
  memory each preview needs, the app and its own services. Or you pick the size and the cap
  follows.
- **Their domain**, if `--domain` didn't give it: there's no default. OpsCrew refuses your app's own
  domain, a name inside another zone, and a zone that already has web records (A, AAAA or CNAME),
  because the previews' wildcard record and certificate cover every name in it. A name below your
  app's domain works only by choice: see [Below your app's own domain](#below-your-apps-own-domain).
- **Their data:** the seed command OpsCrew found in your app (for example
  `php artisan db:seed --force`), to confirm, another command, or none. See
  [Data and seeds](#data-and-seeds).
- **How long an idle preview lives:** 7 days without a push by default (1 to 30).

The previews' own values come from `.env.preview`, never from prod's `.env`. See
[The preview values](#the-preview-values-test-keys-only).

In scripts, pass the answers as flags:

```bash
npx opscrew env add preview --previews --domain example.net --cap 2 --lifetime 3 --no-seed
npx opscrew env add preview --previews --domain example.net --target own --seed "npm run seed"
```

| Flag | What it answers |
|---|---|
| `--domain <name>` | the previews' own domain, a Cloudflare zone used only for previews; a script must give it |
| `--cap <n>` | how many previews run at once (the server's size follows) |
| `--size <type>` | the new server's type instead (the cap follows); not on a server you already have |
| `--lifetime <days>` | how many days without a push before a preview is removed |
| `--seed <command>` | the command that fills a new preview's database, once |
| `--no-seed` | no seed: each preview starts with empty databases |
| `--target <provider>` | where they run: `hetzner`, `digitalocean` or `own` |
| `--share-server <env>` | run them on that environment's server instead (see [On another environment's server](#on-another-environments-server)) |
| `--app-zone` | let `--domain` be a name below your app's domain (see [Below your app's own domain](#below-your-apps-own-domain)) |

Previews are always built and deployed on GitHub's machines: a pull request's code runs in the job,
so a [self-hosted runner](runners.md) of yours is not offered for them.

Then provision the environment:

```bash
npx opscrew provision --env preview
```

It shows the plans: the server, one wildcard DNS record and the previews' certificate (see
[Addresses nobody can guess](#addresses-nobody-can-guess)), then the preview recipe on the server.
You approve each by its hash, as any plan. The Cloudflare token needs **Zone → SSL and
Certificates → Edit** to make the certificate. The preview workflow arrives in the deploy-setup pull
request, as every workflow does. There is no first deploy: previews come from pull requests.

## The one approval you give

A preview is created by GitHub Actions, with nobody at a terminal, so OpsCrew can't ask you before
each one. Instead you approve, once, a **recipe**: the bounds every preview stays within. The
approval says, in plain words, that GitHub Actions will create, update and delete previews of
same-repository pull requests within these bounds without asking again, and that each preview's
data is deleted when it ends. Then it lists every bound:

- the cap and the idle lifetime;
- the address pattern, `pr-<number>-<random>.<domain>`;
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
If that GitHub environment has rules of yours (a required reviewer or a wait timer), OpsCrew leaves
its rules alone, so let only its branch deploy to it in **Settings → Environments** instead.

**On a GitHub Free private repository**, GitHub enforces no branch rules on environments (see
[On a Free private repository](environments.md#on-a-free-private-repository)). There, any workflow,
a pull request's included, can already read every secret of the repository. OpsCrew can't change
that, so the approval says so plainly before you give it.

## Which pull requests get a preview

A pull request gets a preview when:

- it comes from a branch of the same repository. Pull requests from forks never get one, and their
  job never sees a secret;
- it isn't a draft. A draft gets its preview when it is marked ready for review;
- it isn't from [Dependabot](https://docs.github.com/en/code-security/dependabot);
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
| Runs, but the seed failed | the preview is up, but its data may be missing (see [Data and seeds](#data-and-seeds)) |
| The cap is reached | the server already runs as many previews as its cap; nothing running was stopped (see [The cap and cleanup](#the-cap-and-cleanup)) |
| Failed at a step | pulling the image, the release command, starting the app, its health check, or routing the address; a preview that ran before keeps its earlier version, a new one isn't served |
| The image did not build | the comment links the workflow run that says why |
| Refused | the server refused the request and nothing changed; if the workflow file was changed, `opscrew provision --env preview` writes it again |
| Busy, or unreachable | nothing changed; re-run the workflow or push again |
| Removed | the pull request was closed or merged, and the preview was removed with its data |

The comment never holds a secret or a log line. For the logs, run `opscrew preview logs <number>`.
The pull request's **View deployment** button opens the preview too.

## Addresses nobody can guess

Each preview's address is `pr-<number>-<random>.<domain>`, for example
`pr-42-k3x9q7m2ab.example.net`: the pull request's number first, so you can tell previews apart,
then 10 random letters and digits. The preview server draws them when it creates the preview and
keeps them for its updates, so the address stays the same while the pull request is open. A pull
request reopened after its preview was removed gets a new address.

**A domain of their own, behind Cloudflare's proxy.** Provision creates one DNS record for every
preview, the wildcard `*.<domain>`, proxied by Cloudflare, and one Cloudflare Origin CA certificate
for `*.<domain>`, which the preview server serves every preview with. So:

- **No public certificate names a preview.** Every certificate a public authority issues, [Let's
  Encrypt](https://letsencrypt.org/)'s included, is published in Certificate Transparency logs that anyone can search within
  minutes, so a random name with a certificate of its own would be found anyway. Visitors get
  Cloudflare's certificate, which names only the domain and `*.<domain>`, and the Origin CA
  certificate on the server comes from Cloudflare's private authority, which publishes nothing.
- **No weekly certificate limit.** No preview needs a certificate of its own, so a team can open
  as many previews a week as it likes.
- **The server stays out of sight.** DNS gives Cloudflare's addresses, not the preview server's,
  and the server's firewall lets only Cloudflare reach its web ports.

That is why previews need a domain used for nothing else: behind its proxy, Cloudflare's
certificate would name your app's domain on every preview, and the wildcard would answer for every
name of the zone that has no record of its own.

**What hidden addresses protect against:** someone guessing a preview's address from its pull
request's number, and someone finding it in certificate logs or by scanning the server.

**What they don't protect against:** anyone who has the link. Previews have no login in front, so
an address shared in a chat, sent to a third-party script in a `Referer` header, or synced by a
browser opens the preview. On a **public repository**, the pull request's comment and its **View
deployment** button show the address to everyone who can read the pull request. Treat a preview as
"anyone with the link": keep test data and [test keys](#the-preview-values-test-keys-only) in it,
never real users' data. Previews also tell search engines not to index them
(`X-Robots-Tag: noindex`).

## Fewer servers or one domain

A server and a domain of their own keep previews fully apart from everything else, which is why
they are the default. Two choices trade some of that away: previews on a server you already pay
for, or below your app's own domain. Each is off until you choose it, OpsCrew tells you what it
risks before you do, and you can choose either, both or neither.

### On another environment's server

If you already have a dev or staging server, previews can run on it, beside that environment,
instead of on a server of their own:

```bash
npx opscrew env add preview --previews --domain example.net --share-server dev
```

In a terminal, "Where should previews run?" also lists each environment's server that previews
can share. Choosing one shows the warning and asks you to confirm; the answer is no unless you
change it. In a script, `--share-server <env>` is your choice, and OpsCrew prints the warning:

> Anyone who can push a branch to this repository then runs code on dev's server, beside its data
> and secrets. If that code escaped its container, it could reach them. Without escaping, it
> reaches whatever dev's server serves to the internet (its web ports), as any visitor can. Use it
> only when dev holds test data and test keys.

**Choose it** when dev holds only test data and test keys, and everyone who can push a branch may
see them. **Keep a server of their own** when dev holds anything real, or when people you trust
less than dev's own users can push branches.

What changes:

- **No server is created**, so the previews add no server to your monthly cost. Instead, dev's
  design and [`advise`](advise.md) count the previews' memory (the cap times a preview's memory
  limits) in what dev's server needs.
- **One login.** Provision points the wildcard record at dev's server and installs the recipe
  there through dev's own login, and the approval names dev and repeats the warning. `preview
  list`, `logs` and `destroy`, and `status`, `verify` and `drift` with `--env preview`, reach the
  server the way dev's own commands do. Nothing of dev's server address or logins is copied into
  the preview environment's files.

OpsCrew refuses, before anything changes:

- **prod**, or any server prod runs on: previews never run beside prod's data;
- **a server with other apps** than dev's (OpsCrew reads the server first);
- **a server without public SSH**: one whose public SSH was closed with
  `opscrew secure --close-public-ssh`, or one served through a [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/), because GitHub's
  machines reach previews over SSH;
- **a server whose proxy is [nginx](https://nginx.org/)**: previews are served by [Caddy](https://caddyserver.com/), which every app on a server
  shares;
- **a server on a private network** (other servers, your devices, services or dashboards you
  granted): a preview's containers could reach them without escaping anything;
- **a preview environment, a [Portainer](https://www.portainer.io/), this computer or a site**;
- **an environment not provisioned yet**: it has no server yet;
- **a cap that doesn't fit** the memory dev's server has left after dev's own needs. OpsCrew says
  the cap that fits;
- **`--target` or `--size`** beside `--share-server`: the server is dev's, with its own size.

While previews run on dev's server, dev refuses what would break them: `destroy --env dev`,
`retarget --env dev`, a switch of its server to another proxy or to a Cloudflare Tunnel, closing
its public SSH, and putting its server on a private network. `env remove dev` is refused while the
preview environment names dev's server. Each refusal says to remove the previews first.

**To undo it**, remove the previews; dev and its server stay as they are:

```bash
npx opscrew destroy --env preview --confirm shop-preview
npx opscrew env remove preview
```

`destroy --env preview` removes the previews, the recipe and the wildcard record, never dev's
server. To have previews on a server of their own again, add them again without
`--share-server`.

### Below your app's own domain

Previews can use a name below your app's domain instead of a domain of their own. If your app runs
at `shop.example.com`, previews could use `previews.example.com`, so that each preview is
`pr-42-k3x9q7m2ab.previews.example.com`:

```bash
npx opscrew env add preview --previews --domain previews.example.com --app-zone
```

In a terminal, a name below your app's domain shows the warning and asks you to confirm; the answer
is no unless you change it. In a script, `--app-zone` is your choice, and OpsCrew prints the
warning. Without it, OpsCrew refuses the name and says to add `--app-zone`.

**What it costs: [Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/).** Cloudflare's free certificate covers names one
level below your domain, not `pr-42-k3x9q7m2ab.previews.example.com`. To keep previews hidden
behind the proxy, OpsCrew orders an advanced certificate for `*.previews.example.com` (and
`example.com`), which needs Cloudflare's Advanced Certificate Manager (ACM) on your domain. ACM is
a paid add-on you turn on in Cloudflare's dashboard, which shows its price; OpsCrew adds nothing for
it to your budget. Public certificate logs then show `*.previews.example.com`, never a preview's
name.

**What it shares: your app's cookies.** In the warning's words, a cookie your app sets for the
whole domain (`Domain=example.com`) reaches every preview, where a pull request's code can read it,
and a preview can set such cookies for your app too. A login cookie set that way could be read by
anyone who can push a branch. **Choose it** when your app sets its cookies for its own hostname
only (no `Domain` attribute), and **keep a domain of their own** otherwise.

OpsCrew refuses, before anything changes, and says where to fix it:

- **ACM off** on your domain: turn it on in the Cloudflare dashboard (your domain → **SSL/TLS →
  Edge Certificates**).
- **Total TLS on**: it gives each proxied name a certificate of its own, and every public
  certificate is published, so each preview's name would be too. Turn it off on the same page.
- **Records at or below the domain** (`previews.example.com` or any name under it): delete them in
  the dashboard if nothing uses them, or choose another name.
- **A domain that is your app's or an environment's hostname, or a parent of one**: previews take
  every name below their domain.
- **Your app's domain itself** (`example.com`): previews need a name below it.

Provision's plan then holds the proxied wildcard record and the advanced certificate, which you
approve with the rest. Cloudflare issues the certificate after the plan is applied; provision waits
up to 10 minutes for it. If it isn't ready by then, previews answer once it is, and
`opscrew verify --env preview` shows when. `verify` and `drift` also check that the certificate is
active and that Total TLS is still off.

**To undo it**, remove the previews:

```bash
npx opscrew destroy --env preview --confirm shop-preview
npx opscrew env remove preview
```

`destroy --env preview` removes the previews, the wildcard record and the advanced certificate.
ACM stays on, and Cloudflare bills it, until you turn it off in Cloudflare's dashboard once nothing
else of yours uses it; OpsCrew reminds you. To have previews on a domain of their own again, add them again with that domain and without
`--app-zone`.

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
which `opscrew provision --env preview` reads. Prod's `.env` never goes to previews. [Git](https://git-scm.com/) must ignore
`.env.preview`: add `.env.*` to your `.gitignore` (with `!.env.example` if you commit an example
file). Provision stops before reading the file when git would commit it.

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
  images are deleted from [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
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

Designing the environment again keeps its previews' settings, so change them in its plan first.
Edit `environment.previews` in `opscrew/environments/preview/plan.yaml`: `cap`, `lifetimeDays`,
`domain` or `seed` (`null` for none). Then design the environment again, which sizes a new server
for the cap (or checks that it fits on a server you already have), and provision it:

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
recipe and everything OpsCrew installed for it; on another environment's server, only the recipe),
the wildcard record (and the advanced certificate below your app's domain), the environment's
GitHub secrets and its GitHub environment. Prod and the other environments keep working. Images of
previews that were still running are deleted by your deploy workflows' image cleanup within 31
days. `env remove` then deletes the environment's files, the preview workflow and the committed
recipe.

## What previews don't do

- **Not for sites** on [Cloudflare's hosting](cloudflare-hosting.md) or
  [GitHub Pages](github-pages.md), and not on [a Portainer](portainer-target.md) or
  [this computer](localhost.md): previews need a server of their own.
- **Not several apps wired to each other:** in a repository with [several apps](several-apps.md),
  each app has its own preview environment and server, and a pull request touching two apps gets
  two separate previews.
- **No monitoring or alerts** for previews.
