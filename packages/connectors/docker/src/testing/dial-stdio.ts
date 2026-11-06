import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { duplexPair } from "node:stream";
import type {
  DockerRequest,
  DockerTransport,
  StreamProcess,
  StreamRunner,
} from "@opscrew/contracts";

/** What a fake `ssh … docker system dial-stdio` was started with. */
export interface OpenedStream {
  command: string;
  args: readonly string[];
}

/** An HTTP server's handler: what `docker system dial-stdio` reaches. */
type DialHandler = (request: IncomingMessage, response: ServerResponse) => void;

/** An HTTP server's handler answering with `docker`'s API. */
function serving(docker: DockerTransport): DialHandler {
  return (request, response) => {
    const method = request.method as DockerRequest["method"];
    docker
      .request({
        method,
        path: request.url ?? "/",
        ...(method === "PUT" || method === "POST" ? { body: request } : {}),
      })
      .then(
        (answer) => {
          response.writeHead(answer.status, answer.headers);
          answer.body.pipe(response);
        },
        (error: unknown) => {
          response.writeHead(500);
          response.end(String(error));
        },
      );
  };
}

/** A {@link fakeDialStdio}: its starts, how many it killed, their exits, and `close`. */
export interface FakeDialStdio extends StreamRunner {
  readonly opened: OpenedStream[];
  readonly killed: number;
  readonly exits: Promise<unknown>[];
  /** Ends the HTTP server and its connections. */
  close(): void;
}

/**
 * A test `StreamRunner` whose every process is a byte pipe to an HTTP server answering with
 * `docker`'s API (or with `handler`), as `ssh … docker system dial-stdio` is to a server's Docker.
 * A process exits once the server closes its connection, or it is killed.
 */
export function fakeDialStdio(docker: DockerTransport | DialHandler): FakeDialStdio {
  const server: Server = createServer(typeof docker === "function" ? docker : serving(docker));
  const opened: OpenedStream[] = [];
  const exits: Promise<unknown>[] = [];
  let killed = 0;
  return {
    opened,
    exits,
    get killed() {
      return killed;
    },
    open(command, args): StreamProcess {
      opened.push({ command, args });
      const [local, remote] = duplexPair();
      server.emit("connection", remote);
      const exit = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
        remote.on("close", () => resolve({ exitCode: 0, stderr: "" }));
      });
      exits.push(exit);
      let done = false;
      return {
        stream: local,
        exit,
        kill: () => {
          if (!done) killed++;
          done = true;
          local.destroy();
          remote.destroy();
        },
      };
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
