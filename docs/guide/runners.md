# Self-hosted runners: where the deploy job runs

Each environment's deploy job can run in one of three places. The build always runs on GitHub's
machines; only the deploy job moves.

| `environment.runner` | Where the deploy job runs | For |
|---|---|---|
| `github` (the default) | on GitHub's machines, which reach your server over SSH, as before | every target |
| `server` | on a runner OpsCrew installs on the server itself | a server OpsCrew creates (Hetzner Cloud, DigitalOcean) or [one you already have](own-server.md) |
| `local` | on a runner on your computer, while you run it | an environment [on your computer](localhost.md) |

Choose it when you add an environment (`npx opscrew env add staging --runner server`), or set
`environment.runner` in the environment's plan and run `npx opscrew provision --env <env>`.

A [Portainer](portainer-target.md) environment has no runner choice: Portainer itself redeploys the
stack, so its deploys already need no SSH.

## Private repositories only, or approval for outside contributors

GitHub warns that self-hosted runners should almost never be used for public repositories: anyone
can open a pull request from a fork, and its workflow could run its own code on your machine. So
OpsCrew refuses a self-hosted runner for a public repository, unless the repository requires your
approval before **every** outside contributor's workflow runs (GitHub's fork pull request policy
"Require approval for all external contributors"). OpsCrew can set that policy for you, as a
repository settings change you approve first.

Approving such a run still runs its code on your runner, so read a fork's changes before you approve
its workflow. `npx opscrew secure` reports a public repository whose policy is not set as a high
finding, and `provision` refuses to keep the runner then: make the repository private again, let
OpsCrew set the policy, or go back to GitHub's machines (`environment.runner: github`).

On a private repository the policy does not apply: only people with access to the repository can
start its workflows.

## The server's runner

With `runner: server`, the deploy job runs on the server it deploys to. GitHub never connects to
the server: the runner connects out to GitHub over HTTPS and asks for jobs, and no inbound port is
opened for it. The deploy secrets then hold no server address, SSH key or host key: they never
leave your computer for GitHub.

**OpsCrew's own management still uses SSH.** `provision`, `drift`, `status`, `secure` and `destroy`
connect to the server over SSH from your computer, as before, so the server keeps accepting SSH.
The runner only means GitHub no longer needs to.

### What the host plan shows

The runner is installed, updated and removed only through the [host plan](own-server.md#what-opscrew-changes-on-your-server),
approved by its hash. Its step, `github-runner`, names:

- the version of GitHub's runner that OpsCrew pins, checked by its SHA-256 before it is unpacked;
- the user it runs as: `deploy`, the user deploys already use, never root;
- its label, `opscrew-<app>-<env>`, so it takes only that environment's deploy jobs;
- its folder, `/srv/runners/<app>` (the environment's app name, such as `shop-staging`).

Its name at GitHub is `<8 hex characters>-<app>-<env>`, made from a hash of the server's address, so
GitHub never sees the address and two servers never share a name.

The runner runs as the `deploy` user's own systemd service, `opscrew-runner-<app>.service`, which
restarts by itself and starts with the server.

- **On a server OpsCrew creates**, the server is prepared for it from the start: cloud-init
  installs the runner's system packages, makes `/srv/runners` the `deploy` user's, and lets
  `deploy`'s services run without a login session. That happens on every server OpsCrew creates,
  whatever the runner choice, so choosing a runner later never replaces the server. The host plan
  then holds only the `github-runner` step, applied over SSH as `deploy`.
- **On a server you already have**, the host plan's root part installs the packages and lets
  `deploy`'s services run, like its other steps.

### The registration token is never stored

GitHub registers a runner with a token valid for one hour. OpsCrew fetches it only while the host
plan is applied, gives it to the runner's setup on its standard input, and forgets it. It never
appears in a plan, a plan's hash, a log, an audit entry, a report, the state or a file in your
repository; the plan says only "a registration token fetched while this plan is applied". The
runner keeps the credentials GitHub gives it at registration in its own folder, as every
self-hosted runner does.

Removing the runner (destroying the environment, or going back to `runner: github`) stops and
disables its service, unregisters it with a fresh removal token, and deletes its folder. When the
server is already gone, OpsCrew removes the registration through GitHub's API.

### What it can do on the server

The runner has exactly the rights `deploy` has: it runs `docker compose` for the app, and Docker
access is close to root on a server. That is no more than today's deploys, which run as `deploy`
over SSH: anyone who can push to your default branch can already change the workflow. A runner that
stays installed also keeps its work folder and caches between jobs.

## The local runner

For an environment on your computer, the whole pipeline can run locally: you push, GitHub builds
the image, and the deploy job runs on your computer and deploys to your local stack.

```bash
npx opscrew runner start --env dev    # runs in the foreground; Ctrl+C stops it
```

It downloads GitHub's pinned runner for your computer (Linux, Windows or macOS, x64 or arm64) once
into `~/.opscrew/runners/<app>-<env>`, checks its SHA-256, and registers it for one job at a time
with the label `opscrew-<app>-<env>` and a fresh registration token. After each job it registers
again for the next one. It runs as you, never as a system service.

When you stop it (Ctrl+C, or closing the terminal), it gives a running job a minute to finish, then
removes its registration from GitHub. The environment can still be provisioned from your computer
without it.

- The deploy job's steps run with your computer's shell (Git for Windows' `bash` on Windows), and
  get none of your provider or model tokens and no SSH agent.
- It deploys the image GitHub Actions built, so the environment must not build its image on your
  computer (`target.image: registry`).

## Status and updates

`npx opscrew status` shows each self-hosted runner: registered or not, online or offline, its
version against GitHub's newest release, and the repository's visibility. `npx opscrew secure`
reports the same as findings:

- **offline:** a warning, since the environment's deploy jobs wait. For the server's runner, check
  that the server is up and run `provision`, which starts it again; for the local runner, start it.
- **more than 21 days behind GitHub's newest runner release:** a warning. GitHub stops sending jobs to
  a runner 30 days after a newer release. The runner updates itself; when it has not,
  `npx opscrew provision` installs OpsCrew's pinned version again.
- **a public repository whose outside contributors' runs need no approval:** high (see above).

## The GitHub token

Self-hosted runners need Administration (Read and write) on your GitHub token, for the registration
and removal tokens, the runner list and the fork pull request policy. See
[The GitHub token](security.md#the-github-token).
