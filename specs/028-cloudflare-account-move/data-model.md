# Data model: Moving an app to another Cloudflare account

**Status**: DRAFT, revised after the lead's review. Ids below are placeholders; account and zone ids
are Cloudflare's 32 hex characters.

## 1. The move's record: `cloudflareMove` in `opscrew/plan.yaml` (committed)

One block in the plan of every environment the move covers (each environment of the app whose zone
is the zone). Ids, flags and times only: no token, key, certificate or address.

```yaml
cloudflareMove:
  zone: example.com                 # the zone that moves
  from:
    accountId: <A account id>       # the account that holds the zone when the move starts
    zoneId: <A zone id>
  to:
    accountId: <B account id>       # --to, resolved
    zoneId: <B zone id>             # once B's zone exists
  dsAtStart: false                  # the registry published a DS record when the move started
  step: started                     # last completed: started | prepared | adopted
  abort:                            # present once --abort began
    step: started                   # started | removed
  startedAt: 2026-11-20T10:00:00Z
  preparedAt: 2026-11-20T10:40:00Z
  adoptedAt: 2026-11-21T09:10:00Z
```

- **`started`:** written after the start's confirmation; B's pieces of this environment may be partly
  made.
- **`prepared`:** every piece of this environment is in B (shared plan, shadow roots, connector,
  extra secrets, first copies). The app's mark is written once every covered environment is
  `prepared`.
- **`adopted`:** the finish swapped this environment's states and secrets to B; A's pieces may still
  wait for their removal. No abort from here.
- **Removed** when the finish has ended for this environment, or when an abort ends.
- **`dsAtStart`** lets any repository tell that the switch began (abort's refusal, plan 8.): it was
  true and the registry no longer publishes a DS record.
- **Refusals (plan-schema):** never beside `retarget`; never in a preview environment's plan;
  `to.accountId` differs from `from.accountId`; `abort` only with `started` or `prepared`; `zone`
  equals `dns.zone` when the plan names one (`dns.zone` is optional; then the zone is the one
  `findZone` finds for `dns.domain`).
- **Readers:** `requireNoCloudflareMove` (plan 11.), `destroy`, `retarget`, the move's steps,
  `status`, `opscrew_status`.

## 2. Local files (machine-local, no secret in them)

Only what can't be read again from Cloudflare, the registrar or the state files.

**The app's `.opscrew[/apps/<key>]/cloudflare-move.json`:**

```json
{
  "pending": {
    "action": "shadow-create",
    "environment": "prod",
    "root": "main",
    "planHash": "<64 hex>",
    "savedAt": "2026-11-20T10:12:00Z"
  },
  "window": { "environment": "prod", "stoppedAt": "2026-11-21T09:02:00Z" }
}
```

- `pending`: the saved plan a script's next run applies with `--approve` (retarget's
  `retarget-pending.json` shape, plus the environment and root). Actions: `zone`, `shared`,
  `shadow-create`, `connector`, `secrets`, `copy`, `mark`, `window`, `finish-secrets`, `swap-check`,
  `site-adopt`, `a-removal`, `a-revoke`, `a-empty`, `mark-delete`, `abort-empty`, `abort-shadow`,
  `abort-shared`, `abort-zone`. `root`: `main`, `storage`, `backups`, `pages-verification`.
- `window.stoppedAt`: set before the finish stops the app; a run that finds it starts the app again
  on A's settings first.

**The repository's `.opscrew/cloudflare-move-switch.json`** (the run that switches):

```json
{
  "zone": "example.com",
  "pending": { "planHash": "<64 hex>", "savedAt": "2026-11-21T08:59:00Z" },
  "ds": { "removedAt": "2026-11-19T08:00:00Z", "switchAfter": "2026-11-21T09:00:00Z", "waitSeconds": 172800 },
  "nameserversSetAt": "2026-11-21T09:00:30Z",
  "activeAt": "2026-11-21T09:06:10Z",
  "certificateAt": "2026-11-21T09:19:40Z",
  "okAt": { "shop.example.com": "2026-11-21T09:20:05Z" }
}
```

- `ds` follows `domain connect`'s `ConnectState` (`dsWaitSeconds`, `REMOVAL_MARGIN_SECONDS`,
  `laterSwitch`). Deleted after the switch's last step; its times are printed and audited too.
- Everything else (the nameservers, DS records, B's zone status, the marks, what each sub-step made)
  is read again on every run.

## 3. Shadow states and A-removal states (machine-local, per environment)

Under each covered environment's state folder
(`.opscrew[/apps/<key>][/environments/<env>]/cloudflare-move/`):

```
cloudflare-move/
  tfstate/
    <env>.tfstate                         # B's main root: a copy of the environment's state with
                                          #  every Cloudflare address removed, then B's pieces
    storage.tfstate                       # B's app bucket (R2), from empty
    backups.tfstate                       # B's bucket of the snapshots' copies (R2), from empty
    github-pages-verification.tfstate     # GitHub's verification record in B (a Pages app's prod)
  tf/<root folder name>/                  # TF_DATA_DIR of each shadow root
  cloudflare.json                         # B's shared record (SharedRecordSchema)
  a-removal/                              # appears at the finish's swap
    tfstate/<same names>.tfstate          # the environment's former states; non-Cloudflare and
                                          #  zone-scoped addresses removed before their destroy plans
    tf/<root folder name>/
    cloudflare.json                       # A's shared record (A's Origin CA certificate to revoke)
```

- Encrypted with the project's state passphrase like every state (OpenTofu); the key name is read
  from the environment's states as today.
- **The swap,** per root: the environment's state → `a-removal/tfstate/`, then the shadow state → the
  environment's `tfstate/`. A run finds where it stopped from which files exist.
- **The tfvars patch:** only the keys `accountVariables` names, in the root's committed
  `terraform.tfvars.json`, get B's values; the file is otherwise byte for byte the same.
- **Never** in the recovery copy; deleted when the finish or the abort ends.
- **`cloudflareAddressScope(address)`** (iac-templates): `undefined` (not Cloudflare's), `zone`
  (`cloudflare_dns_record`, `cloudflare_certificate_pack`) or `account` (every other resource under
  the `dns`, `tunnel`, `access`, `portainer_tunnel` or `worker` module calls, and every other
  top-level `cloudflare_*` resource).

## 4. The prepared mark: TXT records in B's zone

Written by the app's last prepare step, read by the switch (and by `status` with B's token), deleted
by the app's own finish or abort.

- **Name:** `_opscrew-move.<label>.<zone>`, `<label>` = `<app name>-<first 8 hex of
  sha256("<owner>/<repo>#<app key>")>` (the key empty for a repository's first app): unique across
  repositories without naming one.
- **Content** (one TXT record of up to 2,048 characters; more records of the same name with
  `part=2/3` when it doesn't fit):

  ```
  opscrew-move=1; app=shop; envs=prod,staging; hosts=shop.example.com,www.shop.example.com,ssh-shop.example.com,staging.shop.example.com
  opscrew-move=1; app=docs; envs=prod; hosts=docs.example.com; worker=docs; domains=docs.example.com
  ```

  - `hosts`: every name `opscrewRecordNames` gives for each covered environment (the names of its
    OpsCrew records, its shared rules' hostnames, its Workers custom domains): what the switch's
    coverage check matches A's zone against.
  - `worker` and `domains`: a Workers site's Worker name in B and the custom domains the switch
    attaches to it.
- DNS only, TTL automatic, comment `OpsCrew move mark`: no copy or foreign-record check takes it for
  an app's record.
- Visible in DNS once B's zone is active and until the app's finish deletes it. It holds the app's
  name, its environments' names, its hostnames (public in DNS anyway) and a site's Worker name;
  never an id, a repository or a secret.
- Parsed and written in agents (`cloudflare-move/marks.ts`); the connector only lists, creates and
  deletes the records.

## 5. The zone copy (agents)

Planned in agents (T2817) on `domain connect`'s comparison, applied through the connector.

```ts
interface ZoneCopy {
  zone: string;
  from: { accountId: string; zoneId: string };
  to: { accountId: string; zoneId?: string };     // no zoneId: the plan creates the zone
  createZone: boolean;
  create: ZoneRecord[];                           // in A, missing from B
  differ: { a: ZoneRecord; b: ZoneRecord }[];     // same type and name, other content: listed only
  onlyInB: ZoneRecord[];                          // listed only
  skipped: { record: ZoneRecord; reason: string }[];
  marks?: { create: string[] } | { delete: string[] };  // TXT contents, or record ids
  planHash: string;                               // sha256 of canonicalJson of the above
}

interface ZoneRecord {
  type: string; name: string; content?: string; data?: Record<string, unknown>;
  ttl: number; proxied?: boolean; priority?: number; comment?: string;
}
```

- **Compared** by type, name and normalised content (`recordsMissingFromZone`, T2809, from
  `connect-plan.ts`).
- **Skipped:** comment `Managed by OpsCrew` (each app's shadow roots make its own), records the
  `meta` fields mark as Cloudflare's own (Workers custom domains and the like), apex NS, the marks.
- **Shown** with the app's servers' addresses masked.
- **The apply** re-reads both zones, plans again and refuses (nothing changed) on another hash;
  records are created in batches of 200 with every field kept.

## 6. Extra deploy secrets during a move (GitHub)

For each covered environment, with the environment's deploy-secret prefix (`deploySecretPrefix`):

| Secret | Set at | Holds | At the finish |
|---|---|---|---|
| `…TUNNEL_SERVICE_TOKEN_ID_NEW`, `…TUNNEL_SERVICE_TOKEN_SECRET_NEW` | prepare (own server in tunnel mode) | B's deploy service token | the plain names take the values; `_NEW` deleted |
| `…PORTAINER_ACCESS_CLIENT_ID_NEW`, `…PORTAINER_ACCESS_CLIENT_SECRET_NEW` | prepare (Portainer, redeploy `cloudflare`) | B's webhook Access client | the same |
| `…CLOUDFLARE_ACCOUNT_ID_NEW`, `…CLOUDFLARE_API_TOKEN_NEW` | prepare (Workers site) | B's account id and deploy token | the same |

An abort deletes every `_NEW` secret. The workflows read them as plan 10. says; without them they
behave as before the move.

## 7. Values kept outside the repository

- **`generated_values.json`** (each environment's project home, 0600): `originTlsNext` beside
  `originTls` (`ORIGIN_TLS_KEY`, `ORIGIN_TLS_CERT`, `ORIGIN_TLS_REQUEST` of the certificate issued
  under B; the client certificate is shared, so not repeated). At the finish `originTls` takes them;
  at an abort they are forgotten.
- **`storage_key.json`** (project home, 0600): an R2 key gains `account`, so A's and B's same-named
  buckets keep separate keys during the move; at the finish A's is forgotten. A kept key without
  `account` still matches its bucket.
- **Environment variables during a move:**

  | Variable | Holds |
  |---|---|
  | `CLOUDFLARE_API_TOKEN` | A's token, as before |
  | `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` | B's token (A's permissions on B, plus adding zones) |
  | `OPSCREW_NEW_STORAGE_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | B's app bucket key (existing names) |
  | `OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | B's snapshots' bucket key |
  | `OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN` | B's Workers deploy token (a site on Cloudflare's hosting) |
  | `PORKBUN_*`, `NAMECHEAP_*`, `GODADDY_API_TOKEN` | the registrar, for the switch |

  Once every app in the zone is finished, each `OPSCREW_NEW_*` value goes to its plain name.

## 8. Audit entries

Phase `cloudflare-move`, target the app's name (the zone for the switch). One entry per approval
and per provider call: `zone plan applied`, `shared plan applied (B)`, `shadow apply <root>`,
`connector beside`, `secrets (_NEW)`, `copy bucket`, `mark written`, `DS removed`, `set nameservers`
(registrar, before and after), `activation check`, `custom domains attached`, `switch measured`,
`DNSSEC on (B)`, `window` (start, end, rollback), `finish secrets`, `states swapped`, `A removed
<root>`, `bucket emptied`, `origin certificate revoked`, `mark deleted`, `abort …`. Never a value of a
token, key or certificate.
