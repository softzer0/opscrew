# 028 Moving an app to another Cloudflare account: research

Asked for by the founder on 2026-11-14 ("is opscrew able to transfer from one cloudflare account to
another setup?", then "can you please implement that too"). Today OpsCrew cannot: nothing moves an
app's Cloudflare pieces between accounts, and swapping `CLOUDFLARE_API_TOKEN` for another account's
token is not a supported path (the IaC state points at the old account's resources).

## Founder's decisions (2026-11-14)

- **Release:** 0.2.8 ships without it; the move ships as 0.2.9 once it has passed live.
- **A zone that serves several OpsCrew apps:** all of them move. A zone moves as a whole (its
  nameservers change once), so each app prepares its side in the new account from its own
  repository, one run switches the zone, and each repository then finishes.
- **R2:** the app's buckets (object storage, the snapshots' off-server copies) are copied to new
  buckets in the new account and the app switched to them in a short maintenance window, so the old
  account can be closed afterwards.

## R1 What Cloudflare offers for a move

Source: [Move a domain between Cloudflare accounts](https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/).

- No API or dashboard action moves a zone between accounts. The documented way is to add the
  domain to the new account (a new zone, pending), copy its settings and records, set the new
  zone's nameservers at the registrar, and let Cloudflare activate it ("Re-check now" in the
  dashboard; the API has `PUT /zones/{id}/activation_check`, which OpsCrew's client already calls).
- Before: remove DNSSEC, disable any zone hold, export the old zone's records and import only the
  right ones (a proxied record imported wrongly gives 1000-series errors).
- While the new zone is pending it does not proxy; the old zone keeps serving.
- Once the new zone is active the old one shows "Moved Away", becomes "Deleted" after 7 days and
  is purged 7 days later. Cancel the old zone's add-ons only after activation.
- Certificates do not carry over. A custom certificate can be uploaded to the pending zone (it
  deploys on activation), and an Advanced certificate ordered before the move; both are paid
  (custom certificates need Business or higher, ACM is $10 a month), so OpsCrew relies on Universal
  SSL, which [is issued within 15 minutes to 24 hours of activation](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl/):
  **the move has an HTTPS gap after the switch** unless that issuance is fast. The live pass
  measures it; the approval must say so.
- Activation needs the nameserver change: no documented way activates the new zone without one.
  Nameservers are assigned per zone and [cannot be changed](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
- UNVERIFIED (settle before the plan, or in the live pass): that the same domain can be a pending
  zone in account B while active in A (the guide implies it); that B's zone gets a nameserver pair
  different from A's; whether a Workers custom domain can be created on a pending zone.

## R2 DNSSEC

The move guide says to remove DNSSEC first; the [Registrar's inter-account move](https://developers.cloudflare.com/registrar/account-options/inter-account-transfer/)
needs it off too. Neither page names a wait, but the DS record at the registry must be gone (and
its TTL passed) before the switch, which is exactly what `domain connect` already does
(`dsMustGoFirst`, `waitForOldDs`, `removeOldDs` in `packages/agents/src/domain/connect.ts`). After
activation, DNSSEC is turned on again in the new zone (`publishDs`, `dnssecStep`). Multi-signer
DNSSEC is not documented for account moves.

## R3 Where the domain is registered

- **Porkbun, Namecheap, GoDaddy (an API OpsCrew drives):** `domain connect`'s nameserver switch
  (`pointToZone` in `domain/switch.ts`) and its DS handling.
- **Cloudflare Registrar:** the registration moves through the dashboard only (source account:
  Manage Domain → Configuration → Start; the receiving account accepts within 5 days in Domain
  Registration → Manage Domains). It needs the domain added to the new account first, DNSSEC off,
  the domain older than 10 days, a verified registrant email, no lock or pending state; the source
  account's settings are lost and the domain is transfer-locked for 30 days. API support is
  UNVERIFIED (a [Registrar transfer API beta](https://developers.cloudflare.com/changelog/post/2026-09-30-registrar-transfer-api-beta/)
  exists, maybe for inbound transfers only). OpsCrew prints the steps and waits.
- **Any other registrar:** the user changes the nameservers; OpsCrew prints them and waits, as
  `retarget`'s `--dns-switched` path does.

## R4 What is account-scoped and must be recreated

- **Tunnels:** a hostname's `<id>.cfargotunnel.com` CNAME only works in the tunnel's own account
  ([Tunnel DNS routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)).
  The new account gets its own tunnel, and the server (own server in tunnel mode, Portainer's app
  and webhook tunnels) runs its connector beside the old one until the switch.
- **Zero Trust Access** applications, policies and service tokens; the account's Zero Trust
  organization and one-time PIN login (shared by every app, created when missing, never deleted:
  ADR 0014).
- **Workers** scripts and their custom domains (a custom domain needs a zone the account owns):
  the site is deployed again in the new account. GitHub secrets `OPSCREW_CLOUDFLARE_ACCOUNT_ID` and
  `OPSCREW_CLOUDFLARE_API_TOKEN` change.
- **R2 buckets:** no native cross-account transfer. [Super Slurper](https://developers.cloudflare.com/r2/data-migration/super-slurper/)
  can copy from R2 but is a dashboard bulk job; rclone (already pinned in OpsCrew) copies between
  the two accounts' S3 endpoints. The R2 endpoint `https://<account>.r2.cloudflarestorage.com` and
  the keys change in the app's settings.
- **API tokens** are per account; the user makes the new account's token.

## R5 Zone-scoped pieces copied to the new zone

- **DNS records:** [export and import](https://developers.cloudflare.com/dns/manage-dns-records/how-to/import-and-export/)
  as BIND keep proxied (`cf-proxied`), comments and tags, CNAME flattening; 256 KiB per file, 3
  requests a minute. OpsCrew already has a BIND reader (`parseBindZone`, `readBindFile`), the copy
  plan (`copyPlan`, `missingFromZone`) and `batchCreateRecords`. The app's own OpsCrew records
  (comment "Managed by OpsCrew") are created by its IaC in the new zone instead, pointing at the
  new account's tunnel or Worker; the user's other records are copied as they are.
- **OpsCrew's three shared rules** (`opscrew-block-probes`, `opscrew-strict-tls`,
  `opscrew-www-redirect`, keyed by ref in `connectors/cloudflare/src/shared.ts`) and the zone's
  `min_tls_version`: planned again for the new zone (`planSharedCloudflare`, `applySharedCloudflare`).
- **Authenticated Origin Pulls** with an uploaded certificate are zone-scoped: uploaded again.
  [Global AOP](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/)
  uses Cloudflare's shared certificate, account-independent.
- **Origin CA certificates** are created with hostnames only and listed by zone. Whether one
  issued under A is accepted by B's zone for Full (strict) is UNVERIFIED; the smaller safe path is
  a new one for the new zone, placed like a rotation.
- **Previews' certificate pack** (ACM) on the previews zone: ordered again there (paid; covered by
  fakes only, as today).

## R6 Where OpsCrew ties an app to its account today

- The zone is found by name (`findZone`, most specific parent first); the **account comes from the
  zone** (`zoneAccount` and `setupCloudflare` in `agents/src/provision/credentials.ts`). Only the
  `domain` commands take `--account` (`resolveAccount`).
- Ids are kept in: each root's committed `terraform.tfvars.json` (`cloudflare_zone_id`,
  `cloudflare_account_id`), the IaC state (`.opscrew/tfstate/*.tfstate`), `.opscrew/cloudflare.json`
  (zone id, hostnames, certificate ids; per environment under `.opscrew/environments/<env>/`), the
  GitHub secret `OPSCREW_CLOUDFLARE_ACCOUNT_ID`, and the R2 endpoint in the app's settings. The plan
  holds only the zone's name (`dns.zone`).
- Secrets the move replaces: the tunnel token (root-only `tunnel.env` on an own server, the stack's
  `OPSCREW_TUNNEL_TOKEN` in Portainer), the Access service token for deploys
  (`OPSCREW_TUNNEL_SERVICE_TOKEN_ID`/`_SECRET`), Portainer's webhook Access client, the Workers
  deploy token, the origin certificate (`OPSCREW_ORIGIN_TLS`), the R2 keys (app settings,
  `OPSCREW_OFFSITE_ENV`). `rotate` already replaces the tunnel and Access tokens in place.
- Per root: the app's main root (records, tunnel, Access, Workers, previews' pack), `storage`
  (R2 for the app), `backups` (R2 for the snapshots' copies), `github-pages-verification`. Each
  environment has its own state; several apps each have their own `opscrew/infra/<key>` roots.

## R7 Reusable machinery

- `retarget` (`agents/src/retarget/**`): progress in `plan.yaml` under `retarget` with steps,
  saved plans approved by hash (`prepareInfraPlan`, `applyInfraPlan`), the DNS switch plan, the
  maintenance window for data, `finishRetarget`/`removeOldSide` with typed confirmation, `abort`.
- `domain connect` (`agents/src/domain/connect.ts`): record copy, DS removal and wait, nameserver
  switch at registrars, activation check, DNSSEC back on.
- `rotate tunnel-token` / `rotate access-token`: replacing Cloudflare-issued secrets on the server
  and in GitHub.
- Snapshots' rclone image and settings (`iac-templates/src/offsite.ts`) for the R2 copy.

## R8 The follow-up pass on R1, R3 and R5 (2026-11-14)

- **Nameservers:** [Nameserver options](https://developers.cloudflare.com/dns/nameservers/nameserver-options/)
  implies a domain can be added to several accounts ("a conflict can be caused by anyone adding
  the same zone to any other Cloudflare account") and says assignments may differ even within one
  account, but promises no pair different from the active zone's. OpsCrew reads B's pair from the
  API and stops when it equals A's (the switch would then change nothing). Whether `POST /zones`
  refuses a domain active elsewhere stays UNVERIFIED: the live pass shows it.
- **Universal SSL** is ["issued after your domain is active on Cloudflare"](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/),
  with no pre-issuance for pending zones (Advanced or custom certificates, both paid, are the
  documented way around it). `GET /zones/{id}/ssl/universal/settings` returns only `enabled`; the
  certificate packs list (`GET /zones/{id}/ssl/certificate_packs`, status `active`) is the likely
  signal to wait on (UNVERIFIED: the live pass confirms it).
- **Workers custom domains** need ["an active Cloudflare zone"](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
  and cannot sit on a hostname with a CNAME record: for a site on Cloudflare's hosting they are
  attached right after activation, so a site has a gap of its own until then.
- **Tunnels:** proxied CNAMEs to B's tunnel on a pending zone, and two connectors (two accounts'
  tunnels) on one host, are UNVERIFIED in the docs; the live pass shows both. The cloudflared
  connector runs per tunnel token, so two services side by side is the expected way.
- **Origin CA:** the docs tie neither trust nor revocation to a zone or account; revocation is
  permanent. The safe design stands: a new certificate under B, placed before the switch.
- **Registrar:** the inter-account move is dashboard-only, accepted within five days; no API and
  no duration documented.
- **Settings and rules:** no official copy tool; OpsCrew plans them for the new zone itself.
- **DNSSEC:** ["you must remove any DNSSEC configurations"](https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/)
  is the only documented path; [multi-signer](https://developers.cloudflare.com/dns/dnssec/multi-signer-dnssec/about/)
  covers Cloudflare beside another provider, not two Cloudflare accounts.

**What the switch costs, then:** from B's activation until B's Universal SSL certificate is live
(minutes, at worst 24 hours), HTTPS visitors get certificate errors; a Workers site is also down
until its custom domains are attached. The move says this before the switch is approved, waits on
the certificate and the site, and reports how long each took. The live pass measures it.

## R9 Open questions for the plan

1. The UNVERIFIED items above, settled in the live pass.
2. How the apps sharing a zone learn of each other's readiness without a shared store: candidates
   are a record in the new zone per prepared app (for example a TXT `_opscrew-move.<app>`), or the
   new account's OpsCrew pieces themselves, which the switching run lists.
3. The HTTPS gap: whether to keep the new zone's records DNS-only until its certificate is active
   (only possible where the origin has a public certificate; never for tunnels or Workers).
4. Environments and previews: every environment of every app moves in the same switch, since they
   share the zone; a previews zone below another domain moves on its own.
5. The live pass: a second Cloudflare account (the founder's, free) and a domain whose nameservers
   OpsCrew can switch, other than the domain every other pass uses.
