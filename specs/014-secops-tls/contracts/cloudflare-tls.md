# Contract: origin TLS and zone settings through the shared Cloudflare plan (014)

Owner: `packages/connectors/cloudflare` (types in T1401a, calls and plan logic in T1403).
Consumer: `packages/agents` (provision, destroy, drift, status, secure).

## Adapter calls (`CloudflareClient`)

```ts
// Origin CA (api.cloudflare.com/client/v4/certificates)
createOriginCertificate(input: { csr: string; hostnames: string[]; days: 5475 }):   // 15 years
  Promise<{ id: string; certificate: string; expiresOn: string }>;
listOriginCertificates(zoneId: string):
  Promise<{ id: string; hostnames: string[]; expiresOn: string }[]>;
revokeOriginCertificate(id: string): Promise<void>;

// Per-hostname Authenticated Origin Pulls
uploadHostnameClientCertificate(zoneId: string, pem: { certificate: string; privateKey: string }):
  Promise<{ id: string; expiresOn: string; status: string }>;
listHostnameClientCertificates(zoneId: string): Promise<{ id: string; expiresOn: string; status: string }[]>;
deleteHostnameClientCertificate(zoneId: string, id: string): Promise<void>;
putHostnameAopSettings(zoneId: string, config: { hostname: string; certId: string; enabled: boolean | null }[]):
  Promise<HostnameAop[]>;
listHostnameAopSettings(zoneId: string, hostnames: string[]): Promise<HostnameAop[]>;
// HostnameAop: { hostname, certId?, enabled, status }  (status values from the spike, T1402)

// Zone settings
getZoneSetting(zoneId: string, id: "min_tls_version"): Promise<{ value: string; editable: boolean }>;
patchZoneSetting(zoneId: string, id: "min_tls_version", value: "1.2"): Promise<void>;
```

**Guarantees:**
- Every response is parsed with zod, and an unexpected shape is an error naming the call.
- A 403 is `CloudflareError` with code `permission`, which inspection turns into the
  `tls-permission-missing` advice.
- A private key passed to `uploadHostnameClientCertificate` is registered with the redactor before
  the request, and it never appears in an error.

## Desired state and changes

```ts
interface SharedDesired {
  hostnames: Partial<Record<SharedRuleRef, string[]>>;   // as in 011
  access?: { authDomain: string; oneTimePin: boolean };  // as in 011
  tls?: {
    proxied: string[];                // the app's proxied hostnames (empty on destroy)
    served?: { originSha256?: string; requiring: string[] };   // what the origin uses now
    origin?: { csr: string };         // present only when a new origin certificate is wanted
    client?: { sha256: string };      // the client certificate to upload, if not yet at Cloudflare
  };
  minTls?: boolean;                   // provision asks for the 1.2 decision
}

type SharedChange =
  | /* 011's rule and Zero Trust kinds, unchanged */
  | { kind: "create-origin-certificate"; hostnames: string[]; csrSha256: string }
  | { kind: "revoke-origin-certificate"; id: string }
  | { kind: "upload-client-certificate"; sha256: string }
  | { kind: "enable-client-certificate"; hostnames: string[]; sha256: string }
  | { kind: "disable-client-certificate"; hostnames: string[] }
  | { kind: "delete-client-certificate"; id: string }
  | { kind: "set-min-tls"; from: "1.0"; to: "1.2" };
```

- The CSR's text is kept outside the hashed `changes`, in the plan's local part, next to
  `previous` and `record`. The hash covers its SHA-256.
- The apply receives `keys: { clientCertificate: string; clientKey: string } | undefined` and
  `csr: string | undefined` from the caller. Neither is in the plan's JSON.

**Order of the apply:**
1. `upload-client-certificate`;
2. `enable-client-certificate`, waiting until every hostname's status is active (at most 5
   minutes, then a plain error saying the setting is still deploying and to run provision again);
3. `create-origin-certificate`;
4. `disable-client-certificate`;
5. `delete-client-certificate`;
6. `revoke-origin-certificate`;
7. `set-min-tls`;
8. then 011's rule changes.

Each step's result goes into the record before the next one.

**Plan rules:**
- An origin certificate is wanted when there is none for exactly `proxied`, or when it has fewer
  than 30 days left. The new one is created, and the old one moves to `superseded`.
- **"After the server shows it":** the caller passes `served`, what the origin uses now. On
  servers it is read over SSH as `deploy` from `/srv/edge/tls/<app>/` and the site file, and on
  Portainer from the stack through its API.
  - A `superseded` certificate is revoked once `served` has the newer fingerprint.
  - A hostname in the record's `client.retiring` (one that left the proxy) is disabled once
    `served` no longer requires the client certificate for it.
  - Without `served` (the server unreachable), both wait, and the plan says so.
- `set-min-tls` is planned only when the value is `1.0`, `editable` is true, and every proxied A,
  AAAA and CNAME record in the zone carries `Managed by OpsCrew`. Otherwise the plan carries the `min-tls-advised` advice for `secure`.
- `hostname-tls-claimed`: a per-hostname AOP setting on one of `proxied` that uses a certificate
  not in this app's record. It blocks the plan, with how to free the hostname.
- `tls-permission-missing` is advice, not a finding, so it does not block 011's rules. The plan
  leaves out the TLS changes, the record gets `tls.gap: "permission"`, and the run goes on with
  today's protection.

```ts
interface SharedPlan {
  /* 011's fields, unchanged */
  advice: { code: "tls-permission-missing" | "min-tls-advised"; message: string; hint: string }[];
  // local part, outside the hash, next to `previous`, `record` and `csr`
}
```

## Record (`.opscrew/cloudflare.json`)

```ts
interface SharedRecord {
  zoneId: string;
  hostnames: Partial<Record<SharedRuleRef, string[]>>;
  createdEntrypoints: string[];
  tls?: {
    origin?: { id: string; hostnames: string[]; expiresAt: string; sha256: string; superseded: string[] };
    client?: { id: string; expiresAt: string; sha256: string; enabled: string[]; retiring: string[] };
    gap?: "permission";
  };
  zoneSettings?: { minTlsVersion?: { setAt: string; previous: "1.0" } };
}
```

The schema stays strict. A record without `tls` is valid, and means the app has no origin TLS yet.
