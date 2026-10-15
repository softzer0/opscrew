# Contract: `@opscrew/connector-portainer`

Owned by T1002. Consumers (agents) import only from the package root.

```ts
import type { FetchLike } from "@opscrew/contracts";

/** How OpsCrew reaches Portainer: HTTPS with the certificate pinned, or plain HTTP to localhost. */
export interface PortainerEndpoint { url: string; certFingerprint?: string }

/** Reads the certificate's SHA-256 fingerprint without trusting it (first use; shown to the user). */
export function fetchCertificateFingerprint(url: string, deps?: { connect?: TlsConnect }): Promise<string>;

export interface PortainerClient { /* typed calls below; zod-validated; the token is redacted */ }
export function portainerClient(endpoint: PortainerEndpoint, token: string,
  deps?: { request?: PinnedRequest; redactor?: Redactor; timeoutMs?: number;
          /** Fingerprints Env values and the webhook while parsing, then drops them. */
          valueKey?: Uint8Array }): PortainerClient;

/** HMAC-SHA256(key, name + "\0" + value) per entry, hex; values never leave memory. */
export function valueFingerprints(key: Uint8Array,
  values: Readonly<Record<string, string>>): Record<string, string>;

export interface PortainerFacts { /* see data-model.md "Portainer facts" */ }
export function inspectPortainer(client: PortainerClient,
  opts: { environmentId?: number; names: readonly string[] }): Promise<PortainerFacts>;

export interface DesiredStacks {
  app: string;                       // OpsCrew stack names derive from it: opscrew-<app>, …
  environmentId: number;
  repository: { url: string; branch: "opscrew-deploy"; composeFile: "compose.yaml"; private: boolean;
                username?: string };          // default x-access-token
  envKeys: readonly string[];        // the app's variables (values supplied at apply)
  registry?: { url: "ghcr.io"; private: boolean; username?: string };  // the GitHub owner
  redeploy: "updater" | "cloudflare";
  updater?: { compose: string };     // rendered by iac-templates
  tunnelConnector?: { compose: string };
  record?: CreatedRecord;            // what OpsCrew created before: ownership, never guessed by name
  ports?: readonly number[];         // host ports the app stack publishes (checked free)
  volumes?: readonly string[];       // the app stack's volumes, each `opscrew-<app>_<name>`
  /** valueFingerprints() of the local values, so a changed value shows by key name only. */
  valueFingerprints?: { app?: Record<string, string>; updater?: Record<string, string>;
                        connector?: Record<string, string>; webhook?: string };
}

export interface StackPlan { /* see data-model.md "Stack plan"; also `record` (the record after
  apply) and `valuesDigest` (SHA-256 over the intended value fingerprints), both under the hash */ }
export function planStacks(facts: PortainerFacts, desired: DesiredStacks): StackPlan;
export function planStackTeardown(facts: PortainerFacts, record: CreatedRecord,
  opts: { deleteData: boolean; app?: string }): StackPlan;
/** SHA-256 of the canonical JSON of the plan. */
export function stackPlanHash(plan: StackPlan): string;

export interface ApplyStackOptions {
  approvedHash: string;
  secrets: { env: Readonly<Record<string, string>>; webhookId?: string; repositoryToken?: string;
             registryToken?: string; tunnelToken?: string;
             updaterEnv?: Readonly<Record<string, string>> };  // must call /api/stacks/webhooks/<webhookId>
  /** Recomputes `valuesDigest` from `secrets`; a mismatch refuses before any request. */
  valueKey?: Uint8Array;
  // tunnelToken: the Portainer connector stack's (cloudflare redeploy mode); the app stack's own
  // tunnel token (tunnel web mode) is one of its `env` values, listed in `envKeys`.
  /** Bounded wait for asynchronous deploys (default 10 minutes); clock and sleep injectable. */
  wait?: { timeoutMs?: number; intervalMs?: number; now?: () => number;
          sleep?: (ms: number) => Promise<void> };
}
export interface ApplyStackResult { applied: string[]; record: CreatedRecord }
/** Throws PLAN_HASH_MISMATCH on a hash mismatch, PHASE_PRECONDITION on a blocked change, and
 *  StackApplyError {applied, record} when a change fails part-way (the caller records `record`). */
export function applyStackPlan(client: PortainerClient, plan: StackPlan,
  opts: ApplyStackOptions): Promise<ApplyStackResult>;
```

Rules:

- Every request goes to the pinned endpoint; a certificate whose fingerprint differs fails before
  any request is sent; plain HTTP is allowed only for `localhost`/`127.0.0.1`/`::1`.
- No request is built from model output or from Portainer's own responses (ids are parsed numbers).
- Secrets (the token, `Env` values, the webhook UUID, repository/registry/tunnel tokens) are never
  logged, audited, included in plans or errors; Portainer's responses that contain `Env` values are
  parsed into keys only.
- Only stacks and registry entries recorded as OpsCrew's are changed or removed; a stack with an
  OpsCrew name that is not recorded blocks the plan.
- Updates always send the full `Env` list (leaving it out clears it).
- Values are compared only as keyed fingerprints (the key is local, 0600): a changed value, or a
  changed webhook, plans an update naming the keys, never the values. Repository and registry
  tokens cannot be read back, so replacing them is an explicit input.
- A stack in error (Status 4) plans a redeploy; a stopped stack (Status 2) plans a start.
- Volumes are deleted only in a teardown with `deleteData`, and only names `opscrew-<app>_…`
  whose Compose project label is the app's stack.
- Asynchronous deploys are polled until `Status` 1, or 4 with the reason, or the timeout; a timeout
  says what is known and what to do.
