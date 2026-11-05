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

/** An HTTP server answering with `docker`'s API: what `docker system dial-stdio` reaches. */
function serving(docker: DockerTransport) {
  return (request: IncomingMessage, response: ServerResponse) => {
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

/**
 * A test `StreamRunner` whose every process is a byte pipe to `docker`'s API, as `ssh … docker
 * system dial-stdio` is to a server's Docker. `opened` lists each start; `close` ends the server.
 */
export function fakeDialStdio(
  docker: DockerTransport,
): StreamRunner & { opened: OpenedStream[]; close(): void } {
  const server: Server = createServer(serving(docker));
  const opened: OpenedStream[] = [];
  return {
    opened,
    open(command, args): StreamProcess {
      opened.push({ command, args });
      const [local, remote] = duplexPair();
      server.emit("connection", remote);
      const exit = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
        remote.on("close", () => resolve({ exitCode: 0, stderr: "" }));
      });
      return {
        stream: local,
        exit,
        kill: () => {
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
