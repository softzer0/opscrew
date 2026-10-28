# ADR 0021: Observability, light and free

**Status**: Proposed (2026-10-28, feature 017). The founder set the scope on 2026-10-16 and gave the go-ahead on 2026-10-28. The design is the lead's.

## Context

Once an app is live, OpsCrew couldn't show its logs, how much it uses, or tell anyone it was down. The founder asked for the basics, free and light:
- logs and figures from the terminal;
- alerts from GitHub Actions;
- two opt-in add-ons, Beszel and Grafana Cloud through Grafana Alloy;
- no self-hosted monitoring stack.

## Decision

- **Reading is read-only and on demand:**
  - `opscrew logs` and the figures in `opscrew status` use the read paths `status` already has: fixed commands over SSH, Docker's API through a Portainer, local Docker, and Cloudflare's APIs;
  - `RemoteExec.run` gains `onLine` and `signal`, for `--follow`.
- **One scheduled check per repository,** in GitHub Actions, delivered in the deploy-setup pull request:
  - a vendored Node script with no dependencies, and generated JSON with no addresses or secrets;
  - one job on GitHub's runners for every app and environment, plus a free job on each server's own runner;
  - **alerts** are GitHub issues found again by a hidden marker, with an optional Slack, Discord or ntfy post;
  - **the disk** is read with a per-repository key that each server lets run only `df` (OpenSSH `restrict,command=`), added by a host plan step;
  - **planned outages** (retarget's window, destroy) pause it through a repository variable, `OPSCREW_CHECK_PAUSED`.
- **Add-ons on servers,** each added and removed by a host plan approved by its hash, as Portainer's web UI is:
  - **Beszel:** the hub and agent, or only the agent connected out to the user's hub over WebSocket;
  - **Grafana Alloy:** masked logs and a short list of server metrics to the user's Grafana Cloud stack.
- **Docker access for the add-ons:**
  - Neither mounts Docker's socket. Each reads through an OpsCrew-rendered Caddy, already pinned, that passes only `GET` on an exact list of paths and answers 403 to everything else.
  - Beszel's list leaves out inspect and logs.
- **Plan:** `plan.observability` holds `check`, `beszel` and `grafanaCloud`. The check's interval and webhook kind are repository-wide, in the first app's prod plan.
- **No new approval kind:**
  - host steps: `host-apply`;
  - the dashboard's hostname: `iac-apply` and `cloudflare-apply`;
  - the check's files: `pull-request`;
  - its secrets: `github-secrets`;
  - the pause: `github-settings`.

## Consequences

- **A contract change (T1701a):** `plan.observability`, and `RemoteExec`'s streaming options.
- **Servers:**
  - a second key, which can only run `df`;
  - when an add-on is on, its containers, with memory limits counted in design's memory line.
- **GitHub:**
  - new token permissions, asked only when the check is on: Issues: Read, Actions: Read, and Variables: Read and write;
  - in a private repository, the check uses at most 750 of the included minutes a month by default;
  - in a public one, GitHub turns it off after 60 days without activity, so the check warns from day 50 and `status` shows the state.
- **Alloy can read the containers' settings** through Docker's inspect, which holds the app's environment. It runs on the user's server and sends only masked lines. The guide says so.
- **Out of scope:**
  - a self-hosted Grafana, Prometheus or Loki stack;
  - traces and error tracking;
  - status pages;
  - cross-project dashboards and team alerts (the hosted control plane);
  - the add-ons on Portainer and localhost;
  - container metrics in Grafana Cloud (cAdvisor needs privileges).
