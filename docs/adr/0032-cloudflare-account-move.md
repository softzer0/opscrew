# ADR 0032: Moving an app to another Cloudflare account: shadow states, marks in the new zone

**Status**: Proposed (DRAFT, 2026-11-14, feature 028). The founder asked for the move and set its
scope on 2026-11-14: it ships as 0.2.9; a zone serving several apps moves with all of them; R2
buckets are copied; a site on Cloudflare's hosting runs in the new account before the switch;
deploys through Cloudflare Access keep working during the move; the live pass is the real move of
opscrew.dev. The design is the lead's, to be settled by spike S1 on the two accounts (028 research
R10) and the plan's review.

## Context

Cloudflare moves nothing between accounts (028 research R1): the domain is added to the new account
as a new zone, its records and settings copied, the account's own pieces (Tunnels, Access, Workers,
R2 buckets) made again there, and the nameservers switched at the registrar. Until the switch the
new zone is pending and the old one serves; after it the old zone is "Moved" and deleted 7 days
later. Universal SSL is issued only once a zone is active, so a free zone has an HTTPS gap after the
switch, and a Worker's custom domains can only be attached to an active zone.

OpsCrew ties an app to its account in several places (R6):
- each root's committed `terraform.tfvars.json` (`cloudflare_zone_id`, `cloudflare_account_id`) and
  its state;
- `.opscrew/cloudflare.json` (the app's hostnames in OpsCrew's shared rules, its certificates);
- deploy secrets and server files (tunnel tokens, Access service tokens, the origin certificate, a
  Worker's account and token, R2 keys).

A server OpsCrew created shares one root and one state with the app's records. Every Cloudflare
resource is reached with one token, `CLOUDFLARE_API_TOKEN`. Several OpsCrew apps can share a zone,
each from its own repository, with nothing shared between the repositories but Cloudflare.

## Decision

- **D1. A command group of its own,** `opscrew cloudflare move`, in four steps the user runs: prepare
  (`--to <account>`, in each app's repository), `--switch` (once, from any of them), `--finish` (in
  each), and `--abort` (only before the switch changed anything). Each plan is approved by its hash,
  `--approve <hash>` in a script. The MCP server only shows where a move stands.
- **D2. Two tokens.** `CLOUDFLARE_API_TOKEN` stays the current account's (A) and
  `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` is the new one's (B) during the move; every zone lookup names its
  account. After every app in the zone is finished, the user sets `CLOUDFLARE_API_TOKEN` to B's token.
- **D3. B's pieces in shadow states.** For each root that holds Cloudflare resources, B's pieces are
  planned with the same committed root module, B's ids as `-var`s, B's token, and a state file and
  data folder of their own under `.opscrew/…/cloudflare-move/`, with a plan suffix no other command
  applies. A root that also holds a server starts from a copy of its state with every Cloudflare
  address removed, so B's plan creates only B's pieces; the plan check refuses anything else. A's
  state and committed files don't change before the finish.
- **D4. The finish swaps states.** Each shadow state becomes the environment's state; only the id
  keys of the committed `tfvars` change; a check plan allows no change or in-place updates of
  Cloudflare resources. From the former state, the zone-scoped resources (records, certificate packs)
  are dropped, since A's moved zone goes with them, and the account-scoped ones (tunnels, Access,
  Workers, R2) are destroyed with A's token after `allowDestroy` and the app's name typed. A's Origin
  CA certificate is revoked.
- **D5. A mark per prepared app, in B's zone.** The app's last prepare step writes a TXT record
  `_opscrew-move.<app>-<hash>` in B's pending zone listing its environments and hostnames (and a
  site's Worker and custom domains). The switch refuses until every OpsCrew name in A's zone (its
  records, its shared rules' hostnames, its Workers custom domains) is in some mark. Each app's
  finish or abort deletes its own mark, so a rerun of the switch still finds them all.
- **D6. Records:** A's records that are no OpsCrew app's are copied into B's zone create-only,
  compared by type, name and normalised content as `domain connect` compares; differences and
  records only in B are listed, never changed. Each app's own records are made by its shadow roots.
- **D7. Origin TLS crosses the switch unchanged on the origin.** The app's own client certificate is
  uploaded to B's zone with per-hostname Authenticated Origin Pulls, so the origin's trust pool
  serves both edges. A new Origin CA certificate is issued under B at prepare and placed on the
  origin at the finish. Until the spike shows that B's zone accepts the certificate A issued, the
  switch says that origin-protected apps may answer 526 until their finish, and lists those
  finishes first.
- **D8. Tunnels run side by side.** A server, or the user's Portainer, runs B's connector beside A's
  through a host or stack plan; at the finish the main connector takes B's token and the beside one
  goes, so B's tunnel never pauses.
- **D9. Deploys work on both sides of the switch.** Prepare adds B's credentials to GitHub beside A's,
  as the same deploy secrets with `_NEW` appended: the Access deploy service token, Portainer's
  webhook Access client, a Worker's account id and deploy token. The workflow tries A's Access
  credentials and, when Access refuses them, B's; a Workers site's deploy deploys to both accounts.
  The finish moves B's values into the plain names and deletes the `_NEW` ones.
- **D10. A Workers site runs in B before the switch.** Prepare makes B's Worker without custom
  domains and deploys its code there. Right after activation the switch, from whichever repository
  runs it, attaches every prepared site's custom domains with B's token, from the marks; the site's
  finish imports them into its state.
- **D11. R2 is copied, then switched at the finish.** B's buckets keep their names. The first copy runs
  at prepare with rclone in the pinned container on the app's server (or through Portainer's Docker
  API), the keys on standard input or written through the archive API. The finish's maintenance
  window pauses deploys, stops the app, syncs, points the app at B and deploys. A's buckets are
  emptied only after `rclone check` proves B holds every object, after their names are typed.
- **D12. Refused:** previews (turned off for the move and on again after it; adding them during a move
  is refused), a retarget during a move and a move during a retarget, `destroy`, `drift`,
  `provision` and `rotate` while a move runs (snapshot, rollback, advise and design stay allowed),
  and an abort once the switch changed the nameservers or the DS record, judged from the delegation
  and the registry so any repository can tell; moving back is a move from B to A.

## Consequences

- **The HTTPS gap:** from the nameserver change until B's zone is active and its Universal SSL
  certificate issued (minutes, at worst 24 hours), HTTPS visitors may get certificate errors; on an
  HSTS-preloaded name it is an outage. The switch says so before its approval, measures it and
  reports it. A site on Cloudflare's hosting answers once its custom domains are attached and
  certified, minutes after activation.
- **During the move** a cloud server's resources are in two states (the environment's and the
  shadow); every command that could change them is refused until the finish or an abort.
- **The deploy workflows** of tunnel, Portainer webhook and Workers targets gain the `_NEW` paths,
  inert without `_NEW` secrets; an app's files from an older OpsCrew are brought up to date with
  `opscrew provision` before a move.
- **A shadow state isn't in the recovery copy:** an app's prepare, finish and abort run from one
  computer; the switch needs no state.
- **OpsCrew empties R2 buckets** for the first time, only after a verified copy and typed names.
- **A's moved zone keeps its records, rules and AOP settings** until Cloudflare deletes it.
- **After the finish,** a token that still sees A's moved zone can't act on it: zone lookups prefer
  active zones, and provision refuses a moved one.
- **The move covers what OpsCrew made and the zone's DNS records.** The zone's plan, the user's own
  rules and settings, Email Routing and pieces OpsCrew didn't make are listed in the guide for the
  user to redo in B.
- **No new dependency, image or approval kind;** the contract change is `PHASES` gaining
  `cloudflare-move`.

## Alternatives considered

- **B's pieces in the app's own root, behind a second provider alias:** the second token would be a
  variable, kept in every saved plan file.
- **Separate roots for B:** a second renderer, and at the finish a move of resources between state
  files that the `IacEngine` contract lacks; importing them instead loses the write-only secrets of an
  Access service token and a tunnel.
- **A shared store for the prepared apps** (a file, a service): the founder's scope keeps everything in
  Cloudflare and the repositories.
- **Pausing deploys from the switch to each finish:** the founder chose to avoid the pause.
- **Each site's finish attaching its own custom domains:** its gap would last until that repository's
  finish ran.
- **Updating differing records in B's zone:** B's record may be the one the user wants; listing them
  is safer than overwriting.
- **Re-issuing nothing for origin TLS:** A's Origin CA certificate isn't listed in B's zone, so status,
  rotation and the deeper checks couldn't find it, and it would outlive A's account.
- **Records DNS-only until B's certificate is live:** the origin's certificate is an Origin CA one and
  it asks for Cloudflare's client certificate, so visitors couldn't reach it directly; a tunnel or a
  Worker has no public origin at all.
- **The R2 window at prepare:** an abort would then have to copy back what the app wrote to B.
