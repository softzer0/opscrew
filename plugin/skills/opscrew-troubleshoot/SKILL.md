---
name: opscrew-troubleshoot
description: Find out why an app OpsCrew deployed is failing, slow or using too much, from its status, resource figures, alerts and logs, all read-only with secrets masked, and when a recent release is the cause, how to roll it back in the terminal. Use when the user asks "why is my app failing?", "why is it down?", "it's slow", "how much memory (or CPU, or disk) does it use?", "undo the last release", "roll back", or about an OpsCrew alert issue.
---

# Troubleshooting with OpsCrew

Everything here is read-only: these tools change nothing on the server, in the Portainer or on
Cloudflare. Secrets in log lines arrive masked; never try to recover them.

1. **Status first.** Call `opscrew_status` (with `app` and `environment` when the repository has
   several). Read, in this order:
   - **Components:** which part (`app`, a worker, a cron job, a service such as `db`) is stopped or
     has no container.
   - **Resources (read now):** the server's load against its CPUs, memory used of total, the disk,
     and each container's CPU, memory against its limit, restarts and uptime. On Cloudflare's
     hosting: the last day's requests, errors and CPU time per request against the free plan.
   - **Flags:** each line starting `Warning:` or `High:` says what a figure means and what to do:
     memory at 90% of a limit (the container is stopped and restarted at the limit), the disk at 85%
     or 95%, a restart since the last deploy.
   - **Not available:** figures this target can't give (the host's disk in a Portainer; everything
     on GitHub Pages). Say so; don't guess them.
   - **Scheduled check:** whether GitHub turned it off (it says how to turn it on again) and its open
     alerts, each a GitHub issue with a link.
   - **Several servers:** an app whose services run on servers of their own shows each server by
     name with its components and figures, then the private network: each link between the servers
     (`links` in the data: up or down, the last handshake, the round trip measured from the app's
     server), each device's last handshake, the grants and whether public SSH is open. A link
     down, or a line saying a service is not published on its server's private address, explains a
     database or cache the app can't reach: pass on the command the line names
     (`npx opscrew provision`). A long round trip explains slow pages that make many queries in a
     row. A device that never connects to a server added later needs a new configuration, which
     the user makes in their terminal (`npx opscrew vpn add <name> --again`): it holds a private
     key, so it never goes through this chat.
2. **Then the logs of the failing part.** Call `opscrew_logs` with `service` set to that part and a
   short `since` (`15m`, `1h`; `2h` at most at first). Without `service` it reads the web process
   (`app`); `edge` is the proxy in front of the app. Keep `tail` at 200 or less, and never ask for
   more than 500 lines: the tool returns at most 500 lines and 64 KiB (`truncated: true` means older
   lines were left out, so narrow `since` instead of raising `tail`). It never follows; for live
   lines the user runs `npx opscrew logs --follow` in a terminal.
3. **Explain** the cause in plain English, with the lines or figures that show it, and the fix:
   - **Restarts, or memory near the limit:** the app runs out of memory. Raise the part's `memoryMb`
     in `opscrew/plan.yaml` and provision again (`npx opscrew provision` shows the plan first), or
     fix what holds memory.
   - **Disk filling up:** old images and logs usually fill it; the flag names the command.
   - **High load against the CPUs, or slow requests:** a bigger server type, or the slow code path the
     lines show.
   - **Errors in the lines:** point to the code, and offer a fix the user approves.
   - **It started with the latest release:** see "A release that deploys fine but is wrong" below.
4. If the server does not answer, say so and suggest `npx opscrew verify` in a terminal; it checks
   the app from the outside.

## A release that deploys fine but is wrong

A broken page or a new bug right after a deploy that passed its checks usually comes from that
release. Read `deploys` in `opscrew_status`'s data: `running` (the version live now, with its
commit, message and time), `previous` (the one before it) and `paused` (deploys paused by an
earlier rollback, or by a move). When the problem started with the running version, or the user
asks to undo a release:

1. **First state the database caveat**, in these words or close to them:
   - the data and the database schema stay as they are now;
   - the release command (migrations) doesn't run;
   - so the earlier version must work with the newer schema: a migration that removed or renamed
     something it uses breaks it;
   - restoring a backup is a separate step, which a rollback doesn't do.
2. **Then ask the user to run it in their terminal:** `npx opscrew rollback` goes back to the
   previous version (add `--env <name>` when the app has several environments). It shows the
   version running and the one it goes back to, and asks for approval. `npx opscrew rollback --list`
   shows the versions still available, and `npx opscrew rollback --to <one of them>` goes back
   further. Never roll back through a tool: it stays in the terminal, because it asks for approval.
3. **Afterwards** the environment's automatic deploys stay paused, so the next push doesn't bring
   the bad release back. Once the fix is pushed, the user runs `npx opscrew rollback --resume` (add
   `--deploy` to deploy the branch's latest commit now). Then call `opscrew_status` to confirm.

When `paused` is a move's window, a rollback is refused until the move ends: say so instead.

What each target gives: on a server or the user's own computer, every part's lines; in a Portainer,
the same through its API; on Cloudflare's hosting (a server-rendered app), the requests with their
status and errors, within Cloudflare's free allowance; GitHub Pages and a static site on Cloudflare
keep no request logs, so the tool shows the last deploy runs instead.

Never read `.env` files, secrets files or private keys yourself, and never ask the user to paste a
token into the chat.
