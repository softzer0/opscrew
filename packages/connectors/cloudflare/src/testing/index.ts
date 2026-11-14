/**
 * Test helpers of `@opscrew/connector-cloudflare` for `CloudflareClient`: a fake zone and account,
 * and a fake Cloudflare with several accounts, each reached by its own token.
 */
export type {
  FakeAccessItem,
  FakeBucket,
  FakeCloudflareAccount,
  FakeScript,
  FakeServiceToken,
  FakeTunnel,
  FakeTunnelConnection,
} from "./fake-account-pieces";
export {
  type FakeCertificatePack,
  type FakeCloudflareAccounts,
  type FakeCloudflareAccountsOptions,
  type FakeCloudflareCall,
  type FakeCloudflarePermission,
  type FakeCloudflareToken,
  type FakeCloudflareZone,
  type FakeDnsRecord,
  type FakeRecordInput,
  type FakeZoneStatus,
  fakeCloudflareAccounts,
} from "./fake-accounts";
export {
  FAKE_VISITOR_IP,
  FakeTailSocket,
  type FakeWorkerFigures,
  type FakeWorkerRequest,
} from "./fake-observability";
export {
  FAKE_ACCOUNT_ID,
  FAKE_ZONE_ID,
  type FakeClientCertificate,
  type FakeHostnameAop,
  type FakeOriginCertificate,
  type FakeWorker,
  type FakeWorkerDeployment,
  type FakeWorkerDomain,
  type FakeWorkerVersion,
  FakeZone,
} from "./fake-zone";
export type { FakeFault } from "./replies";
