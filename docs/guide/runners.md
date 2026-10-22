# Self-hosted runners: where the deploy job runs

Each environment's deploy job can run in one of four places. By default the image is built on
GitHub's machines; an environment can also build it on its own runner (see
[Builds on your own hardware](#builds-on-your-own-hardware)).

| `environment.runner` | Where the deploy job runs | For |
|---|---|---|
| `github` (the default) | on GitHub's machines, which reach your server over SSH | every target |
| `server` | on a runner OpsCrew installs on the server itself | a server OpsCrew creates (Hetzner Cloud, DigitalOcean) or [one you already have](own-server.md) |
| `local` | on a runner on your computer, while you run it | an environment [on your computer](localhost.md) |
| `host` | on a [runner machine](#runner-machines) of yours: a home server, a spare PC or a VM, which reaches your server over SSH | a server OpsCrew creates or one you already have |

Choose it when you add an environment (`npx opscrew env add staging --runner server`), change it
with `npx opscrew env set staging --runner <where>`, then run `npx opscrew provision --env staging`,
which shows the change and applies it after your approval.

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
connect to the server over SSH from your computer, so the server keeps accepting SSH.
The runner only means GitHub does not need to.

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
- It deploys an image from GitHub's container registry, so the environment's stack must not build
  its own image during provision (`target.image: registry`). The image can still be built on this
  computer by the runner itself: see [Builds on your own hardware](#builds-on-your-own-hardware).

## Runner machines

A runner machine is a machine of yours that runs the deploy jobs, and if you want the builds, of
the environments that choose it: a home server, a spare PC, a VM on your network. Deploys then
come from inside your own network, and builds run on hardware you pick.

It needs Ubuntu or Debian, 64-bit (x86-64 or ARM64), and an SSH login as root or as a user with
passwordless sudo, with your key (a key file, or the key in your SSH agent; OpsCrew never asks for a
password):

```bash
npx opscrew runner host add home --ssh ana@192.168.1.30 --key ~/.ssh/id_ed25519
```

OpsCrew sets it up the way it sets up [a server you already have](own-server.md):

1. It shows the machine's SSH host key fingerprint and asks you to confirm it at the first
   connection; in a script, pass it with `--host-key SHA256:…` (read it on the machine with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). A different key later stops every command.
2. It inspects the machine read-only and shows its host plan: Docker (the deploy job's checks use
   it) and the `deploy` user that the runners run as.
3. It changes the machine only after you approve that plan's hash. In a script, the first run shows
   the plan and its hash, and `npx opscrew runner host add home --approve <hash>` applies exactly
   that plan.

OpsCrew leaves the machine's SSH settings and firewall as they are unless you ask it to harden
them (see [Hardening a runner machine](#hardening-a-runner-machine)): the machine may be your
desktop. Its address and login stay on your computer, in OpsCrew's folder for the project
(`~/.opscrew/projects/<project>/runner-hosts/`); plans and every file in your repository name the
machine only as `home`. Run the commands that use it from the computer that added it.

Then choose it for an environment and provision:

```bash
npx opscrew env set staging --runner host --runner-host home
npx opscrew provision --env staging
```

Provision adds the environment's runner to the machine's host plan, one `github-runner` step with
the label `opscrew-<app>-<env>`, running as `deploy`'s own service in `/srv/runners/<app>`, and
applies it after you approve that plan's hash (`--plan-only` lists it as "host plan for a runner
machine", beside the others). The deploy job then runs on the machine and deploys to the server over
SSH with the same steps and deploy secrets a job on GitHub's machines uses, so GitHub's machines
never connect to the server. The server keeps accepting SSH, now from your machine.

- Several environments can share a machine; each has its own runner and folder.
- A runner machine is never the environment's own server: for that, use `runner: server`.
- It serves environments on a server OpsCrew creates or one you already have. A
  [Portainer](portainer-target.md) redeploys by itself, and an environment on your computer uses
  the local runner.
- `npx opscrew runner host list` shows the machines this computer knows, their CPU, whether Docker
  is installed, the hardening chosen for it, and the environments on each. `status` and `secure`
  report their runners like the others (see [Status and updates](#status-and-updates)).

### Hardening a runner machine

Hardening is optional and off by default. You choose each part on its own, when you add the machine
or later:

```bash
npx opscrew runner host add home --ssh ana@192.168.1.30 --harden ssh
npx opscrew runner host set home --harden firewall --ssh-from 203.0.113.7 192.168.1.0/24
```

Each part is a step of the machine's host plan, applied only after you approve that plan's hash. In
a script, the first run shows the plan and its hash, and
`npx opscrew runner host set home --approve <hash>` applies exactly that plan.

OpsCrew records your choice when it shows the plan, so the next approved host plan for the machine
(`runner host set`, `runner host add` or a `provision` that installs a runner there) applies it.
`npx opscrew runner host list` shows the hardening chosen, not a check of the machine; if you
decline a plan, choose again with `runner host set` to change the choice.

**SSH (`--harden ssh`)** is the SSH hardening OpsCrew applies to
[a server you already have](own-server.md): logins with SSH keys only (password and
keyboard-interactive logins off), no root login over SSH, and modern algorithms only. OpsCrew writes
its own settings file, `/etc/ssh/sshd_config.d/10-opscrew.conf`, checks it with `sshd -t` and
reloads SSH. The plan refuses it while OpsCrew logs in as root, since root could no longer log in,
and while a user logs in with a password and no SSH key, whom the plan names.

**The SSH firewall (`--harden firewall --ssh-from <address or network> …`)** lets only the addresses
and networks you name reach SSH, over IPv4 and IPv6. OpsCrew adds its own nftables table,
`inet opscrew`, whose input chain accepts the ports sshd listens on (port 22, or the ports sshd is
set up for, which the plan names) from those sources, and drops other traffic to those ports. No
other port, rule, table or default policy changes: ufw, firewalld and your own nftables tables stay
as they are. The service `opscrew-ssh-firewall.service` loads the table at boot from
`/etc/opscrew/nftables-ssh.nft`. The machine needs `nft` (the `nftables` package); without it the
plan says so and changes nothing.

`--ssh-from` is required with `--harden firewall`, and has no default: a guess at your computer's
address could lock you out when that address changes. Name the address your computer reaches the
machine from, or your network, and any other place you log in from. Giving `--ssh-from` again
replaces the earlier sources. It takes up to 32 of them; a network written with host bits, such as
`192.168.1.30/24`, is kept as `192.168.1.0/24`.

Two safeguards keep OpsCrew, and you, from being locked out:

- **The address guard.** The plan names the address OpsCrew connects to the machine from, and is
  refused when your sources leave it out. When OpsCrew applies the firewall, it checks that address
  again and changes nothing if it now connects from another one.
- **The revert timer.** Before each SSH or firewall change, the machine schedules its own undo,
  three minutes later. Afterwards OpsCrew opens a new SSH connection with your login, and cancels
  the undo only when that login works. If it does not, the machine puts the previous settings back
  by itself, even when OpsCrew lost its connection. The timer needs `flock` (from `util-linux`).

The sources are your addresses, so they stay on your computer: in the machine's record, and in the
host plans OpsCrew saves in `.opscrew/plans/`, which `.gitignore` keeps out of your repository. No
committed file or pull request holds them. OpsCrew's MCP server shows them only in your approval
dialogs; its replies to the coding agent say "your address" instead.

To undo a part, turn it off:

```bash
npx opscrew runner host set home --no-harden firewall   # deletes OpsCrew's table, its service and its rules file
npx opscrew runner host set home --no-harden ssh        # puts back the SSH settings from before OpsCrew
```

Each removes only that part, through the machine's host plan approved by its hash; removing the SSH
hardening runs under the same revert timer. Adding or removing an environment's runner leaves the
hardening as it is, and `npx opscrew runner host remove home` takes both parts off with the rest.

### Removing an environment's runner, or the machine

Destroying an environment, or moving its deploy job elsewhere and provisioning, removes only that
environment's runner from the machine, through the machine's host plan approved by its hash. The
other environments' runners stay.

```bash
npx opscrew runner host remove home
```

removes the machine itself. It is refused while an environment's deploy job runs there. Otherwise
it takes back what OpsCrew set up: this project's runners (unregistered from GitHub), its SSH
hardening and SSH firewall, and the `deploy` user and its home folder when OpsCrew created them. Docker stays, since other software may
use it, and so does the machine. Because it deletes a user's home folder, you type the machine's
name to approve it; in a script, run it once to see the plan and its hash, then
`npx opscrew runner host remove home --approve <hash> --confirm home`.

A runner folder that belongs to another repository is never replaced or removed: OpsCrew stops
instead.

When OpsCrew cannot reach the machine any more (it is off for good, or was wiped), the same command
forgets it on your computer after you type its name (`--confirm home` in a script), and deletes its
runners' registrations at GitHub. What OpsCrew installed stays on the machine; remove it there if
you use the machine again.

### Later: no public SSH

Today a runner machine, like GitHub's machines, reaches your server over SSH, so the server keeps
SSH open to the internet. With the private network that a later version of OpsCrew adds, runner
machines and every self-hosted runner will reach your servers over that network instead, so public
SSH can be closed.

## Builds on your own hardware

By default GitHub's machines build the image. With `build: runner`, the environment's build job runs
on its own runner instead, with the same Buildx, build provenance, SBOM and optional signature:

```bash
npx opscrew env set staging --runner host --runner-host home --build runner
npx opscrew env add dev --target localhost --runner local --build runner
```

- **Only on a runner machine or the local runner,** never the server's runner (see below).
- **Only for an environment built from your branch.** An environment
  [promoted](environments.md#promotion) from another runs the image that one built, so it builds
  nothing.
- **The runner's CPU must be the server's.** The image is built for the runner's architecture,
  without emulation. Every server type OpsCrew offers at Hetzner Cloud and DigitalOcean is x86-64
  (amd64), so an ARM64 machine (a Raspberry Pi, a VM on an Apple silicon Mac) cannot build for
  them; on a server you already have, its own CPU counts; on your computer, its CPU is the target's.
  OpsCrew refuses a machine whose CPU does not match when you choose it, and says which server
  types match.

### Why the production server never builds

A build runs the app's own build steps: its package install scripts, its Dockerfile's `RUN` lines,
the builder's scripts. A dependency that turned malicious would then run on the server that serves
your live site and holds its data, with the `deploy` user's Docker access, which is close to root
there. A build also takes the server's CPU and memory away from the site while it runs. So
`build: runner` is refused with `runner: server`: build on GitHub's machines, or on a runner machine
that is not the server.

### Builds on Windows and macOS

On a local runner that is not Linux, a Dockerfile build uses your Docker (Docker Desktop, or Colima
on macOS) directly. Cloud Native Buildpacks' `pack` and Railpack exist only for Linux, so OpsCrew
runs their pinned Linux builds inside a pinned Linux container that reaches your Docker through its
socket; every [builder](builders.md) works there. Docker must be running while the runner takes the
job.

The build job keeps its registry login and its Buildx builder in Docker settings of its own, in the
job's temporary folder: it never uses or changes your own Docker login, keychain or credential
manager.

## Status and updates

`npx opscrew status` shows each self-hosted runner: registered or not, online or offline, its
version against GitHub's newest release, and the repository's visibility. `npx opscrew secure`
reports the same as findings:

- **offline:** a warning, since the environment's deploy jobs wait. For the server's runner or a
  runner machine's, check that the machine is up and run `provision`, which starts it again; for
  the local runner, start it.
- **more than 21 days behind GitHub's newest runner release:** a warning. GitHub stops sending jobs to
  a runner 30 days after a newer release. The runner updates itself; when it has not,
  `npx opscrew provision` installs OpsCrew's pinned version again.
- **a public repository whose outside contributors' runs need no approval:** high (see above).

## The GitHub token

Self-hosted runners need Administration (Read and write) on your GitHub token, for the registration
and removal tokens, the runner list and the fork pull request policy. See
[The GitHub token](security.md#the-github-token).
