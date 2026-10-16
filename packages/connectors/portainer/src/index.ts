/**
 * @opscrew/connector-portainer: the adapter for a Portainer the user already runs (feature 010):
 * a certificate-pinned client, read-only inspection, stack plans approved by hash (`stack-apply`)
 * and their apply and teardown. See `specs/010-portainer-target/contracts/portainer-adapter.md`.
 *
 * Certificate fingerprints are returned and compared in one canonical form: `SHA256:` and the 32
 * digest bytes as upper-case hex pairs separated by colons (`SHA256:AB:CD:…`), as Node's
 * `fingerprint256` and `openssl x509 -fingerprint -sha256` show them.
 */

export {
  type ApplySecrets,
  type ApplyStackOptions,
  applyStackPlan,
  StackApplyError,
} from "./apply";
export {
  type DockerInfo,
  PortainerApiError,
  type PortainerClient,
  type PortainerClientDeps,
  type PortainerEnvironment,
  portainerClient,
} from "./client";
export type { PortainerFacts, PortainerStackFacts } from "./facts";
export { normalizeCertFingerprint, sameCertFingerprint } from "./fingerprint";
export { dockerArchitecture, environmentKind, inspectPortainer } from "./inspect";
export {
  COMPOSE_PROJECT_LABEL,
  DEPLOY_BRANCH,
  DEPLOY_COMPOSE_FILE,
  DEPLOY_REFERENCE,
  opscrewNames,
  opscrewStackNames,
} from "./names";
export {
  type CertificateDetails,
  fetchCertificateFingerprint,
  inspectCertificate,
  type PinnedRequest,
  type PinnedRequestInit,
  PortainerCertificateError,
  type PortainerEndpoint,
  pinnedRequest,
  type TlsConnect,
} from "./pinned";
export {
  type CreatedRecord,
  CreatedRecordSchema,
  type DesiredStacks,
  type DesiredValueFingerprints,
  planStacks,
  planStackTeardown,
  type StackChange,
  type StackPlan,
  stackPlanHash,
} from "./plan";
export { valueFingerprint, valueFingerprints } from "./values";
