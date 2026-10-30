/**
 * How OpsCrew's login becomes root on a server. On a server the user owns it is root, or it uses
 * passwordless `sudo -n`. On the servers OpsCrew creates the deploy user has no sudo, but it is in
 * the docker group, which is already root-equivalent: the `docker` privilege (ADR 0022) runs a
 * root script in a one-shot privileged container that enters the host's namespaces with busybox's
 * `nsenter` and runs the host's own `sh` on its standard input (research R5a, R5b). The image is
 * the caller's (the Caddy image OpsCrew already pins), so this package adds no image pin.
 */
import { OpsCrewError } from "@opscrew/core";
import { asRoot, pipedScript } from "./shell";

/** How the login becomes root: it is root, uses passwordless `sudo -n`, or runs Docker. */
export type HostPrivilege = "root" | "sudo" | "docker";

/** An image pinned by its digest, as `IMAGES.caddy.ref` is. */
const PINNED_IMAGE_RE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

/** The command that runs the host's `sh` as root on its standard input, in a container of `image`. */
export function dockerRootCommand(image: string): string {
  return `docker run --rm -i --privileged --pid=host --net=host --ipc=host --uts=host ${image} nsenter -t 1 -m -u -i -n -p -- sh -s`;
}

/**
 * The image the `docker` privilege runs, checked: refused plainly when the caller passed none or
 * one that is not pinned by its digest.
 */
export function requireRootImage(image: string | undefined): string {
  if (image === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "This login becomes root on the server only through Docker, and OpsCrew was given no image to run for it, so it changes nothing.",
      { hint: "This is a problem in OpsCrew; please report it." },
    );
  }
  if (!PINNED_IMAGE_RE.test(image)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The image OpsCrew runs to become root through Docker must be pinned by its digest (name@sha256:...).",
      { hint: "This is a problem in OpsCrew; please report it." },
    );
  }
  return image;
}

/** A command for the server and what goes on its standard input. */
export interface RemoteCall {
  command: string;
  input?: string;
}

/**
 * The call that runs `script` as root with `input` (its secrets) on its standard input. `root` and
 * `sudo`: `sh -c <script>`, through `sudo -n`, with `input` as it is. `docker`: the container
 * reads the script from its standard input, and `input` is piped into the script there
 * ({@link pipedScript}); the script's stdin is empty without it, as under sudo. `image` is the
 * `docker` privilege's (see {@link requireRootImage}).
 */
export function rootCall(
  privilege: HostPrivilege,
  script: string,
  input: string | undefined,
  image: string | undefined,
): RemoteCall {
  if (privilege === "docker") {
    return {
      command: dockerRootCommand(requireRootImage(image)),
      input: pipedScript(script, input ?? ""),
    };
  }
  const command = asRoot(privilege, script);
  return input === undefined ? { command } : { command, input };
}
