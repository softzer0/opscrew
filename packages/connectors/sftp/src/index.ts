/**
 * @opscrew/connector-sftp: a host's files over SFTP alone (feature 027, ADR 0030 D6), through the
 * system's OpenSSH `sftp` in batch mode. `SftpFiles` implements the `HostingFiles` contract for
 * SFTP-only hosts and for Plesk, whose customer API has no file calls, and switches a link in one
 * step (`link`); `FakeSftpHost` plays the host in tests.
 */

export { isRemotePath } from "./batch";
export {
  FakeSftpHost,
  type FakeSftpNode,
  type FakeSftpOptions,
  type FakeSftpRun,
} from "./fake";
export { SftpFiles, type SftpFilesOptions, type SftpLogin } from "./files";
