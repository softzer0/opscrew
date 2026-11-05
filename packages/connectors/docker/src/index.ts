/**
 * `@opscrew/connector-docker` (feature 023): a typed subset of the Docker Engine API over an
 * injected `DockerTransport`, the carrier operations that read, empty, write and hash a volume,
 * and the transport over `docker system dial-stdio` (the Docker API of a server, over SSH).
 */

export { type CarrierSource, sweepCarriers, type VolumeCarrier, volumeCarrier } from "./carrier";
export {
  type ContainerLogs,
  type ContainerMount,
  type ContainerSpec,
  DockerApiError,
  type DockerClient,
  type DockerContainer,
  type DockerVolume,
  dockerClient,
  type MountSpec,
} from "./client";
export { dialStdioTransport } from "./dial-stdio";
