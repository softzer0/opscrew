# Deploy to a cPanel account

OpsCrew deploys to a [cPanel](https://cpanel.net/) account through cPanel's API, with a small
deploy script, the agent, running on the account. How it works, what fits and what it changes are
in [Deploy to a hosting account](hosting-accounts.md); this page is what is particular to cPanel.

## The variables

| Variable | What to set |
|---|---|
| `OPSCREW_HOSTING_URL` | Your cPanel's address with its port, such as `https://panel.example.com:2083`. It must start with `https://`. Your host's welcome email names it |
| `OPSCREW_HOSTING_USER` | The account's cPanel user name |
| `OPSCREW_HOSTING_TOKEN` | An API token: in cPanel, open **Security → Manage API Tokens → Create**, and give it an expiry date |

Set them in your shell, then run `npx opscrew init` and `npx opscrew interview`. OpsCrew finds that
the panel is cPanel by itself. The token reaches the whole account; see
[The panel's token](hosting-accounts.md#the-panels-token).

## What OpsCrew does through cPanel

cPanel's API covers everything the app needs, so a cPanel account takes no step by hand:

- the hostname, as a subdomain of one of the account's domains or as an addon domain;
- the database and its user, MySQL or MariaDB;
- the agent's and the app's cron jobs;
- the agent's files;
- the certificate: an AutoSSL check for the hostname, and its removal at destroy when nothing else
  uses it;
- the hostname's PHP version through MultiPHP, where the account has MultiPHP.

## Its limits

- **The document root.** Where your host restricts document roots to `public_html`, the hostname's
  root is the link `public_html/opscrew-<app>-<env>`, and OpsCrew's `.htaccess` rules refuse every
  hostname but the app's there. Otherwise the root is the release's folder in `~/opscrew/`.
- **PHP per hostname.** Without MultiPHP, the hostname gets another PHP version than the account's
  only through CloudLinux's handler line on LiteSpeed, with that version's default extensions; see
  [The PHP version](hosting-accounts.md#the-php-version).
- **Node.js and Python apps** run through CloudLinux's selector where the account has it, one app
  slot each. cPanel's Application Manager isn't used yet.
- **A deleted database can show up again** in cPanel's list for a few minutes. Destroy checks the
  database again at the end and removes it once more when it is back.
- **AutoSSL needs the hostname's DNS** to point at the account. When it doesn't yet, provision says
  why and the app answers over HTTP until the certificate comes.
