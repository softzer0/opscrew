---
name: opscrew-troubleshoot
description: Find out why an app OpsCrew deployed is failing, slow or using too much, from its status, resource figures, alerts and logs, all read-only with secrets masked. Use when the user asks "why is my app failing?", "why is it down?", "it's slow", "how much memory (or CPU, or disk) does it use?" or about an OpsCrew alert issue.
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
4. If the server does not answer, say so and suggest `npx opscrew verify` in a terminal; it checks
   the app from the outside.

What each target gives: on a server or the user's own computer, every part's lines; in a Portainer,
the same through its API; on Cloudflare's hosting (a server-rendered app), the requests with their
status and errors, within Cloudflare's free allowance; GitHub Pages and a static site on Cloudflare
keep no request logs, so the tool shows the last deploy runs instead.

Never read `.env` files, secrets files or private keys yourself, and never ask the user to paste a
token into the chat.
