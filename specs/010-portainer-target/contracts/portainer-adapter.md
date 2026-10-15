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
  deps?: { request?: PinnedRequest }): PortainerClient;

export interface PortainerFacts { /* see data-model.md "Portainer facts" */ }
export function inspectPortainer(client: PortainerClient,
  opts: { environmentId?: number; names: readonly string[] }): Promise<PortainerFacts>;

export interface DesiredStacks {
  app: string;                       // OpsCrew stack names derive from it: opscrew-<app>, …
  environmentId: number;
  repository: { url: string; branch: "opscrew-deploy"; composeFile: "compose.yaml"; private: boolean };
  envKeys: readonly string[];        // the app's variables (values supplied at apply)
  registry?: { url: "ghcr.io"; private: boolean };
  redeploy: "updater" | "cloudflare";
  updater?: { compose: string };     // rendered by iac-templates
  tunnelConnector?: { compose: string };
}

export interface StackPlan { /* see data-model.md "Stack plan" */ }
export function planStacks(facts: PortainerFacts, desired: DesiredStacks): StackPlan;
export function planStackTeardown(facts: PortainerFacts, record: CreatedRecord,
  opts: { deleteData: boolean }): StackPlan;
/** SHA-256 of the canonical JSON of the plan. */
export function stackPlanHash(plan: StackPlan): string;

export interface ApplyStackOptions {
  approvedHash: string;
  secrets: { env: Readonly<Record<string, string>>; webhookId?: string; repositoryToken?: string;
             registryToken?: string; tunnelToken?: string };
  // tunnelToken: the Portainer connector stack's (cloudflare redeploy mode); the app stack's own
  // tunnel token (tunnel web mode) is one of its `env` values, listed in `envKeys`.
  /** Bounded wait for asynchronous deploys (default 10 minutes); clock and sleep injectable. */
  wait?: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };
}
export interface ApplyStackResult { applied: string[]; record: CreatedRecord }
/** Throws PLAN_HASH_MISMATCH on a hash mismatch, PHASE_PRECONDITION on a blocked change. */
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
- Asynchronous deploys are polled until `Status` 1, or 4 with the reason, or the timeout; a timeout
  says what is known and what to do.
