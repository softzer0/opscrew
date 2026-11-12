# ADR 0030: Hosting accounts: set up through the panel, deployed by an agent on the account

**Status**: Accepted (2026-11-12, feature 027). The founder set the scope in the roadmap (cPanel,
Plesk, DirectAdmin and SFTP as one feature, 2026-11-07; LiteSpeed, 2026-11-10) and gave the
go-ahead on 2026-11-12; the design is the lead's, settled by two spikes on the founder's cPanel
account (027 research R10, R11) and a cross-artefact review.

## Context

A shared hosting account has a control panel, no root, no Docker and often no SSH from outside:
the test account's SSH port is filtered, and its PHP runs inside CageFS. The spikes found that:
- a cPanel API token can't be limited to features or addresses, so it is the whole account, every
  site and mailbox on it included;
- the panel's API has no atomic switch: it makes a symbolic link only by unpacking a tar, which
  removes the old link before making the new one;
- LiteSpeed's PHP processes keep serving the old release after a switch until they restart, which
  the account's user can trigger;
- the account reaches GitHub over HTTPS and SSH, runs long cron jobs, and has `git`, `openssl`,
  `flock` and `ssh-keygen`;
- a hostname can get a newer PHP than the account's only with that version's default extensions.

The roadmap's sketch was GitHub Actions uploading each release with the panel's token or an SFTP
key as a deploy secret. On such an account that means a credential to the whole account in CI,
and a switch that isn't atomic.

## Decision

- **D1. A target kind of its own,** `hosting`, with the panel (`cpanel`, `plesk`, `directadmin`,
  `sftp`) in the plan and the hostname in `dns.domain`. Nothing is created, priced or hardened as a
  server; `onServer` stays a positive list. The panel's address and user stay in
  `.opscrew/hosting.json`; the token is read from the environment on the user's computer and goes
  nowhere else.
- **D2. One contract for the panels,** `HostingPanel` in `@opscrew/contracts`: facts, hostnames,
  databases, cron, files, certificates, a hostname's PHP version. What a panel's API can't do is a
  step the user takes in the panel, with its exact text in the plan.
- **D3. Changes to the account are hosting plans,** fixed step kinds approved by the plan's SHA-256
  hash with the new kind `hosting-apply`, applied by the panel's connector, which refuses any other
  plan (ADR 0011's pattern). Provision has two: plan A installs the agent and its cron line; the
  agent's first report (PHP versions and extensions, tools, GitHub reachable, its key) builds plan
  B, the app's part. So every approved plan shows exactly what its apply does. Every object made is
  recorded, and only those are ever changed or removed.
- **D4. Panel accounts deploy by pull.** The agent is a bash script, the same for every app,
  committed in `opscrew/hosting/` with each environment's settings, and run by cron every minute as
  the account's user. GitHub Actions builds each release and force-pushes it as an orphan commit
  to `opscrew/release/<env>`, signed with ECDSA P-256 by a key that is an environment secret of the
  deploy environment. The agent fetches the branch with a read-only deploy key it generated itself,
  verifies the signature with the public key, refuses a run older than the last one it attempted,
  prepares the release, switches `current` with one rename, restarts the account's PHP processes,
  checks the app over HTTPS, and switches back on a failure.
- **D5. Requests carry what the user starts from the computer:** a rollback, a settings change, a
  snapshot, a restore. The CLI writes a one-time key=value request through the panel's API after
  the approval, named by the SHA-256 of its bytes, naming the approved hash, valid 30 minutes; the
  agent carries it out once and answers in a result file. Only the holder of the panel's token can
  write a request; CI never can.
- **D6. SFTP-only hosts are pushed to.** With no cron and no API, GitHub Actions uploads each
  release and switches it over SFTP (`symlink`, then OpenSSH's atomic `posix-rename`) with a key
  restricted where the host allows it, kept as a deploy secret; the CLI rolls back, reads the
  status and removes over SFTP. Static sites and plain PHP apps only.
- **D7. The app's secrets stay on the account.** The app's values and the database password go from
  the user's computer to 0600 files outside every web root; GitHub never gets them. Nothing on the
  account can sign a release, and no secret passes on a command line there.
- **D8. OpsCrew never changes the account's PHP version,** which every site on the account shares.
  A hostname gets its own version through cPanel's MultiPHP where the account has it, or through
  CloudLinux's handler line on LiteSpeed where that version's default extensions cover the app.
  Otherwise provision stops and names the ways out.
- **D9. The document root is a release's folder under `~/opscrew/`,** outside `public_html` where
  the account allows it; otherwise a link in `public_html`, with every other hostname refused.

## Consequences

- GitHub holds no credential to a panel account. Whoever can run the deploy environment's workflow
  can still deploy code there, as on servers; a pull request can push the release branch but can't
  sign where GitHub limits environments to the deploy branch. Where it can't (Free, private), the
  plan says so.
- A release goes live within about a minute of its build; the workflow waits for the account's
  `X-OpsCrew-Release` header to report it. A re-run of an old workflow run is refused.
- The repository gains one branch per hosting environment holding the built release.
- On LiteSpeed, each switch restarts every PHP process of the account for a moment, other sites'
  included. On Apache, a switch reaches every PHP process within `realpath_cache_ttl` (120 s by
  default).
- An app needing more PHP extensions than a newer version's defaults runs only on the account's own
  version, which the user changes in the panel for every site, or not at all.
- Deleting OpsCrew leaves the agent and its cron line, readable, which the user can keep or remove
  in the panel.

## Alternatives considered

- **The panel's token as a deploy secret:** it reaches every site and mailbox of the account and
  can't be limited (R10).
- **An FTP or Web Disk account limited to the app's folder for uploads:** narrower, but the switch
  still needs code on the account, and the signature check is what bounds a deploy anyway.
- **A shared HMAC key:** the account would hold a key that can sign, and `openssl` would take it on
  a command line other customers can read where there is no CageFS.
- **A one-time PHP file that switches over HTTPS:** a deploy endpoint in the web root, bound by
  PHP's request time limits.
- **`SubDomain::changedocroot` per release:** cPanel only, not atomic for requests in flight, and it
  needs the token at every deploy.
