import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { type Duplex, PassThrough, pipeline, Readable } from "node:stream";
import type { DockerTransport, StreamProcess } from "@opscrew/contracts";
import { errorMessage, isUserFacingError, OpsCrewError, Redactor } from "@opscrew/core";

/**
 * The `net.Socket` methods Node's keep-alive agent calls on a connection. A process's pipes have
 * no keep-alive or timeout to set, and stay open until the transport closes them.
 */
const SOCKET_METHODS = { ref() {}, unref() {}, setKeepAlive() {}, setTimeout() {} };

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

const redactor = new Redactor();

/**
 * Why `child`'s connection failed `when` (before or during Docker's answer) with `error`: what the
 * process last said on stderr, redacted.
 */
async function closedConnection(
  child: StreamProcess,
  error: Error,
  when: "before it answered" | "during its answer",
): Promise<Error> {
  child.kill();
  let stderr: string;
  try {
    ({ stderr } = await child.exit);
  } catch (failure) {
    // The program never started, and its error says why.
    return failure as Error;
  }
  const said = redactor.redact(stderr.trim().split("\n").at(-1)?.trim() ?? "");
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `The connection to Docker closed ${when}: ${(said || errorMessage(error)).replace(/\.$/, "")}.`,
    {
      hint: "Check that you can log in to the server with SSH and that Docker runs there, then try again.",
    },
  );
}

/**
 * A `DockerTransport` speaking HTTP/1.1 over processes that `open` starts, each a byte pipe to the
 * Docker API, such as `ssh … docker system dial-stdio`. A request reuses an idle process, or opens
 * one when all are busy (a volume's archive holds its process while it streams). Bodies stream
 * both ways and no timeout applies. `close` ends every process.
 */
export function dialStdioTransport(open: () => StreamProcess): DockerTransport {
  const processes = new Set<StreamProcess>();
  const byStream = new WeakMap<Duplex, StreamProcess>();

  class DialAgent extends Agent {
    override createConnection(): Duplex {
      const child = open();
      processes.add(child);
      // A process that exited leaves its stream half open: destroy it, so the agent never hands
      // it to the next request.
      child.exit.then(
        () => {
          processes.delete(child);
          child.stream.destroy();
        },
        () => processes.delete(child),
      );
      byStream.set(child.stream, child);
      // A connection that failed or closed is of no further use: end its process.
      child.stream.on("error", () => child.kill());
      child.stream.on("close", () => child.kill());
      return Object.assign(child.stream, SOCKET_METHODS);
    }
  }
  const agent = new DialAgent({ keepAlive: true });

  return {
    request: (request) =>
      new Promise((resolve, reject) => {
        let child: StreamProcess | undefined;
        const outgoing = httpRequest({
          agent,
          host: "docker",
          method: request.method,
          path: request.path,
          headers: request.headers ?? {},
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        outgoing.on("socket", (socket) => {
          child = byStream.get(socket);
        });
        outgoing.on("response", (response) => {
          // The answer streams through `body`, so that a process dying during it fails in plain
          // words, and a reader that stops early ends the connection.
          const body = new PassThrough();
          response.on("error", (error) => {
            response.unpipe(body);
            const failure =
              child === undefined || request.signal?.aborted
                ? Promise.resolve(error)
                : closedConnection(child, error, "during its answer");
            // As Node's own answer does, it fails with an error only when someone listens for one
            // (an answer left unread when the transport closes just ends).
            void failure.then((plain) =>
              body.destroy(body.listenerCount("error") > 0 ? plain : undefined),
            );
          });
          body.on("close", () => {
            if (!response.complete) response.destroy();
          });
          response.pipe(body);
          resolve({
            status: response.statusCode ?? 0,
            headers: flatHeaders(response.headers),
            body,
          });
        });
        outgoing.on("error", (error) => {
          // The body's own failure (the pipeline then aborts the request), the caller's abort or a
          // failed start says it best.
          const bodyError = request.body instanceof Readable ? request.body.errored : null;
          if (bodyError) reject(bodyError);
          else if (request.signal?.aborted || isUserFacingError(error) || child === undefined) {
            reject(error);
          } else {
            void closedConnection(child, error, "before it answered").then(reject);
          }
        });
        if (request.body instanceof Readable) pipeline(request.body, outgoing, () => {});
        else outgoing.end(request.body);
      }),

    close: async () => {
      agent.destroy();
      const open = [...processes];
      for (const child of open) child.kill();
      await Promise.allSettled(open.map((child) => child.exit));
    },
  };
}
