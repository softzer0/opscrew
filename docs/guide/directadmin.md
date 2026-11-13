# Deploy to a DirectAdmin account

OpsCrew deploys to a [DirectAdmin](https://www.directadmin.com/) user account through
DirectAdmin's API, with a small deploy script, the agent, running on the account. How it works,
what fits and what it changes are in [Deploy to a hosting account](hosting-accounts.md); this page
is what is particular to DirectAdmin.

DirectAdmin is tested against a fake of its documented API so far, not on a live account.

## The variables

| Variable | What to set |
|---|---|
| `OPSCREW_HOSTING_URL` | Your DirectAdmin's address with its port, such as `https://panel.example.com:2222`. It must start with `https://` |
| `OPSCREW_HOSTING_USER` | Your DirectAdmin user name |
| `OPSCREW_HOSTING_TOKEN` | A login key, made on DirectAdmin's Login Keys page |

Set them in your shell, then run `npx opscrew init` and `npx opscrew interview`. OpsCrew finds that
the panel is DirectAdmin by itself, and uses the login key only on your computer, as
[The panel's token](hosting-accounts.md#the-panels-token) says.

## What OpsCrew does through DirectAdmin

DirectAdmin's API for users makes the hostname, the database and its user, the cron jobs, the
agent's files and the certificate. Only one thing is a step for you in the panel: **the hostname's
PHP version,** when the app needs another version than the account's. The plan names the version
and where to set it; provision stops after listing it, and continues when you run it again.

## The document root

DirectAdmin chooses each hostname's document root itself, `domains/<hostname>/public_html` (or a
folder under the main domain's `public_html` for a subdomain made by an older DirectAdmin).
OpsCrew replaces that empty folder with a link to the running release, and its `.htaccess` rules
refuse every hostname but the app's there.

## Its limits

- **Node.js and Python apps** aren't offered on DirectAdmin.
