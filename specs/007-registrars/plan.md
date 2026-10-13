# Implementation Plan: Namecheap, Porkbun and GoDaddy

**Branch**: `mvp` | **Date**: 2026-10-13 | **Spec**: `specs/007-registrars/spec.md` |
**Research**: `specs/007-registrars/research.md`

## Summary

Three registrar adapters implement the 006 `Registrar` contract plus optional capabilities
(quote, nameservers, records, DNSSEC, account check). `opscrew domain buy --registrar <id>` buys
through any of the four with the 006 safety rules and then points the domain at a Cloudflare zone;
`opscrew domain connect` moves a domain the user already owns onto Cloudflare DNS, copying its
records first. Contact data is never collected or kept (ADR 0009).

## Technical Context

Same stack. New workspace packages `@opscrew/connector-porkbun`, `@opscrew/connector-namecheap`,
`@opscrew/connector-godaddy` (dependencies as the other connectors). New dependency
`fast-xml-parser` (MIT, no runtime dependencies) for Namecheap's XML responses — Node has no XML
parser and hand-written parsing of attribute-heavy XML would be fragile (constitution X); it is
also a runtime dependency of the bundled CLI (third-party packages stay external to the bundle).

## Constitution Check

- I: purchases keep the 006 rules for every registrar (typed domain, never `--yes`, price bound in
  scripts, one purchase per domain, idempotency keys where the API has them, audit). Connecting a
  domain changes DNS: every change is a typed `domain-settings` approval (the scan zone when used;
  the copy and switch, listing the zone, the records, DS changes and the nameserver switch; the
  DNSSEC step later), each listing exactly what changes; refused → nothing changed.
- IV: registrar keys are environment variables, registered with the redactor, stripped from agent
  environments; contact data never collected, stored, logged, audited or sent to a model
  (Namecheap: the account's own default contact relayed in memory; masked in the approval).
- VIII: every mutation through the typed adapters (Porkbun's MCP server is not used).
- II: price comparison ranks by price only; no referral links.

## Project Structure

```text
packages/contracts/src/registrar.ts                   # T701: capabilities, quote, records, DS, account check
packages/core/src/{env,redact}.ts, src/testing/fake-secrets.ts  # T701: new env names, fake kinds
packages/connectors/{porkbun,namecheap,godaddy}/{package.json,tsconfig.json,src/index.ts}  # T701 skeletons
packages/{agents,cli}/package.json, pnpm-lock.yaml    # T701 (cli also gets fast-xml-parser)
packages/agents/src/domain/{index,types}.ts           # T701: connectDomain stub, registrar option types
docs/adr/0009-registrar-contacts-and-connect.md       # T701
packages/connectors/porkbun/src/**                    # T702
packages/connectors/namecheap/src/**                  # T703
packages/connectors/godaddy/src/**                    # T704
packages/connectors/cloudflare/src/**                 # T705
packages/agents/src/domain/registrars.ts (+ test)     # T706 (lead): registrarFor(id, deps), profiles
packages/agents/src/domain/** (buy, search, manage, nameservers) # T707
packages/agents/src/domain/connect*.ts                # T708
packages/agents/src/init/**                           # T709
packages/cli/src/commands/domain.ts (+ test)          # T710
packages/mcp-server/src/**, plugin/**, README.md      # T711
packages/cli/test/live/**, docs/e2e.md                # T712 (lead)
```

## Design

### Contracts (T701, lead)

```ts
export interface RegistrarCapabilities {
  purchase: boolean;
  /** Years can be chosen at purchase (Porkbun registers the registry minimum only). */
  chooseYears: boolean;
  nameservers: boolean;
  /** Current DNS records can be read (when the registrar hosts the domain's DNS). */
  records: boolean;
  dnssec: boolean;
  /** Auto-renew can be changed through the API. */
  autoRenew: boolean;
}
export interface RegistrationQuote {
  price: Money;              // what this purchase costs now (all years)
  renewal?: Money;
  token?: string;            // GoDaddy quote token
  agreements?: string[];     // GoDaddy required agreements, shown in the approval
  expiresAt?: IsoDateTime;
}
export interface RegistrarDnsRecord { type: string; name: string; content: string; ttl?: number; priority?: number }
export interface DsRecord { keyTag: number; algorithm: number; digestType: number; digest: string }
export interface RegistrarAccountCheck { ok: boolean; message: string; fix?: string; balance?: Money }
// Registrar gains:
readonly capabilities: RegistrarCapabilities;
quote?(domain: string, years: number): Promise<RegistrationQuote>;
/** Masked registrant summary for the approval, e.g. "J*** D***, DE" (never the full data). */
contactSummary?(): Promise<string | undefined>;
ownsDomain?(domain: string): Promise<boolean>;
getNameservers?(domain: string): Promise<string[]>;
setNameservers?(domain: string, nameservers: readonly string[]): Promise<void>;
/** Undefined when the registrar does not host the domain's DNS. */
listRecords?(domain: string): Promise<RegistrarDnsRecord[] | undefined>;
listDsRecords?(domain: string): Promise<DsRecord[]>;
addDsRecord?(domain: string, ds: DsRecord): Promise<void>;
removeDsRecord?(domain: string, keyTag: number): Promise<void>;
accountCheck?(): Promise<RegistrarAccountCheck>;
// RegistrationRequest gains: quote?: RegistrationQuote (the approved quote; Porkbun sends its
// price as `cost` in cents and fails when it changed; GoDaddy sends its token and consent).
```

Cloudflare's adapter sets `capabilities` (purchase, chooseYears, autoRenew; nameservers fixed),
the others in their tasks. Environment variables: `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY`;
`NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_USERNAME` (default: the API user),
`NAMECHEAP_CLIENT_IP` (default: detected); `GODADDY_API_TOKEN`, `GODADDY_PROFILE_ID` (optional);
Porkbun's sandbox is selected by its key prefix (`pk1_sb_`); Namecheap's by `NAMECHEAP_SANDBOX=1`. Fake secret kinds `porkbun-api-key`, `porkbun-secret-key`, `namecheap-api-key`,
`godaddy-token`.

### Porkbun (T702)

Client over `https://api.porkbun.com/api/json/v3` with header auth; `ping` (scopes, account),
`checkDomain(s)` (batch ≤ 25, rate limits), `pricing`, `registrationRequirements(tld)`,
`createDomain(domain, { costCents, idempotencyKey, dryRun? })` (never retried on ambiguous
answers; `INSUFFICIENT_FUNDS`, `MONTHLY_SPEND_LIMIT_EXCEEDED`, `ORDER_TOO_LARGE` as clear
rejections with Porkbun's `next_action` hint), `getDomain`, `listAll` (paged), `updateAutoRenew`,
`getNs`/`updateNs`, `retrieveRecords`, DNSSEC get/create/delete. `PorkbunRegistrar` implements the
contract (`chooseYears: false`: years > 1 → plain `INVALID_INPUT`; `quote` = the live price for the
minimum term; `register` sends `cost` from the approved quote and the idempotency key derived from
the purchase record). Errors carry `code` → plain English; keys never in errors.

### Namecheap (T703)

Client over the XML API (POST form, `fast-xml-parser`, zod on the parsed tree), global parameters
from the env (`ClientIp` from `NAMECHEAP_CLIENT_IP` or the Cloudflare trace endpoint, cached per
run), sandbox endpoint with `NAMECHEAP_SANDBOX=1`. Commands: `domains.check`, `users.getPricing`,
`users.getBalances`, `users.address.getList/getInfo` (default address, mapped to all four contacts;
`Zip`→`PostalCode`, phone normalised to `+CCC.NNNN`), `domains.create` (contacts +
`AddFreeWhoisguard`, Namecheap's default nameservers until the zone exists; ambiguous answers → "may still have started"; `NonRealTimeDomain` → pending),
`domains.getList`/`getInfo`, `domains.dns.getList/setCustom/getHosts`, `setRegistrarLock`.
`NamecheapRegistrar`: `capabilities` `{ purchase, chooseYears, nameservers, records, dnssec: false,
autoRenew: false }`; `accountCheck` (API access / whitelist errors → plain fix naming the detected
IPv4; balance); `contactSummary` masked; contact data never leaves the adapter except in the
`domains.create` request body to Namecheap.

### GoDaddy (T704)

Client over `https://api.godaddy.com` with `Authorization: Bearer <PAT>`: check availability,
registration quote (`profileId` from `GODADDY_PROFILE_ID` when set, otherwise GoDaddy's default
profile or account details — v3 cannot list profiles; missing contacts → plain stop), register with `Idempotency-Key` and
`consent { agreementTypes, agreedAt }` (202 → poll registration/operation), domain details,
nameservers (async operation), DNS records (v3 zones). `GoDaddyRegistrar`: `capabilities`
`{ purchase, chooseYears, nameservers, records, dnssec: false, autoRenew: false }` unless the task
finds the v3 endpoints; 403 eligibility errors → plain message about GoDaddy's API access rules.

### Cloudflare (T705)

`createZone` returns `nameServers`; `activationCheck(zoneId)`; `batchCreateRecords(zoneId,
records)` (one transaction; maps registrar records: ALIAS at the apex → CNAME (flattened), MX
priority, TXT quoting); `scanDnsRecords(zoneId)` (`/scan/trigger`, then the `/scan/review` list,
shown for review and never accepted there); `getDnssec` returns DS fields; `detectPublicIpv4(fetch)`
(trace endpoint).

### Registrar seam (T706, lead)

`agents/src/domain/registrars.ts`: `registrarFor(id, deps, account?)` builds each adapter from the
environment (Cloudflare needs the account; the others are single-account), `configuredRegistrars
(env)`, display names, dashboard links per registrar and setting (auto-renew, DNSSEC).

### Buying elsewhere, compare, manage (T707)

`buyDomain` takes `registrar` (default `cloudflare`): capability checks (years, premium,
extensions), `accountCheck`, `quote` (shown and bounded by `maxPrice`), the typed approval (adds
the masked contact, agreements and "nameservers will point at Cloudflare"), the 006 purchase
record per registrar (with the registrar and the idempotency key, created before `register`; a
`pending`/`in_progress` first answer is recorded as accepted and never cleared automatically,
because Namecheap may not list a non-real-time order for hours), `register` with the quote and
the key, then `switchToCloudflare`: create the zone, set
the registrar's nameservers to the zone's, add DS when the registrar supports it (else print the DS
values and the dashboard link), activation check, record `dns.registration.registrar`. `search
--compare` checks every configured registrar; `domainStatus`/`setDomainAutoRenew` use the plan's
registrar and capabilities.

### Connect (T708)

`connectDomain(deps, { domain, registrar?, recordsFile?, services })`: find the registrar
(`--registrar` or `ownsDomain` across configured ones); read nameservers, DS records (through the
registrar's API, else a public DNS lookup over HTTPS) and, when the registrar hosts DNS, the
records; else a BIND file (`--records-file`) or Cloudflare's scan (the scan needs the zone, so
creating the pending zone is its own typed approval first; a pending zone changes nothing live).
Build the copy plan (skip NS/SOA, map ALIAS/URL records, list what cannot be copied). One typed
`domain-settings` approval lists the zone, the records, DS changes and the switch.

DNSSEC timing (resolvers cache the parent's DS record, often for a day): old DS records are
removed in one run (through the API after the approval, or by the user in the dashboard when the
API cannot) and the run stops, saying when to run `opscrew domain connect` again; the nameserver
switch happens only once no old DS record is published and the removal is older than the DS TTL
(recorded in `.opscrew/domain-connect.json`). Cloudflare's new DS record is added (or shown with
the dashboard link) only once the zone is active, on a later `opscrew domain connect` run (which
`opscrew domain status` points to).
Order: create zone → batch-create records → (old DS removal, stop) → set nameservers →
activation check → update requirements/plan; later: zone active → add the new DS. Resumable (the
zone, records and switch are checked before doing them again). A freshly bought domain (T707) has
nothing live, so its DS record is added right after the switch.

### Init, CLI, MCP (T709–T711)

Init: one optional check per configured registrar (`accountCheck`). CLI: `--registrar` on buy,
search (`--compare`), status, auto-renew; `opscrew domain connect <domain> [--registrar]
[--records-file] [--confirm]`. MCP: `opscrew_domain_check` gains `registrar`/`compare`.

### Sandbox tests (T712, lead)

Porkbun sandbox keys (`OPSCREW_E2E_PORKBUN_API_KEY`/`_SECRET_KEY`): dry run, buy, set the
nameservers and read them back (the sandbox has no real delegation), records, DS. Namecheap sandbox (`OPSCREW_E2E_NAMECHEAP_*`): check, pricing, balance, address,
create, setCustom.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| `fast-xml-parser` dependency | Namecheap answers in XML | Regex parsing of attribute XML is fragile and hard to validate |
| Namecheap contacts relayed in memory | Its create call requires full contacts every time | Asking the user for contact data would mean collecting personal data (worse) |
