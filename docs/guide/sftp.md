# Deploy to a host you reach over SFTP only

Some hosts give you SFTP and nothing else: no panel API, no cron, no shell. OpsCrew deploys static
sites and plain PHP apps there. With no agent on the host, GitHub Actions uploads each release and
switches to it over SFTP itself. What a hosting account fits, and what OpsCrew's commands do there,
are in [Deploy to a hosting account](hosting-accounts.md); this page is what is particular to SFTP.

## The variables

| Variable | What to set |
|---|---|
| `OPSCREW_SFTP_HOST` | Your host's SFTP address, such as `sftp.example.com` |
| `OPSCREW_SFTP_USER` | Your SFTP user |
| `OPSCREW_SFTP_KEY` | The path of your SSH key file on your computer, such as `~/.ssh/id_ed25519`; never the key itself |

Leave the `OPSCREW_HOSTING_*` variables unset: when they are set, OpsCrew reaches the account
through its panel instead. Your computer needs `sftp` and `ssh-keyscan` (OpenSSH);
`npx opscrew init` checks them.

The interview asks for the hostname, the SFTP port (22 unless your host says otherwise), the
folder to deploy into as SFTP shows it (`opscrew` unless you choose another; keep it outside the web
root), and that folder's full path as your host's PHP sees it, which differs on a chrooted account
(your host's panel shows the home folder's full path). Then it shows the host's key for you to
confirm.

## What fits

Static sites and PHP apps without a release command and without a database of OpsCrew's: with no
shell, nothing can run migrations there. An app with a release command is refused before any
change; remove `app.releaseCommand` from `opscrew/plan.yaml` if the app runs without it, or use an
account with a panel.

## What stays yours

OpsCrew can't reach the host's panel over SFTP. The plan names these as yours to set, in your host's
panel:

- **the hostname** and its document root, which the plan names
  (`<folder>/current`, or `<folder>/current/public` for an app with a `public/` folder);
- **its certificate,** and HTTPS;
- **the database,** when your app has one: put its values in the app's settings at provision;
- **its PHP version:** OpsCrew can't read it over SFTP, so releases are built with the newest
  version your app's `composer.json` allows. Set the hostname to that version, or set
  `target.php.version` in `opscrew/plan.yaml` to the version it runs.

## Provision

One plan, approved by its hash and applied over SFTP, makes the app's folder with its placeholder
release, the files that load the app's settings, the settings themselves (0600, outside the web
root), and a new SSH key for GitHub Actions:

- its private half goes straight to GitHub as a secret of the deploy environment, with the host's
  address, the folder and the host key you confirmed (`OPSCREW_SFTP_URL`,
  `OPSCREW_SFTP_PRIVATE_KEY`, `OPSCREW_SFTP_KNOWN_HOSTS`), after its own approval;
- its public half goes into the SFTP user's `~/.ssh/authorized_keys` with `restrict`, which turns
  off forwarding and terminals for it. Where the host doesn't show that file, the plan gives you the
  line to add in your host's panel, and provision stops; run it again once you have added it.

**That key can read, change and remove every file of the SFTP user,** like your own login. It is
the one credential to the host that GitHub holds.

## How a deploy works

On each push to the deploy branch, GitHub Actions builds the release, uploads it into a folder of
its own, and switches `current` to it with a new link and one rename (OpenSSH's atomic
`posix-rename`). It then checks the hostname until the app answers with the release, and switches
back when it doesn't. It keeps the 3 releases before the running one.
A PHP app with an `index.php` but no rewrite rules of its own in `.htaccess` gets every path that
isn't a file or folder sent to that `index.php`, as on a server.

There is no agent, so:

- `npx opscrew rollback` switches over SFTP from your computer, without a database choice;
- `npx opscrew status` reads the release that runs from the host;
- `npx opscrew logs` has no agent log to show: each deploy's lines are in its GitHub Actions run;
- `npx opscrew snapshot` and `restore` aren't available: copy the app's files over SFTP, and back
  up the database where your host keeps it;
- `npx opscrew destroy` removes the app's folder and GitHub Actions' key over SFTP (or lists the
  key's line for you to remove in the panel).
