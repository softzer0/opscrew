# The OpsCrew guide

One topic per page. Start with the [Quickstart](../../README.md#quickstart) if you have not deployed
an app yet.

## Where your app runs

- [Deploy to Contabo](contabo.md)
- [Deploy to a server you already have](own-server.md)
- [Deploy to a Portainer you already run](portainer-target.md)
- [Your app's production stack on your own computer](localhost.md)
- [Host your site on Cloudflare, with no server](cloudflare-hosting.md)
- [Publish your site on GitHub Pages](github-pages.md)
- [Deploy to a hosting account: cPanel, Plesk, DirectAdmin or SFTP](hosting-accounts.md)
  ([cPanel](cpanel.md), [Plesk](plesk.md), [DirectAdmin](directadmin.md), [SFTP](sftp.md))
- [Moving your app somewhere else](retarget.md)
- [dev, staging and prod: environments](environments.md)
- [Previews: a link for every pull request](previews.md)
- [Several apps in one repository](several-apps.md)
- [A server of its own for a service: split placement](split-placement.md)
- [Your devices on the private network](private-network.md)
- [Portainer: a web UI for your containers](portainer.md)
- [Buying or connecting a domain](domains.md)
- [Your domain on Cloudflare, and several apps in one zone](cloudflare.md)

## How your app is built and shipped

- [How OpsCrew builds your app's image](builders.md)
- [When a push deploys your app](when-deploys-run.md)
- [Deploys without downtime](zero-downtime.md)
- [Self-hosted runners and runner machines: where the deploy job and the build run](runners.md)
- [The image supply chain](supply-chain.md)
- [The reverse proxy: Caddy, nginx or OpenLiteSpeed, and your own rules](reverse-proxy.md)

## What runs next to your app

- [What runs next to your app: components](components.md)
- [Workers and cron jobs](workers-and-cron.md)
- [Databases](databases.md)
- [Object storage](object-storage.md)
- [Message brokers and queues](brokers.md)
- [Search and analytics engines](search-and-analytics.md)

## Once your app runs

- [Your app's logs and resource figures](logs-and-status.md)
- [Advice on size, cost and upkeep](advise.md)
- [Alerts: the scheduled check](alerts.md)
- [When a deploy fails, and how to recover](when-a-deploy-fails.md)
- [Rolling back a release](rollback.md)
- [Snapshots and restores](snapshots.md)
- [Beszel: charts and history for your server](beszel.md)
- [Grafana Cloud: searchable logs and metrics, free](grafana-cloud.md)
- [Self-hosted monitoring: Prometheus, Loki and Grafana on your own server](monitoring.md)

## Using OpsCrew

- [OpsCrew in Claude Code: the plugin](claude-code-plugin.md)

## Security

- [Security: what OpsCrew sets up and checks](security.md)
- [Only Cloudflare reaches your server: origin protection](origin-protection.md)
- [Close public SSH](public-ssh.md)
- [Your production database from your device](database-access.md)
- [Certificates, CAA records and the minimum TLS version](tls-and-caa.md)
- [The recovery copy of your app's secrets](secrets-recovery.md)
- [Rotating your app's credentials](credential-rotation.md)
- [Deeper security checks](deeper-checks.md)

## What OpsCrew adds to your repository

Everything OpsCrew sets up is a plain file in your repository, which you can read, change and keep.
For an app deployed to a new server, the main ones are:

```text
your-app/
├── Dockerfile                          your app's image, when OpsCrew writes one
├── .github/
│   ├── workflows/opscrew-deploy.yml    the deploy workflow
│   ├── workflows/opscrew-check.yml     the scheduled check
│   └── dependabot.yml                  Dependabot's update proposals
└── opscrew/
    ├── architecture.json               what analyze found in your app
    ├── ARCHITECTURE.md                 the same, for people
    ├── plan.yaml                       the setup you chose
    ├── infra/prod/                     the server, firewall and DNS as OpenTofu code
    ├── runtime/compose.yaml            what runs on the server
    ├── secrets.sops.json               the recovery copy of your secrets, encrypted to your key
    ├── SECURITY_REPORT.md              the last security check
    └── RUNBOOK.md                      how to reach, back up and remove the deployment
```

Another environment keeps its own plan, runbook, security report, runtime files and recovery copy
under `opscrew/environments/<env>/`, and its infrastructure code under `opscrew/infra/<env>/`
([environments](environments.md)).
