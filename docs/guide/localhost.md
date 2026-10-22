# Your app's production stack on your own computer

OpsCrew can run your app on your own computer exactly as production runs it: the same Docker
Compose project, the same components with the same memory limits, and the same proxy in front
(Caddy or nginx, with kamal-proxy). You see it at a local HTTPS address such as
`https://shop.localhost`. You need no server, no cloud account and no domain, and it costs nothing.

It is the cheapest place to try a change with real containers, and with the
[local runner](runners.md#the-local-runner) you can run the whole pipeline (commit, push, the
workflow, the deploy job) against your own computer before it touches a server.

## What you need

- **Docker** that runs Linux containers, with Docker Compose 2.23 or newer:
  - Windows and macOS: Docker Desktop, or one of the free alternatives below;
  - Linux: Docker Engine;
  - macOS: Colima works too.
- **On Windows: Git for Windows.** OpsCrew runs the same deploy scripts a server runs, with Git for
  Windows' `bash`.
- **Enough memory for Docker:** the stack's memory limits must fit in the memory Docker has (see
  [When OpsCrew stops](#when-opscrew-stops-without-changing-anything)).

### Docker Desktop's licence

Docker Desktop is free for personal use, education, open-source projects and companies with fewer
than 250 employees and less than US$10 million in yearly revenue. Larger companies and governments
need a paid subscription. Free alternatives: Docker Engine on Linux, Colima on macOS, Rancher
Desktop and Podman. OpsCrew works with any of them and enforces nothing; it says this once when
Docker Desktop is, or may become, your computer's Docker.

## Step by step

For an app with no deployment yet, choose **This computer** in the interview:

```bash
npx opscrew interview         # choose "This computer" as the target (provider: localhost)
npx opscrew design            # reads this computer's CPU and the free ports
npx opscrew provision         # shows the local plan, and runs the stack after your approval
```

Next to an existing deployment, add it as an environment (`dev` runs on this computer by default):

```bash
npx opscrew env add dev
npx opscrew provision --env dev
```

`provision` first checks this computer (see below), then shows the **local plan**: every container,
network, volume, folder and certificate it will create or change, with the hostnames and ports. It
changes nothing until you approve that exact plan by its hash. In scripts:

```bash
npx opscrew provision --plan-only           # prints the local plan's hash
npx opscrew provision --approve <hash>
```

Then open the address it prints. `npx opscrew verify`, `status`, `drift`, `secure` and `destroy`
work as on a server.

## The address

- The app answers at `https://<app>.localhost`.
- Beside another of the app's environments on this computer, each answers at
  `https://<env>.<app>.localhost` (prod's at `https://prod.<app>.localhost`).
- Several apps on this computer share one local proxy, each on its own address, as several apps
  share one server.
- The address answers only on this computer: every port is bound to 127.0.0.1, never to your
  network.

Browsers and curl resolve every `*.localhost` name to your own computer by themselves. Not every
program does: on Windows and macOS, the system's resolver and Node.js do not know `app.localhost`.
That is why OpsCrew's own checks never look the name up: they connect to 127.0.0.1 and send the
hostname in the request and in the TLS handshake. If another tool of yours cannot find the name,
point it at `127.0.0.1` with the hostname as its `Host` header.

### Ports 443 and 8443

The proxy listens on ports 443 and 80 when they are free. When another program holds one (on
Windows often IIS or another web server), design picks 8443 and 8080 instead, and every address
OpsCrew prints says the port, such as `https://shop.localhost:8443`. Every OpsCrew app on this
computer uses the same two ports, since they share the proxy. A port that becomes taken later stops
`provision` with what to do.

## The local certificate authority

The site's certificates come from **OpsCrew's local certificate authority**, made once per computer
on first use, in `~/.opscrew/local-ca/`:

- `ca.pem` is its certificate, valid for 10 years;
- `ca.key` is its private key, readable only by you. It is never committed, copied, printed or put
  into a plan, a log or the recovery copy.

Each local hostname gets a certificate from it, valid for one year. `provision` renews it when
fewer than 30 days remain. Caddy and nginx both serve these certificates; no public certificate
authority is asked, and nothing leaves your computer.

### Trusting it, and undoing that

Without trust the site still works, and your browser shows a warning. To make this computer's
browsers trust OpsCrew's CA:

```bash
npx opscrew localhost trust      # shows the exact command first, and runs it only after you agree
npx opscrew localhost untrust    # takes it out again
```

The command it runs, per system (`untrust` reverses each):

| System | `trust` runs | What it changes |
|---|---|---|
| macOS | `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.opscrew/local-ca/ca.pem` | your login keychain; macOS may ask for your password |
| Windows | `certutil -user -addstore Root <your user folder>\.opscrew\local-ca\ca.pem` | your user's trusted root certificates (no administrator); Windows asks you to confirm |
| Linux | `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n "OpsCrew local CA" -i ~/.opscrew/local-ca/ca.pem` | the certificate database Chrome and Chromium use |

On Linux, programs that use the system's certificates instead of the browser's (curl, for example)
need the system store too. OpsCrew prints that command for you to run, since it needs `sudo`:
`sudo cp ~/.opscrew/local-ca/ca.pem /usr/local/share/ca-certificates/opscrew-local-ca.crt && sudo update-ca-certificates`.

In a script, `localhost trust` only prints the command. Trust applies to this computer only and is
never needed for OpsCrew's own checks.

## How it differs from a server

The stack is the production stack, with exactly these differences, each stated in the local plan:

- no SSH, no server hardening, no firewall, no DNS records and no Cloudflare;
- every published port bound to 127.0.0.1 only;
- certificates from OpsCrew's local certificate authority instead of a public one (no Let's
  Encrypt, no certbot, no origin certificate, no Cloudflare-only filter);
- the image built on this computer when its CPU differs from production's (below);
- the data the server keeps in `/srv/data/<app>` kept in Docker volumes,
  `opscrew-<app>_<component>_data`.

The deploy itself is the production deploy: OpsCrew runs the same switch scripts a server runs,
with this computer's shell, in `~/.opscrew/local/srv/apps/<app>` and `~/.opscrew/local/srv/edge`
instead of `/srv/apps` and `/srv/edge`. OpsCrew never runs it as root.

### Your computer's processor, and the image

- **The same CPU as production** (for example an x86 laptop and a cloud server): the stack runs the
  image production runs, from GitHub Container Registry by its digest, byte for byte. For a private
  image, set `OPSCREW_GHCR_READ_TOKEN` to a classic token with only `read:packages`
  (<https://github.com/settings/tokens/new?scopes=read:packages>), since the registry may not
  accept a fine-grained token.
- **Another CPU** (an Apple silicon Mac and an x86 server): when this computer can build the image
  as GitHub Actions does, OpsCrew builds it here for its own CPU with `docker build`, and says that
  it differs from production's image. That is the case for OpsCrew's own Dockerfile, and for your
  own Dockerfile when the app has no cron jobs and no SQLite. To run production's image under
  emulation instead (slower), set `target.image: registry` in the environment's plan. Every other
  app (built with Buildpacks or Railpack, or from your own Dockerfile with cron jobs or SQLite,
  which the build on GitHub adds to) runs production's image here, under emulation, with a warning.
- **No other environment builds the image** (an app that runs only on this computer): OpsCrew
  builds it on this computer, in the same cases. Otherwise `provision` needs an image of the app on
  GitHub Container Registry, labelled by an environment that runs it.

## When OpsCrew stops without changing anything

`provision` checks this computer first, and names the fix when:

- Docker is not installed or not running, or runs Windows containers (switch Docker Desktop to
  Linux containers);
- Docker Compose is older than 2.23;
- the stack's memory limits add up to more than Docker's memory. Give Docker more (Docker Desktop:
  Settings → Resources; with WSL 2, `memory=` in `.wslconfig` in your user folder; Colima:
  `colima start --memory`), or lower the limits in the plan. `status` warns when Docker's memory
  was lowered later;
- a port the stack needs is taken by another program;
- on Windows, Git for Windows' `bash` is not found;
- a component needs a kernel setting of the Docker host (such as OpenSearch or Elasticsearch), or
  the app's bucket is at a cloud provider: on this computer, use the hosted service, or Garage for
  the bucket.

## What `secure` checks here

`npx opscrew secure` checks only what applies to a local stack:

- the stack listens on 127.0.0.1 only;
- the containers run hardened, as OpsCrew renders them;
- only you can read the local CA's key and the app's env files (Windows keeps them in your user
  folder, where file modes do not apply);
- the site's certificate is valid and comes from OpsCrew's local CA.

It does not harden your computer: a server's checks (SSH, firewall, fail2ban, automatic updates,
kernel settings) do not apply, and your computer's own security stays yours. Nothing probes it from
outside.

## Day to day

- The stack comes back whenever Docker starts. It is not meant to run unattended: on Windows,
  Docker Desktop starts only after you log in.
- The runbook (`opscrew/RUNBOOK.md`, or the environment's own) lists the everyday Docker commands.
- `npx opscrew destroy` removes OpsCrew's containers, networks and folders for the app. The data
  volumes stay unless you add `--delete-data`. The shared proxy goes with the last app.
- OpsCrew does not back up the data volumes on this computer.
