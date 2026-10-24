# Several apps in one repository

One repository can hold more than one app, for example a landing page in `sites/landing` and its
documentation in `sites/docs`. OpsCrew deploys each as an app of its own, from the same checkout and
the same GitHub repository: each has its own target, hostnames,
[environments](environments.md), deploy workflow, deploy secrets, infrastructure state and
approvals. Destroying one leaves the other running.

## The first app and further apps

The repository's **first app** is the one you set up with `opscrew analyze`, `interview` and
`design`. When the repository has several app folders, choose its folder with `--dir`:

```bash
npx opscrew analyze --dir sites/landing
```

Each **further app** gets a short key and its own folder:

```bash
npx opscrew app add docs --dir sites/docs
```

OpsCrew checks that the folder holds an app it can deploy, and that none of the names the key gives
(below) equals another app's or environment's. Then it writes the app's record,
`opscrew/apps/docs/app.yaml`, and nothing else. Set the new app up like the first one, with
`--app docs` on every command:

```bash
npx opscrew analyze --app docs
npx opscrew interview --app docs
npx opscrew design --app docs
npx opscrew adapt --app docs
npx opscrew provision --app docs
npx opscrew verify --app docs
```

A key is 1 to 16 lower-case letters, digits or hyphens, starting with a letter. A few keys are
reserved: `prod`, `production`, `github-pages`, `modules`, `storage` and keys starting with
`storage-`, keys with `service` or `env` as one of their hyphen-separated parts, and the names
Windows reserves for devices (`con`, `nul`, `com1` and the like).

## Choosing the app

Every command that acts on an app takes `--app <key>`: `analyze`, `interview`, `design`, `adapt`,
`env`, `provision`, `promote`, `dns`, `secure`, `verify`, `drift`, `status`, `secrets`, `retarget`,
`runner start` and `destroy`. `--app .` names the first app, which has no key.

- With one app, `--app` may be left out.
- With several, a command without `--app` asks which one in a terminal. In a script it stops and
  lists the apps.

The commands OpsCrew suggests at the end of a run name the app, so you can run them as they are.
An app's environments work as for a single app, with both flags:

```bash
npx opscrew env add staging --app docs
npx opscrew provision --app docs --env staging
```

In Claude Code, the matching OpsCrew tools take an `app` input next to `environment`, and
`opscrew_app_add`, `opscrew_app_list` and `opscrew_app_remove` match the commands here.

## Listing the apps

```bash
npx opscrew app list
```

```text
App        Folder         Deployed
first app  sites/landing  yes
docs       sites/docs     no
```

## What each app has of its own

| | The first app | A further app `<key>` |
|---|---|---|
| Plan, answers, analysis, runbook, security report | `opscrew/` | `opscrew/apps/<key>/` |
| State, approvals, saved plans, records | `.opscrew/` | `.opscrew/apps/<key>/` |
| Generated passwords, deploy key, known hosts | `~/.opscrew/projects/<project>/` | `~/.opscrew/projects/<project>/apps/<key>/` |
| Infrastructure code | `opscrew/infra/prod` | `opscrew/infra/<key>` |
| Deploy workflow | `.github/workflows/opscrew-deploy.yml` | `.github/workflows/opscrew-deploy-<key>.yml` |
| Deploy secrets in GitHub | `OPSCREW_…` | `OPSCREW_<KEY>_…` |
| GitHub environment | `production` | `<key>-production` |
| Container image | `ghcr.io/<owner>/<repo>` | `ghcr.io/<owner>/<repo>/<key>` |
| Branches OpsCrew opens | `opscrew/prepare-deploy`, `opscrew/deploy-setup` | `opscrew/prepare-deploy-<key>`, `opscrew/deploy-setup-<key>` |
| App name (servers, containers, Workers) | the name design gives it | `<key>` |

A further app's environments nest inside its own folders, and their names add the environment:
`.github/workflows/opscrew-deploy-docs-staging.yml`, `opscrew/infra/docs-staging`,
`OPSCREW_DOCS_STAGING_…` and the GitHub environment `docs-staging`.

Each app also needs hostnames of its own, for example `example.com` for the landing page and
`docs.example.com` for the documentation. OpsCrew refuses a design whose hostname another app
already uses.

## What the apps share

- **The security scan.** `opscrew scan` reads the whole repository, so its report
  (`opscrew/SECURITY_SCAN.md`) covers every app.
- **Dependabot.** One `.github/dependabot.yml` covers every app's folders.
- **GitHub Pages.** A repository has one GitHub Pages site, so only one app (or environment) of a
  repository can deploy there. Design says which one has it.
- **Pushes.** Each app's workflow runs on a push to the branch it follows only when the push
  changes a path that app's deploy reads: its own folder, its `app.sharedPaths`, and its own files
  ([When a push deploys your app](when-deploys-run.md)). A push that changes only another app
  deploys only that app.

## Removing an app

Destroy the app's deployment first, then remove its files:

```bash
npx opscrew destroy --app docs
npx opscrew app remove docs
```

`app remove` deletes what OpsCrew keeps for the app: its folders in `opscrew/apps/docs`,
`.opscrew/apps/docs` and your OpsCrew home (with its deploy keys, state passphrases and generated
secrets), its infrastructure code and its deploy workflows. Your app's own folder, `sites/docs`,
stays. Because secrets go with it, you type the key to confirm; a script passes
`--confirm docs`. OpsCrew refuses while any of the app's environments is deployed, and never removes
the first app this way: `npx opscrew destroy --app .` removes its deployment.
