# Deeper security checks

`npx opscrew secure` checks what OpsCrew set up: SSH, the firewall, fail2ban, updates, Docker, the
ports that answer from outside, and the certificates. With `--deep` it also asks three well-known
auditing tools for a second, independent opinion:

| Tool | What it audits | Where it runs |
|---|---|---|
| [Lynis](https://cisofy.com/lynis/) 3.1.7 | the whole server | on the server, in a throwaway container |
| [ssh-audit](https://github.com/jtesta/ssh-audit) 3.9.0 | the SSH service's algorithms and keys | in Docker on your computer |
| [testssl.sh](https://testssl.sh) 3.2.4 | the TLS a visitor sees on each public hostname | in Docker on your computer |

```bash
npx opscrew secure --deep
```

It takes a few minutes (Lynis has at most 4, ssh-audit 1, testssl.sh 2 per hostname), costs
nothing, and changes nothing. Without `--deep`, `secure` runs and takes as long as before.

## What you need

- Docker on your computer for ssh-audit and testssl.sh. Without it they are skipped, with how to
  install Docker, and Lynis still runs.
- Nothing new on the server: Lynis runs through the server's Docker, as the deploy user.

## What it changes

Nothing. Each tool runs from a pinned version: the images by digest, Lynis's archive checked by its
SHA-256 inside the container. Lynis sees the server's files through a read-only mount, writes only
to a temporary folder that goes with its container, and its image is removed afterwards when it was
not on the server before. The deeper checks never apply a fix.

## Reading the results

The results go into `opscrew/SECURITY_REPORT.md` under **Deeper checks**, one part per tool with
its version (and Lynis's hardening index), ranked with OpsCrew's own severities:

| Tool | Finding | Severity |
|---|---|---|
| Lynis | a warning | medium |
| Lynis | a suggestion | low |
| Lynis | a hardening index below 65 | medium |
| ssh-audit | the Ubuntu 24.04 policy fails | high |
| ssh-audit | a weak algorithm or option | low |
| testssl.sh | critical, high, medium, low | the same |

**Known noise** is listed apart, each with its reason, and not counted. For example: separate disk
partitions and a GRUB password (Lynis), NIST curves that current clients still use (ssh-audit), and
OCSP stapling, which Let's Encrypt no longer offers (testssl.sh).

When a finding is something OpsCrew manages, such as an SSH setting, the report names the change.
It happens only through OpsCrew's own plans, which you approve, never by itself. OpsCrew's servers
already restrict SSH to modern key exchanges, ciphers, MACs and host keys, so ssh-audit passes there
apart from the known noise; on [a server you already have](own-server.md) the host plan applies the
same settings.

## Behind Cloudflare's proxy

For a proxied hostname, testssl.sh tests what visitors see, which is Cloudflare's edge, and the
report labels it so. Your server's own certificate and its client-certificate requirement are
checked separately by `secure`, from the server itself (see
[origin protection](origin-protection.md)).

## When a check cannot run

- **Your address is blocked** (by fail2ban or a firewall, for example after many SSH attempts): the
  run says the connection was refused or timed out. It never reports a pass it did not see.
- **Your Portainer:** only testssl.sh runs. OpsCrew has no SSH access to the host there, so Lynis
  and ssh-audit are skipped, and the report says why.
- **No domain yet:** testssl.sh is skipped until the app has one.
