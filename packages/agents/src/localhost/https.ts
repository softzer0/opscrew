/**
 * Requests to the local stack: always to 127.0.0.1, with the app's hostname in the Host header
 * and as the TLS server name (SNI), since Node and the OS do not resolve `*.localhost` on Windows
 * and macOS (research.md "Spike results" 6, 8). HTTPS trusts only OpsCrew's local CA.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

/** One request to the local stack. */
export interface LocalRequestInput {
  scheme: "http" | "https";
  /** The port on 127.0.0.1. */
  port: number;
  /** The app's hostname on this computer, sent as the Host header and the TLS server name. */
  hostname: string;
  path: string;
  /** The local CA's certificate (PEM), the only one HTTPS trusts. */
  ca?: string;
  timeoutMs: number;
}

/** What the stack answered. */
export interface LocalResponse {
  status: number;
  /** The `Location` header of a redirect. */
  location?: string;
  /** HTTPS: the certificate the edge served (its names and expiry). */
  certificate?: { subjectAltName: string; validTo: string };
}

/** A request to the local stack (injected in tests). */
export type LocalRequest = (input: LocalRequestInput) => Promise<LocalResponse>;

/** {@link LocalRequest} with `node:http` and `node:https`; the body is read and dropped. */
export const nodeLocalRequest: LocalRequest = (input) =>
  new Promise((resolve, reject) => {
    const port = input.port === (input.scheme === "https" ? 443 : 80) ? "" : `:${input.port}`;
    const options = {
      host: "127.0.0.1",
      port: input.port,
      path: input.path,
      method: "GET",
      headers: { Host: `${input.hostname}${port}` },
      timeout: input.timeoutMs,
    };
    const done = (response: import("node:http").IncomingMessage) => {
      const peer =
        input.scheme === "https"
          ? (response.socket as TLSSocket).getPeerCertificate?.()
          : undefined;
      response.resume();
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          ...(typeof response.headers.location === "string"
            ? { location: response.headers.location }
            : {}),
          ...(peer?.valid_to !== undefined
            ? { certificate: { subjectAltName: peer.subjectaltname ?? "", validTo: peer.valid_to } }
            : {}),
        }),
      );
    };
    const sent =
      input.scheme === "https"
        ? httpsRequest(
            {
              ...options,
              servername: input.hostname,
              ...(input.ca !== undefined ? { ca: input.ca } : {}),
              agent: false,
            },
            done,
          )
        : httpRequest(options, done);
    sent.on("timeout", () => sent.destroy(new Error(`no answer within ${input.timeoutMs} ms`)));
    sent.on("error", reject);
    sent.end();
  });
