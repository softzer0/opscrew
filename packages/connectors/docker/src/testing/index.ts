/**
 * Test helpers for `@opscrew/connector-docker` and the tasks that use it: an in-memory Docker
 * Engine (`FakeDocker`, a `DockerTransport`), a fake `docker system dial-stdio` (`fakeDialStdio`)
 * and a minimal tar reader.
 */

export { type FakeDialStdio, fakeDialStdio, type OpenedStream } from "./dial-stdio";
export {
  type FakeContainer,
  FakeDocker,
  type FakeFile,
  type FakeMount,
  type FakeRun,
  type FakeVolume,
} from "./fake-docker";
export { parseTar } from "./tar";
