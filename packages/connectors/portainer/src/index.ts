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
  type ApplyStackResult,
  applyStackPlan,
  StackApplyError,
} from "./apply";
export {
  type ContainerSummary,
  type DockerInfo,
  type EnvPair,
  type GitStackInput,
  PORTAINER_REQUEST_TIMEOUT_MS,
  PortainerApiError,
  type PortainerClient,
  type PortainerClientDeps,
  type PortainerEnvironment,
  type PortainerUser,
  type PortainerVersionInfo,
  portainerClient,
  type RegistryEntry,
  type RegistrySummary,
  type StackDetails,
  type StringStackInput,
  type VolumeSummary,
} from "./client";
export {
  type EnvironmentKind,
  MIN_COMPOSE_VERSION,
  MIN_PORTAINER_VERSION,
  type PortainerEnvironmentFacts,
  type PortainerFacts,
  type PortainerFinding,
  type PortainerFindingCode,
  type PortainerStackFacts,
} from "./facts";
export { normalizeCertFingerprint, sameCertFingerprint } from "./fingerprint";
export { inspectPortainer } from "./inspect";
export {
  COMPOSE_PROJECT_LABEL,
  DEPLOY_BRANCH,
  DEPLOY_COMPOSE_FILE,
  DEPLOY_REFERENCE,
  type OpsCrewNames,
  opscrewNames,
  opscrewStackNames,
} from "./names";
export {
  type CertificateDetails,
  fetchCertificateFingerprint,
  inspectCertificate,
  type PinnedRequest,
  type PinnedRequestInit,
  type PinnedResponse,
  PortainerCertificateError,
  type PortainerEndpoint,
  type PortainerTarget,
  parsePortainerEndpoint,
  pinnedRequest,
  type TlsConnect,
} from "./pinned";
export {
  type CreatedRecord,
  CreatedRecordSchema,
  composeVariables,
  type DesiredStacks,
  type DesiredValueFingerprints,
  planStacks,
  planStackTeardown,
  STACK_CHANGE_IDS,
  STACK_PLAN_SCHEMA_VERSION,
  type StackChange,
  type StackChangeId,
  type StackParamValue,
  type StackPlan,
  StackPlanSchema,
  stackPlanHash,
} from "./plan";
export { valueFingerprints } from "./values";
