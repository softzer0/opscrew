/** Test helpers of `@opscrew/connector-cloudflare`: a fake zone and account for `CloudflareClient`. */
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
