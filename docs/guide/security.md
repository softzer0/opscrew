# Security: what OpsCrew sets up and checks

OpsCrew hardens what it deploys and keeps checking it. Nothing here needs a model or costs money.
Every change goes through a plan you approve by its hash, and no secret ever goes into a plan, a
log, a report, a pull request or your repository (only the encrypted
[recovery copy](secrets-recovery.md) does).

## What OpsCrew sets up

**On the server** (one OpsCrew creates, or [one you already have](own-server.md) through the host
plan):

- a `deploy` user with key-only SSH, no password logins, and SSH limited to modern algorithms;
- a firewall that lets in only SSH and web traffic, fail2ban, and automatic security updates;
- Docker with log limits, and every container port kept on the server except the proxy's 80 and
  443.

**In front of the app:**

- HTTPS only, with TLS 1.2 and 1.3, the same security headers on [Caddy and nginx](reverse-proxy.md),
  and a refusal for hostnames the server does not serve;
- behind Cloudflare's proxy: [origin protection](origin-protection.md), so only Cloudflare acting
  for your zone reaches the server, plus OpsCrew's [Cloudflare rules](cloudflare.md) (the probe
  block for paths like `/.env`, and Full (strict) TLS);
- [CAA records and the zone's minimum TLS version](tls-and-caa.md);
- your own [proxy rules](reverse-proxy.md#your-own-rules), checked before they go live.

**For the app's services:** every database and cache OpsCrew runs gets a generated password,
Valkey included, and every service is reachable only from the app's own containers.

## What OpsCrew checks

| Command | What it checks |
|---|---|
| `npx opscrew scan` | the repository: leaked secrets, exposed Supabase or Firebase data, risky configuration |
| `npx opscrew secure` | the server's hardening over SSH, the ports that answer from outside, the plan's policies, the certificates, the Cloudflare settings and the recovery copy; writes `opscrew/SECURITY_REPORT.md` |
| `npx opscrew secure --deep` | also Lynis, ssh-audit and testssl.sh: see [deeper checks](deeper-checks.md) |
| `npx opscrew verify` | the live site: DNS, HTTPS, the health endpoint, the headers, that `.env` and `.git` are not served, and that the server cannot be reached around Cloudflare |
| `npx opscrew drift` | changes made outside OpsCrew, on the server, at the provider and at Cloudflare |
| `npx opscrew status` | each certificate's expiry, the proxy and the recovery copy's state |

`secure` also warns about:

- a certificate with fewer than 30 days left;
- a Cloudflare token without the permissions for origin protection;
- a CAA record that is not OpsCrew's at one of the app's names, or a minimum TLS version it could
  not raise;
- a repository that became public with the recovery copy in it;
- Valkey answering without its password;
- a [self-hosted runner](runners.md#status-and-updates) that is offline or more than 21 days behind
  GitHub's runner release, and, as high, a public repository with a self-hosted runner whose outside
  contributors' workflow runs need no approval.

For a stack [on your computer](localhost.md#what-secure-checks-here), `secure` checks only what
applies there.

## The Cloudflare token

Give `CLOUDFLARE_API_TOKEN` these zone permissions (`npx opscrew init` lists them):

- Zone → Zone → Read
- Zone → DNS → Edit
- Zone → Zone WAF → Edit
- Zone → Config Rules → Edit
- Zone → SSL and Certificates → Edit
- Zone → Zone Settings → Edit

Tunnels, Cloudflare Access and R2 need a few more; see
[Cloudflare token permissions](cloudflare.md#cloudflare-token-permissions).

## The GitHub token

Give `GITHUB_TOKEN` (or `GH_TOKEN`) a fine-grained token for your app's repository only, created at
<https://github.com/settings/personal-access-tokens/new>, with these repository permissions
(`npx opscrew init` lists them). A logged-in GitHub CLI (`gh auth login`) works too.

- Contents: Read and write
- Pull requests: Read and write
- Secrets: Read and write
- Actions: Read and write (this also lets OpsCrew read GitHub environments)
- Workflows: Read and write
- Metadata: Read
- Administration: Read and write, only for an app with
  [several environments](environments.md#where-each-environments-secrets-live) (OpsCrew creates
  their GitHub environments) and for [self-hosted runners](runners.md) (runner registration and the
  fork pull request policy)
- Environments: Read and write, only for an app with several environments (the secrets in their
  GitHub environments)

GitHub's container registry may not accept a fine-grained token. Where OpsCrew reads it
([`opscrew promote`](environments.md#the-registry-token-for-promote), a private image
[on your computer](localhost.md#your-computers-processor-and-the-image) or in
[your Portainer](portainer-target.md#the-tokens-and-what-they-may-do)), set
`OPSCREW_GHCR_READ_TOKEN` to a classic token with only the `read:packages` scope:
<https://github.com/settings/tokens/new?scopes=read:packages>.
