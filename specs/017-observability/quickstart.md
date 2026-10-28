# Quickstart: validating observability

**Prerequisites:**
- An app deployed by OpsCrew on a cloud server, in a repository you can push to (the throwaway repository for live runs).
- A GitHub token with the permissions OpsCrew already uses, plus:
  - Issues: Read;
  - Actions: Read;
  - Variables: Read and write.
- For Cloudflare: an app on Cloudflare's hosting, and the Cloudflare token with:
  - Workers Tail Read;
  - Workers Observability;
  - Account Analytics Read.
- For US5: a Grafana Cloud free account, and an access policy token with only `metrics:write` and `logs:write`.
- For the webhook: an ntfy topic (or a Slack or Discord webhook).

## 1. Logs (US1, SC-1701)
```bash
npx opscrew logs
npx opscrew logs --follow            # then request the app's URL in a browser
npx opscrew logs --service db --since 1h
npx opscrew logs --service nope      # refused, with the list of names
```
**Expect:**
- the last 200 lines, newest last, each with its time;
- with `--follow`, the request's line within 10 seconds;
- a secret the app prints shown masked.

On Cloudflare (SSR), the same, with the requests' status and errors. On a static site there, and on GitHub Pages, the sentence and the last deploys.

## 2. Figures (US2)
```bash
npx opscrew status
```
**Expect:**
- the server's load against its CPUs, memory used of total, and disk used and free;
- each container's CPU, memory against its limit, restarts and uptime;
- a container near its limit, or a disk past 85%, flagged with what to do.

On a Portainer, the host's disk is named as not available. On Cloudflare, the last day's requests, errors and CPU time against the free plan.

## 3. The scheduled check (US3, SC-1702, SC-1703, SC-1705)
Run `npx opscrew design`: it shows the check, its interval and its minutes a month. Set `observability.check.webhook: ntfy` in `opscrew/plan.yaml`, then `npx opscrew provision`. Approve the check key's host plan by its hash, give the ntfy address when asked, and merge the deploy-setup pull request.

```bash
gh workflow run opscrew-check.yml     # or wait for the schedule
```
**Expect:**
- **Stop the app's container:** within one interval (plus GitHub's delay), one issue labelled `opscrew-check` names the app, the environment, the hostname and what failed. An ntfy message arrives with the same text.
- **A later failing run** adds nothing.
- **Start the app again:** the issue closes with how long it was down.
- **Fill the disk past 85%** (a large file): an issue names the server and its free space.
- **On a private repository,** design's figure is at most 750 minutes a month.

## 4. Planned outages (FR-1709)
Run `npx opscrew retarget …` up to its window, and run the check.

**Expect:**
- no issue for that environment;
- after `--finish`, the check resumes;
- `destroy` closes the environment's open issue with the reason.

## 5. Beszel (US4, SC-1706)
```bash
npx opscrew addon enable beszel        # approve the host plan by its hash
npx opscrew addon open beszel          # then open the printed address
npx opscrew addon disable beszel
```
**Expect:**
- **The plan:** shows the hub, the agent and the proxy, with their memory limits and price share.
- **The dashboard:** shows the server and its containers, through the tunnel only.
- **The proxy:** refuses `POST /containers/…/stop` with 403 (the Docker pass checks it).
- **After `disable`:** nothing of Beszel on the server.

## 6. Grafana Cloud (US5, SC-1707)
```bash
npx opscrew addon enable grafana-cloud # give the stack's URLs, user ids and the token
```
**Expect:**
- **Before any change:** the estimate of series and monthly log volume against the free tier.
- **Within 5 minutes:** the app's lines (labelled app, env, service) and the server's CPU, memory and disk in Grafana Cloud.
- **A seeded secret** arrives masked.
- **Under a tenth of 10,000 series.**

## 7. Claude Code (US6, SC-1704)
Ask the plugin "why is my app failing?" and "how much memory does it use?".

**Expect:**
- answers that match `opscrew logs` and `opscrew status`;
- the seeded secret nowhere in the conversation.
