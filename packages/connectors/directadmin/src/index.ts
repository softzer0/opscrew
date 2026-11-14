/**
 * @opscrew/connector-directadmin: a DirectAdmin user account reached with a login key, as a
 * `HostingPanel` (feature 027, ADR 0030), and an in-memory fake of one for agents' tests.
 */

export {
  FakeDirectAdmin,
  type FakeDirectAdminCall,
  type FakeDirectAdminCertificate,
  type FakeDirectAdminEntry,
  type FakeDirectAdminFailure,
  type FakeDirectAdminOptions,
} from "./fake";
export { DIRECTADMIN_OPERATIONS, DirectAdminPanel } from "./panel";
