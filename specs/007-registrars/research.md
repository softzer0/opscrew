# Research: Namecheap, Porkbun and GoDaddy (2026-10-13)

Official sources only. Items marked **confirm live** are checked by the gated sandbox tests.

## Porkbun API v3 (https://porkbun.com/api/json/v3/documentation, /api/json/v3/spec, /llms-full.txt)

- Base `https://api.porkbun.com/api/json/v3` (sandbox: same base, `pk1_sb_`/`sk1_sb_` keys; responses
  carry `"sandbox": true`; `/sandbox/reset` grants $1000 fake credit). Auth headers `X-API-Key`,
  `X-Secret-API-Key`. Errors: `status: "ERROR"`, stable `code`, `message`, `next_action { type,
  hint, retryable, url? }`, `requestId`.
- `/ping` → `credentialsValid`, `account` (username), `scopes` (`read`, `dns`, `domains`, `email`,
  `hosting`, `purchase`, `funding`, `account`, or `["full"]`), `yourIp`. A call outside the key's
  scopes → 403 `INSUFFICIENT_SCOPE` (`requiredScope`, `keyScopes`); also `IP_NOT_ALLOWED`,
  `DOMAIN_NOT_ALLOWED`, `API_ACCESS_DISABLED` (per-domain API opt-in, account holder enables).
- Check: `POST /domain/checkDomain/{domain}` (`response.avail`, `price`, `additional.renewal.price`,
  …; 10 checks / 10 s) and batch `POST /domain/checkDomain` `{ domains[] }` (≤ 25; 200 / 60 s).
  Pricing table `/pricing/get` (USD strings). Requirements per TLD
  `/domain/getRegistrationRequirements/{tld}` (`apiRegisterable`, `registrationDurationYears`,
  `registryRequirements`, …).
- Register: `POST /domain/create/{domain}` `{ cost (integer cents, must equal the current minimum-term
  price), agreeToTerms: "yes", whoisPrivacy, dryRun? }`, header `Idempotency-Key` (24 h replay;
  409 `IDEMPOTENCY_KEY_MISMATCH` / `_IN_USE`). No contact fields (the account's contact is used —
  **confirm live**); registers the registry-minimum term (usually 1 year). Synchronous: `domain`,
  `cost`, `orderId`, `balance`. Prepaid credit by default; `MONTHLY_SPEND_LIMIT_EXCEEDED` ($100
  default), `ORDER_TOO_LARGE` ($100), `INSUFFICIENT_FUNDS` (`cost`, `balance`, `shortfall`);
  premium names not via API; 1 attempt/s.
- Nameservers `GET /domain/getNs/{domain}` → `ns[]`; `POST /domain/updateNs/{domain}` `{ ns[] }`.
- DNS records `/dns/retrieve/{domain}` → `records[]` (`id`, `name`, `type`, `content`, `ttl`,
  `prio`; A, AAAA, CNAME, MX, TXT, SRV, CAA, ALIAS; SOA and Porkbun NS excluded).
- Domains `/domain/listAll`, `/domain/get/{domain}` (`expireDate`, `autoRenew`, `securityLock`,
  `whoisPrivacy`, `apiAccess`); `POST /domain/updateAutoRenew/{domain}` `{ status }`.
- DNSSEC: `/dns/getDnssecRecords/{domain}`, `POST /dns/createDnssecRecord/{domain}` `{ keyTag, alg,
  digestType, digest }`, `POST /dns/deleteDnssecRecord/{domain}/{keytag}`.
- Official MCP server (`/mcp`, `/mcp/no-purchases`) — not used for mutations (constitution VIII).

## Namecheap API (https://www.namecheap.com/support/api/, knowledgebase article 9739)

- Every call: `ApiUser`, `ApiKey`, `UserName`, `ClientIp` (IPv4 of the caller, must be
  whitelisted), `Command`; production `https://api.namecheap.com/xml.response`, sandbox
  `https://api.sandbox.namecheap.com/xml.response` (separate account at sandbox.namecheap.com).
  POST recommended. XML envelope `ApiResponse Status="OK|ERROR"` with `Errors`, `Warnings`,
  `CommandResponse`. IP errors 1011150 / 1017150 (message text **confirm live**).
- Eligibility to enable API access: 20+ domains, or $50+ balance, or $50+ spent in 2 years; at
  least one whitelisted IPv4. Rate limit 50/min, 700/hour, 8000/day per key.
- `domains.check` `DomainList` (≤ 50) → `DomainCheckResult` (`Available`, `IsPremiumName`,
  `PremiumRegistrationPrice`, …). `users.getPricing` (`ProductType=DOMAIN`, `ActionName=REGISTER|
  RENEW`, `ProductName=<tld>`) → `Price` (`Duration`, `Price`, `RegularPrice`, `Currency`).
  `users.getBalances` → `AvailableBalance`, `Currency`, `FundsRequiredForAutoRenew`.
- `domains.create`: `DomainName`, `Years`, and full Registrant/Tech/Admin/AuxBilling contacts on
  every call (no default-contact option); optional `Nameservers` (comma-separated; can set
  Cloudflare's at registration), `AddFreeWhoisguard`/`WGEnabled`, `IsPremiumDomain`/`PremiumPrice`;
  ExtendedAttributes required for .us, .eu, .ca, .co.uk, .de, .fr, .es, .com.au, … Synchronous
  (`Registered`, `ChargedAmount`, `DomainID`, `OrderID`, `NonRealTimeDomain` → pending when true).
  Errors: 2515610 prices do not match, 3019166/4019166 not available, 2015182 invalid phone.
- Address book: `users.address.getList` → `AddressId`; `users.address.getInfo` → name, address,
  `Zip`, `Country`, `Phone` (e.g. `91.1111111111`), `EmailAddress`, `Default_YN`. OpsCrew uses the
  default address as all four contacts (ADR 0009).
- Nameservers `domains.dns.setCustom` (`SLD`, `TLD`, `Nameservers`), `domains.dns.getList`
  (`IsUsingOurDNS`, `Nameserver`). Records `domains.dns.getHosts` (`Name`, `Type`, `Address`,
  `MXPref`, `TTL`; error 2030288 when not using Namecheap DNS).
- `domains.getList` (`Expires`, `IsLocked`, `AutoRenew`, `WhoisGuard`, `IsOurDNS`; dates
  MM/DD/YYYY), `domains.getInfo`, `domains.setRegistrarLock`. **No API for auto-renew and none for
  DNSSEC** — OpsCrew points to the dashboard.

## GoDaddy Domains API v3 (https://developer.godaddy.com/doc/endpoint/domains, openapi/domains-v3.json)

- Personal Access Token as `Authorization: Bearer`; `https://api.godaddy.com` (no separate test
  server for v3 per the quickstart; OTE for v3 **not verified**). Production access rules for
  availability/purchase are documented inconsistently (50+ domains or ~$20/month; billing method
  for paid writes) — preflight and plain 403 handling.
- Check `GET /v3/domains/check-availability?domain=` (`available`, `definitive`, `inventory`,
  `prices[] { period, price, renewalPrice, firstTermPrice }`; indicative); batch POST (≤ 25).
- Quote `POST /v3/domains/registration-quotes` `{ domain, period, profileId | profile }` →
  `quoteToken`, `expiresAt`, locked `price`, `requiredAgreements`; 422 when contacts are missing.
- Register `POST /v3/domains/registrations` `{ domain, period, quoteToken, consent { agreementTypes,
  agreedAt } }`, header `Idempotency-Key` (16–64 chars) → 202, poll
  `/v3/domains/registrations/{id}` (`CONFIRMED`, `EXECUTING`, `COMPLETED`, `FAILED`). Contacts come
  from a saved profile (`profileId`); v3 cannot list saved profiles, and without `profileId` GoDaddy
  uses the account's default profile, then the account's own details (OpenAPI, confirmed in T704).
  OpsCrew never sends an inline profile with contact data. Prices are integers in minor units, each
  the total for its term; auto-renew and privacy can only be set in an inline profile (dashboard
  instead); the nameserver update also takes an `Idempotency-Key`; .us/.ca/.eu are
  `UNSUPPORTED_TLD` in v3.0; a suggestions endpoint exists.
- Nameservers `PUT /v3/domains/domain-names/{domain}/nameservers` (2–13, async 202); details
  `GET /v3/domains/domain-names/{domain}` (`expiresAt`, `autoRenew`, `privacy`, `nameServers`,
  `transferLock`). Records `GET /v3/domains/zones/{zone}/dns-records`. Auto-renew update and DNSSEC
  in v3 **not verified** (dashboard fallback).

## Cloudflare (https://developers.cloudflare.com/api/)

- `POST /zones` returns `name_servers[]` and `status` (`pending` until the nameservers point at
  Cloudflare). `PUT /zones/{id}/activation_check` re-checks (every 5 min paid, hourly free zones).
- Copy records: `POST /zones/{id}/dns_records/batch` (`posts[]`, one transaction) or
  `POST /zones/{id}/dns_records/import` (BIND file). The old `/dns_records/scan` is deprecated in
  favour of `/scan/trigger` + `/scan/review`.
- DNSSEC for another registrar: `PATCH /zones/{id}/dnssec` → `key_tag`, `algorithm`, `digest_type`,
  `digest`, `ds` to add at the registrar.
- Public IPv4 of this computer (Namecheap `ClientIp`): `https://www.cloudflare.com/cdn-cgi/trace`
  (`ip=` line), overridable with `NAMECHEAP_CLIENT_IP`.
