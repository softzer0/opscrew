/**
 * Test helpers for `@opscrew/connector-docker` and the tasks that use it: an in-memory Docker
 * Engine (`FakeDocker`, a `DockerTransport`) and a minimal tar writer and reader.
 */

export {
  type FakeContainer,
  FakeDocker,
  type FakeFile,
  type FakeRun,
  type FakeVolume,
} from "./fake-docker";
export { parseTar, type TarEntry, tarStream } from "./tar";
