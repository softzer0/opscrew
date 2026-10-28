# Alerts: the scheduled check

OpsCrew adds a scheduled check to your repository that runs in GitHub Actions. Every few minutes it
checks that your app answers, that its certificate is valid and that its server's disk has room.
When something fails, it opens a GitHub issue, so everyone watching the repository is told, and it
can post the same message to Slack, Discord or ntfy. When the app recovers, it closes the issue and
says how long the problem lasted.

Nothing runs on your server for it, and it costs nothing: Actions minutes are free in a public
repository, and in a private one the check uses a small share of the minutes your plan includes.

## Turning it on

`npx opscrew design` turns the check on for prod and leaves it off for other environments. It shows
the interval, what the check reads and its Actions minutes a month. To change it for an environment,
set `observability.check.enabled` to `true` or `false` in that environment's plan
(`opscrew/plan.yaml` for prod, `opscrew/environments/<env>/plan.yaml` for another), then run
`npx opscrew provision`.

`provision` then, each step after its own approval:

1. puts the check key on the server, for the disk check (see [below](#where-it-runs));
2. stores the check's secrets in GitHub: the check key, how to reach the server, and the webhook's
   address when you set one. The approval lists their names; the values are never shown;
3. adds three files to the deploy-setup pull request:
   - `.github/workflows/opscrew-check.yml`, the workflow;
   - `opscrew/check/check.json`, what to check, rendered from every app's and environment's plan;
   - `opscrew/check/check.mjs`, the check itself: a readable script with no dependencies, the same
     in every repository.

Merge the pull request, and the check runs on its schedule. To run it at once:
`gh workflow run opscrew-check.yml`, or **Run workflow** on the "OpsCrew check" page of the
repository's Actions tab.

In scripts, `npx opscrew provision --plan-only` lists the check key's host plan with its hash, next
to the others, so every hash can be approved up front.

One check covers every app and environment in the repository, so the minutes don't multiply. Each
issue names its app and environment.

### The GitHub token

Your `GITHUB_TOKEN` needs these repository permissions besides the
[usual ones](security.md#the-github-token), only with the check on. `npx opscrew init` checks them
and names any that is missing.

- Issues: Read, for the open alerts in `status`;
- Actions: Read and write, which OpsCrew already asks for, for the check's state in `status`;
- Variables: Read and write, for pausing the check while OpsCrew moves or removes an app.

The workflow itself runs with GitHub's own token, limited to reading the repository's contents and
writing issues.

## What it checks

| Check | Fails when | The issue says |
|---|---|---|
| Each hostname (and `www` when the app serves it) at its health path over HTTPS | No answer within 10 seconds, or a status of 400 or more, on three tries 30 seconds apart. One slow answer opens nothing | The hostname, the status code or the error (such as `ECONNREFUSED`), and when it started |
| Each hostname's certificate | Fewer than 14 days left. Certificates are renewed 30 days before they expire, so this means the renewal is failing | The days left, and the command to see why |
| Each server's disk | 85% full, and again at 95% | The server, its free space and what usually fills it (old images and logs) |

On a hostname behind Cloudflare's proxy, the certificate the check sees is Cloudflare's.
`npx opscrew secure` and `npx opscrew status` check the server's own.

A server that several environments share is checked once.

## Where it runs

The check runs on GitHub's `ubuntu-slim` runner, a small machine that takes under half a minute for
the whole check.

The disk is read where the deploy job runs:

- **When GitHub deploys to the server over SSH,** the check connects with the **check key**: one key
  pair per repository, which OpsCrew makes. Its public half is in the deploy user's
  `authorized_keys` on each checked server, limited to one command: `df -P -B1 /`. Whatever the
  key asks for, the server runs only that, with no shell, no terminal, no port forwarding and no
  file copy. A leaked check key reads one disk figure.
  - A new cloud server gets the key's line when it is created, in the infrastructure plan.
  - An existing server, or your own, gets it through a host plan that you approve by its hash.
- **On a [runner machine](runners.md#runner-machines),** a job on that machine uses the check key in
  the same way.
- **On a server that deploys from [its own runner](runners.md#the-servers-runner),** a job on that
  runner runs `df` there, so GitHub needs no way in. Jobs on self-hosted runners cost no Actions
  minutes. When the server is down, its disk job waits for the runner, and the main check reports
  the outage over HTTPS meanwhile.

The check key's private half is the repository secret `OPSCREW_CHECK_SSH_KEY`. Each environment's
server address, SSH port, user and host key are in the repository secret `OPSCREW_CHECK_SERVER`
(with the environment's prefix outside prod). `check.json` names those secrets and never an
address, so a proxied site's server stays hidden. The key is also in the
[recovery copy](secrets-recovery.md).

## The issues

Each failing check gets one issue, labelled `opscrew-check`, with a title such as
"OpsCrew check: example-app (prod) does not answer on example.com". The body says when it started,
what failed, and what to run to see more (`npx opscrew status`, `npx opscrew logs`).

- **While the problem lasts,** later runs add nothing to the issue.
- **When what fails changes,** for example a timeout that becomes a 502, the check adds one comment
  and updates the title.
- **When the check passes again,** it closes the issue with how long the problem lasted.
- **A check that is no longer in `check.json`** gets its open issue closed with that reason.

GitHub tells everyone watching the repository about a new issue, by email too, depending on each
person's notification settings. The issues are opened by `github-actions[bot]`.

What goes into an issue or a post is fixed text, names, hostnames, status codes, error codes, days
and disk figures. The check never copies what your app answered, its headers or a server's address,
so nothing your app returns can carry a secret into them.

## The webhook: Slack, Discord or ntfy

The check can post the same message when it opens or closes an issue. Choose one kind for the
repository in `opscrew/plan.yaml` (the first app's prod plan; any other plan refuses it):

```yaml
observability:
  check:
    webhook: ntfy   # or slack, or discord
```

Then run `npx opscrew provision`. In a terminal it asks for the webhook's address without showing
it; in scripts, set `OPSCREW_CHECK_WEBHOOK` to the address. The address is stored only as the
repository secret `OPSCREW_CHECK_WEBHOOK`, never in a file, a plan, a log or the audit log.

- **Slack:** create an app at <https://api.slack.com/apps>, turn on **Incoming Webhooks**, choose
  **Add New Webhook to Workspace** and the channel, and copy the URL. Messages are cut at 4,000
  characters.
- **Discord:** in the channel's settings, **Integrations** → **Webhooks** → **New Webhook**, then
  **Copy Webhook URL**. The check's messages mention nobody. They are cut at 2,000 characters.
- **ntfy:** the topic's URL, such as `https://ntfy.sh/<topic>` or a topic on your own ntfy server.
  On ntfy.sh, anyone who knows a topic's name can read it, so pick a long, random one, or protect it
  and set `OPSCREW_CHECK_NTFY_TOKEN` to an access token. Openings are sent with priority 4, closings
  with 3. ntfy.sh allows 250 messages a day.

GitHub keeps the address it holds. To change it, or after changing the webhook's kind, set
`OPSCREW_CHECK_WEBHOOK` to the new address and run `npx opscrew provision` again: without it, the
check keeps posting to the old address.

## The interval and what it costs

The check runs every 60 minutes in a private repository and every 15 in a public one. Set another
interval for the whole repository in `opscrew/plan.yaml`: `observability.check.intervalMinutes`, one
of 5, 10, 15, 20, 30 or 60. GitHub runs schedules at most every 5 minutes. The check starts at a
minute off the hour, which your repository's name picks, because GitHub delays the runs it has to
start at the top of each hour.

In a public repository, the check's minutes are free. In a private one, GitHub rounds each run up to
a whole minute, and a minute on `ubuntu-slim` uses a third of an included minute. Over a 31-day
month:

| Interval | Runs | `ubuntu-slim` minutes | Included minutes used |
|---|---|---|---|
| 60 minutes | 744 | 744 | 248 |
| 30 minutes | 1,488 | 1,488 | 496 |
| 20 minutes | 2,232 | 2,232 | 744 |
| 15 minutes | 2,976 | 2,976 | 992 |
| 10 minutes | 4,464 | 4,464 | 1,488 |
| 5 minutes | 8,928 | 8,928 | 2,976 |

GitHub Free includes 2,000 minutes a month for private repositories, and Pro and Team 3,000. Design
shows the check's minutes against your plan, and warns when an interval you set uses more than 750
`ubuntu-slim` minutes a month on GitHub Free. Without a payment method, GitHub stops every job once
the included minutes run out, deploys included.

## GitHub's 60-day rule

In a public repository, GitHub turns scheduled workflows off after 60 days without activity in the
repository. GitHub doesn't document whether it tells anyone. So the check warns itself: from 50 days
after the last commit on the default branch, it opens an issue that says how to keep it running. It
closes that issue when a newer commit appears.

- **To keep it running,** push any commit to the default branch within every 60 days.
- **When GitHub has turned it off,** `npx opscrew status` says so. Turn it on again on the
  repository's Actions tab ("OpsCrew check", then **Enable workflow**), or with
  `gh workflow enable opscrew-check.yml`.

A private repository has no such rule.

## Planned outages, forks, and issues turned off

- **Planned work:** while `npx opscrew retarget` moves an app (its maintenance window) or
  `npx opscrew destroy` removes it, OpsCrew pauses the check for that environment, after an
  approval. The check then opens no issue for it, and closes its open ones with the reason. The
  pause is the repository variable `OPSCREW_CHECK_PAUSED`. The next healthy deploy by
  `npx opscrew provision`, or `retarget --finish`, removes it again.
- **Your own maintenance:** `gh workflow disable opscrew-check.yml` pauses the whole check, for every
  app of the repository, and `gh workflow enable opscrew-check.yml` turns it on again. The Actions
  tab has the same buttons.
- **Forks:** GitHub keeps scheduled workflows off in forks, and the workflow runs only in your
  repository, so a fork opens no issues.
- **Issues turned off** in the repository: design says so. The check then posts to the webhook and
  writes the run's summary, and its run fails while something fails. A failed scheduled run tells
  only the person who last changed the workflow's schedule. With no issue to record that a message
  was already sent, the webhook gets the message on every failing run.

## Turning it off

Set `observability.check.enabled` to `false` in the environment's plan and run
`npx opscrew provision`: its pull request updates `check.json`. When no environment has the check
on, OpsCrew writes no check files any more: delete `.github/workflows/opscrew-check.yml` and
`opscrew/check/` yourself, or turn the workflow off on the Actions tab.

## What it can't do

- **Alert within a minute:** GitHub runs schedules at most every 5 minutes, and can delay a run by
  several minutes when it is busy. Expect an issue within the interval plus up to about 10 minutes.
- **Check your computer:** GitHub can't reach an app running [on your computer](localhost.md), so
  design offers no check there.
- **Read the disk of a Portainer's server:** OpsCrew reaches your Portainer only through its API.
  The check still checks the app's hostnames.
- **Read the disk of your own server reached through a Cloudflare Tunnel,** unless the server
  deploys from [its own runner](runners.md#the-servers-runner): the check's SSH can't pass the
  tunnel's Cloudflare Access login.
- **Disks on Cloudflare's hosting and GitHub Pages:** there is no server of yours. Their hostnames
  and certificates are checked.
- **Watch memory and CPU:** `npx opscrew status` shows them, and [Beszel](beszel.md) can alert on
  them.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md)'s status answer includes the check's state and its open
alerts.
