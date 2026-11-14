# Implementation Plan: Moving an app to another Cloudflare account

**Branch**: `main` | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)
**Status**: Accepted by the lead on 2026-11-14, after a review and the founder's decisions that day; O1, O2 and O9 wait on the spike (T2802) and the founder

## Summary

A command group of its own, `opscrew cloudflare move`, moves one app (every environment of it whose
domain is in the zone) from the account that holds its zone (A) to another account (B), in four
steps the user runs:

1. **Prepare** (`--to <account>`), from the app's repository, while A keeps serving:
   - B's zone is added (pending) and A's records that are no OpsCrew app's are copied into it.
   - Each environment's pieces are planned in B and applied after their approvals. They live in
     **shadow states**: the same committed root modules, planned with B's zone and account ids as
     `-var`s, B's token, and a data folder and state file of their own under
     `.opscrew/…/cloudflare-move/`. A's state and A's files don't change.
   - A tunnel's server (or Portainer) runs B's connector beside A's.
   - A Workers site's Worker is deployed in B, with its code.
   - GitHub gets B's Access credentials as extra secrets, so deploys keep working on either side of
     the switch.
   - R2 buckets are made in B and copied once.
   - The last step writes the app's **prepared mark**, a TXT record in B's pending zone.
2. **Switch** (`--switch`), once, from any repository with a prepared app:
   - It refuses until every OpsCrew name in A's zone is in some mark.
   - It copies what A's other records gained since prepare and removes A's DS record when DNSSEC is
     on (then waits and is approved again).
   - It sets B's nameservers at the registrar, or prints what to do.
   - Once B is active, it attaches every prepared Workers site's custom domains in B, waits for the
     certificates, measures the HTTPS gap, and turns DNSSEC on in B.
3. **Finish** (`--finish`), in each repository: R2's last copy in a maintenance window; the secrets
   and server files that hold Cloudflare-issued values get B's; the main connector takes B's token;
   each shadow state becomes the environment's state and only the id keys of the committed `tfvars`
   change; A's account-scoped pieces are removed after `allowDestroy` and typed names; the app's
   mark goes.
4. **Abort** (`--abort`), only before the switch changed anything: B's pieces of the app (and B's
   zone when no other app is prepared in it) are removed after typed names; A was never changed.

Retarget's patterns are reused (saved plans approved by hash, `--approve`, `planBounded`, the
pending-plan file, the deploy pause, the rclone container), not its step machine: a retarget keeps
both sides in one state behind one provider, and a Cloudflare move needs two tokens, which one root
can't hold without writing a token into a variable and so into every saved plan file.

## Technical Context

- TypeScript strict ESM, Vitest, zod, Biome. No new runtime dependency and no new pinned image
  (rclone is pinned since 023).
- Engines: OpenTofu and Terraform, only through `IacEngine`: shadow roots use `init` with
  `backendConfig.path`, `plan` with `vars`, `apply`, `output`, `stateResources`, `stateRemove` and
  `importResource`, with `TF_DATA_DIR` in the run's `env`. Copying a state file is a file copy.
- Cloudflare: two `CloudflareClient`s per run, A's from `CLOUDFLARE_API_TOKEN`, B's from
  `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` (both registered with the redactor). Every zone lookup names
  its account (`findZone(name, { accountId })`), since one token may see both.
- Registrars: `domain connect`'s nameserver switch and DS handling through
  `@opscrew/connector-{porkbun,namecheap,godaddy}`; Cloudflare Registrar by its dashboard move.
- Builds on: ADR 0011 (host plans), 0012 (stack plans), 0014 (shared Cloudflare resources), 0017
  (origin TLS: per-hostname AOP with the app's own client certificate), 0023 (deploy pause), 0027
  (retarget's sides and rclone); features 007, 013, 015, 016, 025.
- Tests: a two-account Cloudflare fake (`@opscrew/connector-cloudflare/testing`), the registrars',
  GitHub's, the engine's, servers' and Portainer's fakes; one Docker-gated compose test
  (`OPSCREW_DOCKER_TESTS=1`); a spike before wave 3 (T2802); the real move of opscrew.dev as the
  live pass (T2826, T2827).

## Constitution Check

- **I (gate):** every change is a plan, checked, shown and approved before it is applied; every
  approval and provider call goes to the audit log under the new phase `cloudflare-move`:

  | Change | Adapter | Approval |
  |---|---|---|
  | B's zone, A's other records copied, the mark | Cloudflare shared-resources adapter (a zone and its user records are what every app in it shares), planned in agents | `cloudflare-apply`, by hash; the apply re-reads both zones and refuses a changed plan |
  | B's rules, Zero Trust pieces, origin TLS | the same adapter, the app's shared plan | `cloudflare-apply`, by hash |
  | B's IaC pieces | IaC engine, shadow plans | `iac-apply`, by hash; `planBounded`: only creates of Cloudflare addresses |
  | B's connector beside A's | host adapter / Portainer connector | `host-apply` / `stack-apply`, by hash |
  | B's Access credentials and Worker deploy token as extra secrets | GitHub connector | `github-secrets` |
  | R2 first copies | rclone in the pinned container | `remote-exec` listing each bucket |
  | The switch: records copied now, DS removal, nameservers, Workers custom domains, DNSSEC on in B | registrar connector, Cloudflare adapter | `domain-settings` bound to the switch plan's hash (which includes the zone copy's hash), domain typed; after a DS wait, planned and approved again |
  | The finish's window | rclone, SSH or Portainer | `remote-exec`, its length shown, `--allow-downtime` in a script |
  | The finish's secrets and deploy | GitHub connector | `github-secrets` |
  | The state swap's check plan | IaC engine | none when it shows no change; `planBounded` allows only in-place updates of Cloudflare addresses, approved by hash |
  | A's account-scoped pieces | IaC engine, A-removal states | `iac-apply`, `allowDestroy`, the app's name typed |
  | A's Origin CA certificate revoked | Cloudflare adapter | `cloudflare-apply`, `allowDestroy`, the app's name typed |
  | Emptying a bucket (A's at the finish, B's at an abort) | rclone | `remote-exec`, `allowDestroy`, the bucket's name typed |
  | B's zone deleted (abort) | Cloudflare adapter | `cloudflare-apply`, `allowDestroy`, the zone's name typed |

  No standing approval; no `--yes` for any apply. Constitution 1.10.0 already names the Cloudflare
  shared-resources adapter, so no amendment is needed.
- **II (ownership):** B's pieces are described by the app's committed root modules; the finish
  changes only the id keys of the committed `terraform.tfvars.json`. The move's record is in
  `opscrew/plan.yaml`. Deleting OpsCrew mid-move leaves both accounts' pieces readable in the
  dashboard, and the guide says what each is.
- **III (dual engine):** `TF_DATA_DIR`, `-var`, `-backend-config=path=`, `state rm` and `import`
  behave the same in both engines; the shadow plans run the HCL every root already validates.
- **IV (secrets):** both tokens come from the environment and are registered with the redactor. The
  shadow plans' `-var`s carry ids only. B's tunnel tokens and Access service tokens go from the
  shadow outputs to the host adapter's standard input, a stack's values or an encrypted GitHub
  secret, never to a repository file. R2 keys reach rclone on standard input over SSH, or through
  the Docker archive API in Portainer (023's `.pgpass` path), never in a container's `Env` or `Cmd`.
  B's origin key stays in `generated_values.json` (0600, outside the repository). A mark holds the
  app's name, its environments' names, its hostnames and a site's Worker name: no secret, no
  repository, no id. Every agents task has a leak test; the live pass scans every output, commit,
  plan, audit entry and state file.
- **V (deterministic):** no model is involved; the MCP server only reads.
- **VI (contracts):** one contract change, `PHASES` gains `cloudflare-move`
  (`packages/contracts/src/runtime.ts`), with ADR 0032. `IacEngine` is unchanged.
- **VII (tests):** test-first with fakes; engine-facing code also against the real engines in
  `.tools/bin` where a test needs `init` (skipping with a message without them).
- **VIII (adapters):** every mutation through the Cloudflare connector, the IaC engine, the host
  adapter, the Portainer connector, the registrar connectors or the GitHub connector.
- **IX (plain language):** the summary before the first change lists the apps found in the zone,
  every environment and piece to create in B, the buckets with their sizes, the finish's window,
  and the HTTPS gap. The switch's approval repeats the gap and what it means for each kind of app.
- **X (simplicity):** no new dependency or image; no second renderer for B; previews refused.

## Design

### 1. Commands and options (T2824)

```
opscrew cloudflare move --to <account id or exact name> [--app <key>]   # prepare (or continue it)
opscrew cloudflare move --switch                                         # from any prepared repo
opscrew cloudflare move --finish  [--app <key>]
opscrew cloudflare move --abort   [--app <key>]
  --approve <hash>    apply the saved plan this step waits for (scripts)
  --confirm <name>    a typed name in a script; repeatable (the app, each bucket, the domain, the zone)
  --allow-downtime    the finish's R2 window in a script
  --engine tofu|terraform
```

- `--env` is refused plainly: the move covers every environment of the app whose zone is the zone
  (`dns.zone`, else the zone `findZone` finds for `dns.domain` with A's token); an environment in
  another zone stays as it is.
- Without `--to`, a recorded move continues; a different `--to` is refused.
- No MCP tool: `opscrew_status` shows the move and the server's terminal-only list names the
  commands; the plugin's deploy skill guides them.

### 2. The record and resumability (T2803, T2812)

- **Committed:** each covered environment's `opscrew/plan.yaml` gets `cloudflareMove` (data model
  1): the zone, A's and B's account and zone ids, `dsAtStart` (whether the registry published a DS
  record when the move started), `step` (`started`, `prepared`, `adopted`), `abort`, times. Every
  guard and `status` read it, on any computer.
- **Local, only three things** (data model 2): the plan waiting for `--approve`, the finish's
  `window.stoppedAt`, and the switch's times.
- **Every sub-step checks before it acts** and is idempotent: a plan with no changes is skipped, a
  host or stack plan that is up to date is skipped, rclone `copy` copies only what is missing, an
  existing secret or mark with the same value is kept. A run after any interruption plans each
  sub-step again and finds what is done.
- **Interrupted:**
  - *prepare:* the engine's state holds what an interrupted apply made; the next plan shows the rest.
  - *switch:* it reads the delegation (registrar API, else DNS over HTTPS), the DS records, B's zone
    status and the certificate packs before acting; the times come from the switch file, else
    "measured from this run".
  - *finish:* a run that finds `window.stoppedAt` starts the app again on A's settings first. The
    state swap is two renames per root and a run finds where it stopped from the files present.
  - *abort:* destroy plans repeated until the shadow states are empty.

### 3. Shadow states (T2813)

For each root of a covered environment that holds Cloudflare resources: the main root
(`plan.infra.dir`: a server's, an own server's, Portainer's, a site's or a hosting account's DNS
root), `storage` and `backups` when they are R2, and `github-pages-verification`.

- **Where:** `<environment stateDir>/cloudflare-move/`: `tfstate/<name>.tfstate`, `tf/<root folder>/`
  (`TF_DATA_DIR`), and at the finish `a-removal/` (data model 3).
- **Addresses** (`cloudflareAddressScope`, T2807): every resource under one of OpsCrew's Cloudflare
  module calls (`dns`, `tunnel`, `access`, `portainer_tunnel`, `worker`) or a top-level `cloudflare_*`
  resource is Cloudflare's, and is **zone-scoped** (`cloudflare_dns_record`,
  `cloudflare_certificate_pack`) or **account-scoped** (the rest: tunnels and their configuration,
  Access applications, policies and service tokens, Workers scripts, their subdomain and custom
  domains, R2 buckets and their settings).
- **Seeding:** the environment's state is copied and every Cloudflare address removed from the copy
  (`stateRemove` against the shadow backend). A Cloudflare-only root ends up empty; a cloud server's
  main root keeps its server, network and firewall resources, so B's plan sees them as they are and
  plans only B's pieces.
- **Planning:** `planAndApply` in the committed root folder with `statePath` the shadow state, `env`
  holding B's token as `CLOUDFLARE_API_TOKEN` and the shadow `TF_DATA_DIR`, and `vars` = the root's
  id variables for B (`accountVariables`: `cloudflare_zone_id`, `cloudflare_account_id`,
  `one_time_pin_identity_provider_id`, those the root declares; T2807 proves nothing else differs
  between two accounts' renderings). A Workers site's root adds `custom_domains = false` (T2808 makes
  it a root variable). Address variables (`TF_VAR_server_ipv4`…) are set as today. The run uses
  planAndApply's move options (T2811): its own plan suffix `-move.tfplan` (which every other
  command refuses to apply), no firewall or provider-backup follow-ups, `costDelta: null`, and
  hints naming `OPSCREW_NEW_CLOUDFLARE_API_TOKEN`. `planBounded` allows only creates of Cloudflare
  addresses; anything else stops before the approval with the plan's lines.
- **Outputs** (B's tunnel token, B's deploy service token, the webhook's Access client) with
  `readOutputsAfterInit` against the shadow backend.
- **The swap (finish):** per root, the environment's state moves to `a-removal/tfstate/` and the
  shadow state takes its place; the id keys of the root's committed `terraform.tfvars.json` are
  patched to B's (nothing re-rendered); a check plan (B's token, the environment's own data folder)
  goes through `planBounded`: no change, or in-place updates of Cloudflare addresses only, shown
  and approved.
- **A's removal:** from each A-removal state every non-Cloudflare and every zone-scoped address is
  removed; a destroy plan with A's token, A's ids as `vars` and its own data folder deletes A's
  account-scoped pieces only. A's zone-scoped pieces go with A's moved zone, which Cloudflare deletes.
- **Abort:** the copied non-Cloudflare addresses are removed from the shadow state, then a destroy
  plan with B's token deletes everything B has of the app (records included, since B's zone may
  stay for other apps).

### 4. Prepare, by step (T2820)

1. **Checks before any change** (T2810):
   - `CLOUDFLARE_API_TOKEN` reaches A, which holds the zone, active, without a zone hold;
     `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` reaches B (`--to` resolved like `resolveAccount`), B is not A;
     B's account-level permissions for the app's pieces, probed with read-only calls, each missing
     one named.
   - No retarget, no other move, no preview environment in the app.
   - The committed files support the move: a Workers site's root has the `custom_domains` variable
     and its deploy workflow the `_NEW` deploy step; a workflow that deploys through Access has the
     `_NEW` fallback (T2808). Otherwise: "Run `opscrew provision` to bring the app's files up to
     date and commit them, then start the move. Nothing was changed."
   - The covered environments and those staying; the other OpsCrew apps in A's zone, by hostname.
2. **The summary and `confirmStart`:** B's zone, each environment's pieces in B, the connector
   beside A's, the extra secrets, each bucket's size, objects and minutes (`rclone size` on the
   app's server), the finish's window, the switch's gap, and that every other app in the zone needs
   its own prepare. Refused: nothing changed. Then `plan.cloudflareMove` is written (`started`,
   with `dsAtStart` from the public DS lookup).
3. **The zone plan** (T2817): B's zone created when missing; stop when its nameservers equal A's
   (hint: `--abort`, then start again); B's zone-level permissions checked right away, each missing
   one named before anything else changes; A's records that are no OpsCrew app's copied
   **create-only** (5.2). A later prepare of another app copies only what is missing.
4. **Per environment** (`environmentsOf`):
   1. **B's shared plan** (T2814): this environment's hostnames in OpsCrew's rules in B's zone, the
      Zero Trust organization and one-time PIN login in B when its Access needs them, and origin TLS:
      the **same client certificate** uploaded to B with per-hostname AOP (the origin's `pull.pem`
      trusts that certificate, so it serves both edges unchanged) and a **new Origin CA certificate
      under B** kept as `originTlsNext`, not yet placed. On a pending zone the apply doesn't wait for
      `active`.
   2. **Shadow roots** (3.): main, `storage`, `backups`, the verification root.
   3. **The connector beside** (T2815), when the environment has a tunnel.
   4. **The extra secrets** (T2818, 10.): B's Access deploy credentials, and for a Workers site B's
      account id and deploy token (from `OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN`); for a site, the deploy
      workflow dispatched and awaited, so B's Worker runs the current code.
   5. **The first R2 copies** (T2816), after B's bucket keys are known
      (`OPSCREW_NEW_STORAGE_ACCESS_KEY_ID`/`_SECRET`, `OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID`/`_SECRET`,
      else asked once in a terminal and kept).
   6. The environment's record goes to `prepared`.
5. **The mark** (T2817), once every covered environment is `prepared` (data model 4).
6. The output names the other apps still to prepare (by hostname) and the switch command.

### 5. The switch (T2819)

1. **Refused** unless this repository has a prepared app. **Coverage** (T2817): the names of A's
   records with the OpsCrew comment, the hostnames in OpsCrew's rules in A's zone and A's Workers
   custom domains in the zone, each in some mark; otherwise it stops listing the names not covered:
   run `opscrew cloudflare move --to <B>` in the repository that deploys them, or remove those
   records from A if no app uses them.
2. **The zone copy, create-only** (T2817, on T2809's exports): A's records that are no OpsCrew app's
   (not the OpsCrew comment, not Cloudflare-managed per the records' `meta`, not the apex NS)
   compared with B's by type, name and normalised content, `domain connect`'s comparison
   (`connect-plan.ts`). Missing ones are created with their proxied state, comment, TTL and data.
   Same type and name with other content: listed ("A has …, B has …; B's is served after the
   switch"), never updated. Records only in B: listed, never deleted. Addresses of the app's servers
   are masked in what is shown.
3. **The registrar** (T2809's `findDomainRegistrar`): a configured Porkbun, Namecheap or GoDaddy
   account that owns the domain; else Cloudflare Registrar in A; else another registrar.
4. **DNSSEC** when the registry publishes a DS record: the first approved plan removes it at the
   registrar (or, at Cloudflare Registrar, prints "turn DNSSEC off in A's dashboard"), records the
   time to come back (`domain connect`'s `dsWaitSeconds` and margin, 24 to 48 hours) and stops. The
   run after the wait plans everything again and asks a new approval. A DS record the API can't
   remove stops before any change with the registrar's dashboard link.
5. **The switch plan** (canonical JSON, its SHA-256 the approval's hash): A's and B's zones, the
   nameservers before and after, the registrar, the DS removal, the zone copy plan's hash, the marks
   (apps and hostnames), each site's custom domains to attach, and DNSSEC to turn on in B. The
   approval (`domain-settings`, the domain typed) says:
   - from the nameserver change until B's zone is active and its Universal SSL certificate issued
     (minutes, at worst 24 hours), HTTPS visitors may get certificate errors;
   - a site on Cloudflare's hosting answers once its custom domains are attached, right after
     activation;
   - until T2802 shows that an Origin CA certificate from A is accepted by B's zone: an app with
     origin protection may answer 526 from activation until its finish, so each finish should run
     right away (its output lists them first).
6. **The change:** `pointToZone` with B's zone at Porkbun, Namecheap or GoDaddy; at Cloudflare
   Registrar, the dashboard steps of its move between accounts (started in A, accepted in B within
   five days); at another registrar, B's nameservers to set. Either way the run waits, and a later
   run finds the delegation and goes on.
7. **Activation and the gap** (6.).
8. **Right after activation:** every prepared site's custom domains attached in B with B's token
   (`attachWorkerDomain`, from the marks: hostnames and B's Worker name); DNSSEC turned on in B and
   its DS published (`publishDs`) when `dsAtStart`; the output: the measured times, then per mark the
   finish to run, origin-protected apps first. **The marks stay** (each app's finish deletes its own),
   so a rerun from any repository still finds them.

### 6. Measuring the HTTPS gap (T2819)

The switch file records `nameserversSetAt` when the registrar accepts the change. The hostnames
probed are the marks' names that have an address or CNAME record in B (not the `_`-named TXT names),
plus the sites' custom domains once attached. Every 30 seconds until each answers, or the limit (two
hours, then it stops and the next run continues with the same times):
- B's zone status; while pending, `activationCheck` when Cloudflare allows it (hourly on free
  plans). `activeAt` when first seen active; the custom domains are attached then.
- B's certificate packs: `certificateAt` when the universal pack is `active`.
- An HTTPS request to each hostname from this computer (`fetch`, certificate checked, 10 s timeout):
  it counts once the TLS handshake succeeds and the answer is not a 52x. `okAt[host]`.

Behind Cloudflare's proxy the edge serves a hostname from its active zone, whichever nameservers a
resolver asked, so after activation this computer's requests reach B's edge. Reported: nameservers
→ active; active → certificate; each hostname's time from the nameserver change to its first good
answer.

### 7. The finish, by step (T2822, T2823)

Refused unless every covered environment is `prepared` and B's zone is active. Per environment
(T2823 orders it; T2822 supplies the A-side and site steps):
1. **Secrets and files pointing at A, in one approval and one deploy:** one `github-secrets`
   approval lists the names (never values) it changes: the plain Access deploy credentials take B's
   (the `_NEW` ones are deleted), `OPSCREW_ORIGIN_TLS` takes B's origin certificate with the same
   client certificate, `OPSCREW_OFFSITE_ENV` takes B's backups bucket and, with an app bucket, the
   app's settings take B's endpoint (`r2Endpoint(B)`) and key. Then one deploy, dispatched and
   awaited: it writes the app's settings, `offsite.env` and the origin's files and (re)starts the
   app. On Portainer, one stack plan with B's values instead.
2. **The R2 window** (T2816), only with an app bucket, wraps step 1: its approval with its length;
   deploys paused and running ones awaited; the app, workers and cron stopped (`docker compose stop`
   over SSH; on Portainer through the Docker proxy); `window.stoppedAt`; `rclone sync` A → B;
   step 1; on any failure before the deploy succeeds, the secrets go back to A's and the app starts
   again on A. Without an app bucket, step 1 runs as it is.
3. **The snapshots' copies:** after step 1's deploy, a last `rclone copy` A → B of the backups bucket.
4. **The connector:** the main connector restarts with B's tunnel token (rotate's
   `serverTunnelConnectors(…).restart` / `portainerTunnelConnectors(…).restart`), then the beside
   connector goes. B's tunnel never pauses.
5. **A Workers site** (T2822): the custom domains the switch attached are imported into the site's
   shadow state (`importResource` at `module.worker.cloudflare_workers_custom_domain.domain[0]` and
   `.www[0]`), the check plan runs with `custom_domains = true`, the plain deploy secrets take B's
   account id and token and the `_NEW` ones are deleted.
6. **The state swap** (3.): states swapped, id keys patched, the check plan; `.opscrew/cloudflare.json`
   replaced by B's record; `originTls` ← `originTlsNext`; B's storage keys become the kept keys.
   `cloudflareMove.step` = `adopted`: no abort from here.
7. **A's removal** (T2822): A's tunnel waited on until it has no connection; the A-removal destroy
   plans (account-scoped only; `allowDestroy`, the app's name typed); each A bucket: `rclone check
   --one-way` A → B with checksums, emptied after its name is typed (`remote-exec`, `allowDestroy`),
   then deleted by its root's destroy plan; A's Origin CA certificate revoked. A's zone, with its
   records, rules and AOP settings, is left to Cloudflare (it shows "Moved" and is deleted 7 days
   later); A's Zero Trust organization and one-time PIN login stay.
8. **The end:** the app's mark deleted from B's zone (a `cloudflare-apply` zone plan); `cloudflareMove`
   removed from every covered plan; the local files deleted; the output says to set
   `CLOUDFLARE_API_TOKEN` to B's token (and the other `OPSCREW_NEW_*` values to their plain names)
   once every app in the zone is finished.

### 8. Abort (T2821)

- **Refused once the switch changed anything,** judged from what any repository can read: the
  delegation (registrar API, else DNS over HTTPS) no longer names A's nameservers, or `dsAtStart`
  was true and the registry no longer publishes a DS record; or B's zone is active, or an
  environment is `adopted`. The message: the switch has begun, so the move goes on (`--switch`, then
  `--finish`); moving back later is a move from B to A. OpsCrew never publishes a removed DS record
  again.
- **Otherwise, in order:** the app's mark deleted (no switch can start); the extra `_NEW` secrets
  deleted; the beside connectors removed and B's tunnels waited on until they have no connection; B's
  buckets emptied (each name typed, `remote-exec`, `allowDestroy`) and their shadow roots destroyed;
  the other shadow roots destroyed (the app's name typed); B's shared pieces removed and
  `originTlsNext` forgotten; the shadow folders deleted; `cloudflareMove` removed. B's zone is deleted
  (`cloudflare-apply`, `allowDestroy`, the zone's name typed) only when it holds no other mark and no
  OpsCrew record; otherwise it stays and the output says why. A was never changed.

### 9. By target

| Target | At prepare, in B | Beside A's | Between the switch and the finish | At the finish |
|---|---|---|---|---|
| Cloud server (proxied) | records, rules, origin TLS (same client certificate, new Origin CA certificate), tunnel and Access for a Portainer or Beszel subdomain | the subdomains' connector (`cloudflared-next/`, as the deploy login) | serves through B; 526 possible until the finish (OPEN O2) | origin certificate deployed, connector token, swap, A's account pieces removed |
| Own server, public | as a cloud server, records to its address | none | as a cloud server | as a cloud server |
| Own server, tunnel | tunnel, Access with its deploy service token, the tunnel's CNAMEs, the probe rule | B's connector as root in `cloudflared-next/` | serves through B's tunnel; deploys use B's token after A's is refused | service token secrets, connector token, swap, A's tunnel and Access removed |
| Portainer | its root's tunnels, Access, records when OpsCrew manages them; origin TLS in Caddy mode | stacks `opscrew-<app>-tunnel-next` (on the app stack's network) and `opscrew-<app>-portainer-tunnel-next` | the webhook call uses B's Access client after A's is refused | stack values, next stacks torn down, webhook client secrets, swap |
| Workers site | the `www` rule, the Worker with its code (`custom_domains = false`), deploys to both accounts | none | answers from B once the switch attaches its custom domains | custom domains adopted, deploy secrets, swap, A's Worker removed |
| GitHub Pages | DNS-only records, the verification record | none | no gap: DNS only, GitHub's certificate | swap |
| Hosting account | its DNS-only record | none | no gap: DNS only, the panel's certificate | swap |
| R2 | same-named buckets (`storage`, `backups`), first copy | — | the app still uses A's buckets | window, last copy, A's emptied and deleted |
| Previews | refused before any change: turn previews off (`opscrew destroy --env <name>`, `opscrew env remove <name>`), and on again after the move; adding previews during a move is refused | | | |

### 10. Deploys during the move (T2808, T2818)

- **Through Access** (an own server in tunnel mode; Portainer's webhook in redeploy mode
  `cloudflare`): at prepare GitHub gets B's credentials beside A's, as the same deploy secrets with
  `_NEW` appended (`OPSCREW_TUNNEL_SERVICE_TOKEN_ID_NEW`, `…_SECRET_NEW`,
  `OPSCREW_PORTAINER_ACCESS_CLIENT_ID_NEW`, `…_SECRET_NEW`, with the app's and environment's prefix).
- **How the workflow decides:** by Access's answer, per connection. The SSH `ProxyCommand` runs
  `cloudflared access ssh` with A's token and, when that fails and the `_NEW` token is set, once more
  with B's. The webhook call is made with A's Access headers and, when Access refuses them (403, or a
  redirect to its login) and the `_NEW` client is set, once more with B's. Before the switch A's
  works; after it B's does. Without `_NEW` secrets the workflow behaves exactly as today.
- **A Workers site:** while `OPSCREW_CLOUDFLARE_API_TOKEN_NEW` is set, the deploy job deploys the same
  build to B's account too (a second deploy step with `OPSCREW_CLOUDFLARE_ACCOUNT_ID_NEW`), so B's
  Worker always runs what A's does.
- **The finish** moves B's values into the plain names and deletes the `_NEW` ones; an abort deletes
  them. The deploy pause is only used inside the R2 window.

### 11. Several apps, environments, other commands (T2812, T2824)

- **Several repositories in one zone:** each prepares itself; the marks in B's zone are all they
  share. The switch runs once, from any of them, with both tokens and the registrar's credentials.
  Each finishes itself and deletes its own mark.
- **Several apps in one repository:** each is its own move (`--app <key>`), with its own record,
  shadow states and mark.
- **Environments:** every environment of the app in the zone, each with its own shadow states and
  record; one mark per app lists all of them; an environment destroyed meanwhile is skipped and named.
- **During a move:**
  - A check of its own, `requireNoCloudflareMove`, is called by `requireNoMoveInProgress` (provision,
    dns, drift, addons, monitoring, portainer, domain buy and connect), by `destroy` and by
    `retarget`; design passes `allowCloudflareMove`. Snapshot, rollback, advise and design stay
    allowed; `moveInProgress`'s messages stay retarget's.
  - `rotate` refuses in agents' rotate entry points; adding a preview environment refuses.
  - `status` and `opscrew_status` show the step per environment always, and the apps prepared (read
    from B's marks) only when B's token is set.
  - Deploys go on (10.), except during the finish's window.
- **After the finish:** `setupCloudflare` refuses a zone whose status is `moved` ("set
  `CLOUDFLARE_API_TOKEN` to the new account's token"), and `findZone` prefers an active zone.

### 12. What is reused and what is new, by package

| Package | Reused | New |
|---|---|---|
| contracts | the `ApprovalKind`s | `PHASES` + `cloudflare-move` (lead) |
| plan-schema | `FqdnSchema`, `IsoDateTimeSchema` | `CloudflareMoveSchema`, refusals beside `retarget` |
| connector-cloudflare | `createZone`, `activationCheck`, DNSSEC calls, `listCertificatePacks`, `planShared`/`applyShared`, `batchCreateRecords` | zones by account and status, `getZone`, `deleteZone`, `zoneHold`, records with every field and `meta`, Workers custom domains by zone and their attach, permission probes, `applyShared({ waitForActive })`, the two-account fake in `./testing` |
| connector-ssh-host | `tunnelConnectorStep`, `planTunnelToken` | `planNextTunnelConnector`, `planNextTunnelConnectorRemoval` |
| iac-templates | `renderTunnelConnectorCompose`, `renderPortainerConnectorStack`, the workflows | `cloudflareAddressScope`, `accountVariables`, `opscrewRecordNames`, the beside connector's files, the `_NEW` fallbacks in the workflows, the Workers root's `custom_domains` variable |
| agents/domain | `pointToZone`, `requestActivation`, `publishDs`, `lookupPublishedDs`, connect-state's waits, connect-plan's comparison | exported for the move: `findDomainRegistrar`, `readDs`, `removeDsAndWait`, `domainZonesFrom`, `publicNameservers`, `recordsMissingFromZone` |
| agents/provision | `planAndApply`, `setupCloudflare`, `planSharedCloudflare`, `requireStorageKey`, `deployRenewedCertificate` | planAndApply's move options; `setupCloudflare` with an account and the `moved` refusal; the shared plan with a record path and client; `originTlsNext`; R2 keys kept by account |
| agents/retarget, rotate, move | `planBounded`, the pending-plan shape, the deploy pause, `serverTunnelConnectors`, `portainerTunnelConnectors` | `shared/rclone.ts` extracted from `retarget/bucket.ts` |
| agents/cloudflare-move | — | everything else |
| cli, mcp-server, plugin | typed names, `runPhaseCommand`, the status line | `commands/cloudflare.ts`, `ui/cloudflare-move.ts`, the status data, the skill's section |

### 13. Risks

- **Unverified Cloudflare behaviour** (research R1, R8), settled by the spike (T2802) before wave 3.
  The fallback for each "no":
  - `POST /zones` refused while A is active: the feature can't be built as specified; the lead takes
    it to the founder (Cloudflare documents this path, so it is unlikely).
  - The same nameserver pair: prepare stops; abort and start again.
  - A proxied CNAME to B's tunnel or an Access application refused on a pending zone: made at each
    app's finish instead, and that app is down from activation until its finish; the approval says so.
  - Per-hostname AOP not settable on a pending zone: OPEN O1.
  - An Origin CA certificate refused for a pending zone: issued at the finish instead.
  - A pending zone's nameservers answering with origin addresses: no change (the origin takes only
    Cloudflare's addresses and its client certificate); the guide says so.
  - R2 refusing a name that exists in the other account: B's buckets get a `-b` suffix and the
    finish's settings carry the new name.
- **The pending window:** resolvers that already ask B's nameservers before activation get a
  pending zone's answers; the gap is measured from the nameserver change.
- **A's moved zone:** if A's nameservers stop answering once B is active, resolvers that cached A's
  delegation (up to 48 hours for many TLDs) fail until it expires; measured in the live pass.
- **Universal SSL** can take up to 24 hours. On an HSTS-preloaded name (all of `.dev`, so
  opscrew.dev) browsers offer no way past a certificate error: the gap is an outage there.
- **Attaching a site's custom domain in B while A's Worker still holds it:** if Cloudflare refuses,
  the switch's plan detaches A's first (with A's token, A's zone being moved by then).
- **The shadow state of a cloud server's main root copies its server resources.** The plan check
  refuses any other change, and every command that could change the server is refused during the
  move.
- **B's lifecycle on copied snapshots** counts from the copy (OPEN O7).
- **Rate limits:** activation checks (hourly on free plans), DNS batch creates (200 a call).

### 14. What OpsCrew doesn't move

The move covers what OpsCrew made for its apps and the zone's DNS records. It doesn't copy, and the
guide lists for the user to redo in B before the switch (or to leave):
- the zone's plan and paid add-ons (B's zone starts on Free), and settings OpsCrew doesn't set:
  SSL/TLS mode and edge settings, caching and cache rules, page rules, transform and redirect rules
  of the user's own, WAF rules of the user's own, bot and DDoS settings, Speed settings;
- Email Routing, Workers and Pages projects OpsCrew didn't create, R2 buckets OpsCrew didn't create
  (including a user's own R2 bucket used as `snapshots.offsite.provider: s3`: its endpoint names A's
  account), Turnstile widgets, Web Analytics, Zero Trust settings beyond the organization and
  one-time PIN login, API tokens, members and their roles, notifications, Logpush;
- the domain's registration when it stays at another registrar, and Cloudflare Registrar's contacts
  (its own move between accounts carries the registration).

### 15. The live pass: the real move of opscrew.dev (T2826, T2827)

The founder is making a new Cloudflare account (B). The pass moves opscrew.dev, with every OpsCrew
app it serves, from today's account (A) to B. It is a production move made once, one way, run by
the lead in legs over hours or days.
- **Before it:** the spike (T2802) on the two accounts, using opscrew.dev's zone itself (a pending
  zone in B serves nothing); then a **rehearsal** of prepare and abort on the real zone with the
  pass's own app P (L2).
- **The registrar** holding opscrew.dev is not known yet. The pass supports both, and its preflight
  says which applies:
  - a registrar OpsCrew drives (Porkbun, Namecheap, GoDaddy): OpsCrew sets the nameservers (L4a);
  - Cloudflare Registrar in A: the founder starts the dashboard move in A and accepts it in B; the
    switch waits (L4b). Assumed nowhere else in the pass.
- **Apps:** every OpsCrew app the zone serves, each prepared and finished from its own repository by
  the lead (named in the lead's local checklist, not here), plus the pass's own two apps, so the
  shapes of SC-2801 and SC-2804 are covered: P = `examples/s3-uploads` on a Hetzner server, proxied,
  origin TLS, its files in R2, from `OPSCREW_E2E_GITHUB_REPO`; Q = `examples/flask-sqlite` on a
  throwaway Hetzner server set up as the user's own in tunnel mode, snapshots copied off the server
  to R2, from `OPSCREW_E2E_GITHUB_REPO_B`. Hostnames `e2e-<run>-p.<zone>` and `e2e-<run>-q.<zone>`.
- **Legs** (`packages/cli/test/live/cloudflare-move*.ts`, gated on `OPSCREW_E2E_CLOUDFLARE_MOVE=1`, each
  run on its own with vitest `-t`):
  - **L0** preflight: A holds the zone, B has none; the registrar; DNSSEC; inventories of both
    accounts, including what OpsCrew didn't make (14.), for the lead's checklist.
  - **L1** provision P and Q in A; seed P's bucket (500 objects) and two of Q's snapshot copies;
    start the load: 20 requests a second to P and Q, one a second to each real app's hostname,
    until L5 ends.
  - **L2** rehearsal: prepare P, then `--abort`: B holds nothing of P, B's zone is deleted, A's
    inventory is unchanged, no request failed (SC-2806).
  - **L3** prepare P; `--switch` refuses and names Q's hostnames (and the real apps'); prepare Q; the
    lead prepares every real app from its repository; P's app writes objects meanwhile. No request
    fails (SC-2802).
  - **L4** `--switch` from this repository (L4a or L4b); with DNSSEC on, the DS run, the wait, and
    the second approval. The move's times plus the pass's own probes every 5 s (this computer's
    resolver; DNS over HTTPS then the edge address with SNI; A's and B's nameservers asked directly
    with `node:dns` `Resolver`). SC-2803's figures to `docs/e2e-coverage.md`.
  - **L5** `--finish` for P and Q (P's R2 window, Q's connector), and the lead's finishes of the real
    apps: every app answers from B; a deploy after the finish succeeds for P and Q (Q's through B's
    Access); P's objects and Q's snapshot copies are in B with the same checksums and a restore of Q
    from its copy works (SC-2804); A holds nothing of P or Q but the moved zone and the Zero Trust
    organization and PIN login (SC-2805).
  - **L6** leak scan over every output, commit, pull request, plan, audit entry and state file
    (SC-2807); P and Q destroyed in B; the throwaway server deleted; leftovers listed. A's moved zone
    is left to Cloudflare.
- **The lead's checklist** (T2827): the apps the zone serves and their repositories; what OpsCrew
  doesn't move (14.) found in A, redone in B before the switch or let go; the registrar and DNSSEC;
  a low-traffic time (opscrew.dev is HSTS-preloaded, so the gap is an outage); after the finish,
  `.env.e2e`'s Cloudflare tokens for that zone become B's tokens, and R2 is on in B for the passes
  that use it.
- **Cost:** P's server and Q's throwaway server for a few hours (a few cents); R2 within the free
  tier, no egress fees; Cloudflare's free plan in B unless the zone's plan in A is paid (14.); the
  registrar charges nothing for a nameserver change. Time: activation (up to an hour on free plans),
  Universal SSL (minutes, up to 24 hours), and 24 to 48 hours more when DNSSEC is on.

## Order

1. T2801 (lead): contract, ADR 0032, scaffold. T2802 (lead): the spike.
2. Wave 1: T2803 (plan-schema), T2804 (Cloudflare client), T2805 (Cloudflare fake, shared adapter
   option), T2806 (ssh-host), T2807 (templates: addresses, ids, names, beside connector), T2808
   (templates: workflows' `_NEW` paths, Workers root variable), T2809 (domain helpers).
3. Wave 2: T2810 (types, session, checks), T2811 (provision's seams), T2812 (record, progress,
   guards).
4. Wave 3, after T2802: T2813 (shadow states), T2814 (shared plans), T2815 (connector beside), T2816
   (R2), T2817 (zone plan, copy, marks, coverage), T2818 (the deploy's `_NEW` credentials).
5. Wave 4: T2819 (switch and gap), T2820 (prepare), T2821 (abort), T2822 (finish: A's removal, the
   site's adoption, the mark).
6. Wave 5: T2823 (finish: the rest, in order).
7. Wave 6: T2824 (CLI, status, MCP, plugin), T2825 (guide).
8. Wave 7: T2826 (live test files).
9. Lead: T2827 (the rehearsal and the real move), T2828 (simplify), T2829 (CLAUDE.md, roadmap), T2830
   (release 0.2.9).

## Deviations from the lead's starting decisions

- **Decision 4, separate state:** kept, as shadow states of the same committed root modules, not
  separate roots: separate roots would need a second renderer and, at the finish, a move of
  resources between state files that `IacEngine` lacks (imports would lose the write-only secrets of
  an Access service token and a tunnel). The cost: a cloud server's shadow holds a copy of its server
  resources (3., 13.).
- **Decision 6, retarget's bucket move:** its pieces are reused (the rclone container, extracted to
  `shared/rclone.ts`; `bucketMinutes`/`syncMinutes`; the NEW key variables; the deploy pause), not
  its step machine: its bucket root is S3 through the `aws` provider with a `previous` alias, and its
  window spans two servers; here one server switches buckets, and the window is at the finish so an
  abort never copies back.
- **Decision 7:** replaced by the founder's decision: a Workers site's Worker runs in B from prepare
  and the switch attaches its custom domains right after activation.
- **The ADR is 0032:** 0031 is OpenLiteSpeed's (027).
- **FR-2802:** B's zone-level permissions can only be checked once B's pending zone exists: right
  after the zone plan makes it, before any other change.
- **FR-2806:** A's zone doesn't say which repository serves an app: an unprepared app is named by its
  hostnames.
- **FR-2812:** A's zone-scoped pieces (records, rules, AOP settings) are left to A's moved zone, which
  Cloudflare deletes; the finish removes A's account-scoped pieces and revokes A's Origin CA
  certificate.

## OPEN

The lead took O5, O6, O7, O8 and O10 as recommended (2026-11-14). O1 and O2 are settled by the
spike, O3 in the live pass, O9 by the founder.

- **O1 Per-hostname AOP on a pending zone** (T2802). If it can't be set there, origin-protected apps
  refuse B's edge from activation to their finish; the lead decides between that and a temporary
  `pull.pem` that also trusts Cloudflare's global AOP certificate during the move.
- **O2 An Origin CA certificate from A accepted by B's zone in Full (strict)** (T2802: certificates
  issued in both accounts compared by issuer and chain; the real move confirms). Until it says yes,
  the switch's approval and output say what 5.5 says.
- **O3 A's nameservers after activation:** measured in the live pass; no design change.
- **O4 Cloudflare-managed records' `meta` fields:** from the API reference and T2802's answer.
- **O5 Rotate during a move:** every rotation refused.
- **O6 Emptying A's R2 buckets:** after `rclone check` and the typed names (SC-2805 needs them gone).
- **O7 B's lifecycle on copied snapshots:** accepted, said in the guide.
- **O8 The recovery copy** doesn't include the shadow states: one app's steps run from one computer.
- **O9 The registrar of opscrew.dev:** unknown; L0 decides between L4a and L4b.
- **O10 The switch's wait:** two hours a run, resumable.

## Complexity Tracking

| Choice | Why | Simpler rejected |
|---|---|---|
| Shadow states copying a cloud server's non-Cloudflare resources | One root holds the server and its records; the copy lets B's plan create only B's pieces, and the finish is a file swap | Separate B roots: a second renderer, and a cross-state move the engine lacks |
| Two clients and two engine environments per run | Two accounts, one token each, no token in a variable | One root with two provider aliases: the second token in every saved plan file |
| TXT marks in B's zone | The only place every repository can read with the two tokens | A shared file or service: outside Cloudflare and the repositories |
| A beside connector | A tunnel's hostnames need B's connector before activation; the main one keeps serving A | Recreating the main one at the switch: the switch can't reach other repositories' servers |
| `_NEW` deploy secrets with a fallback in the workflow | Deploys keep working through Access, and a site's Worker stays current in B, without a deploy pause | Pausing deploys from the switch to each finish (the founder's "avoid the pause") |
| The switch attaching other repositories' custom domains | A site answers right after activation, not at its own finish | Each site's finish attaching its own: a gap as long as the wait for that repository |
| Emptying A's buckets with rclone | SC-2805; Cloudflare refuses a bucket that holds files | Asking the user to empty them: the app's data left in A |
