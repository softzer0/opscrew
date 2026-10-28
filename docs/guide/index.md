# The OpsCrew guide

One topic per page. Start with the [Quickstart](../../README.md#quickstart) if you have not deployed
an app yet.

## Where your app runs

- [Deploy to a server you already have](own-server.md)
- [Deploy to a Portainer you already run](portainer-target.md)
- [Your app's production stack on your own computer](localhost.md)
- [Host your site on Cloudflare, with no server](cloudflare-hosting.md)
- [Publish your site on GitHub Pages](github-pages.md)
- [dev, staging and prod: environments](environments.md)
- [Several apps in one repository](several-apps.md)
- [Portainer: a web UI for your containers](portainer.md)
- [Buying or connecting a domain](domains.md)
- [Your domain on Cloudflare, and several apps in one zone](cloudflare.md)

## How your app is built and shipped

- [How OpsCrew builds your app's image](builders.md)
- [When a push deploys your app](when-deploys-run.md)
- [Deploys without downtime](zero-downtime.md)
- [Self-hosted runners and runner machines: where the deploy job and the build run](runners.md)
- [The image supply chain](supply-chain.md)
- [The reverse proxy: Caddy or nginx, and your own rules](reverse-proxy.md)

## What runs next to your app

- [What runs next to your app: components](components.md)
- [Workers and cron jobs](workers-and-cron.md)
- [Databases](databases.md)
- [Object storage](object-storage.md)
- [Message brokers and queues](brokers.md)
- [Search and analytics engines](search-and-analytics.md)

## Once your app runs

- [Your app's logs and resource figures](logs-and-status.md)
- [Alerts: the scheduled check](alerts.md)
- [Beszel: charts and history for your server](beszel.md)
- [Grafana Cloud: searchable logs and metrics, free](grafana-cloud.md)

## Using OpsCrew

- [OpsCrew in Claude Code: the plugin](claude-code-plugin.md)

## Security

- [Security: what OpsCrew sets up and checks](security.md)
- [Only Cloudflare reaches your server: origin protection](origin-protection.md)
- [Certificates, CAA records and the minimum TLS version](tls-and-caa.md)
- [The recovery copy of your app's secrets](secrets-recovery.md)
- [Deeper security checks](deeper-checks.md)
