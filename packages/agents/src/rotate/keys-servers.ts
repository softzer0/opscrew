/**
 * The servers an SSH key opens (plan.md 5.) and the change of the deploy user's authorized_keys on
 * them: the new public half appended beside the old, then the old one's line removed, each over
 * SSH as deploy. Lines are written exactly as cloud-init and the host plan write them.
 */
import { checkKeyLine, previewKeyLine } from "@opscrew/connector-ssh-host";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { shellQuote } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { otherPlans } from "../check/files";
import { checkReachesOverSsh } from "../check/provision";
import type { PhaseDeps } from "../context";
import { previewServer } from "../previews/host";
import { appServerShell, serverLogin, serverWords } from "../shared/server-address";
import { extraServers, targetOf } from "../shared/servers";
import { bareKey, type SshKeyName } from "./keys-files";

/** A server that holds the key, with the environment it belongs to. */
export interface KeyHolder {
  /** The rotation's deps with the paths of the server's environment (its logins and deploy key). */
  deps: PhaseDeps;
  /** That environment's plan. */
  plan: DeployPlan;
  /** `app` or an extra server's name. */
  server: string;
  /**
   * `ssh`: the deploy user's authorized_keys changed over SSH; `host-plan`: the deploy key on a
   * server the user owns, through its setup host plan (ADR 0011).
   */
  via: "ssh" | "host-plan";
  /** The server in words: `the app's server`, `server data of staging`. */
  words: string;
}

/** The rotation's own environment and app, which a holder's words leave out. */
interface Rotation {
  environment: string;
  app: string;
}

/**
 * `server` of `plan` (`deps` with the paths of its environment), named with its app and
 * environment where they are not the rotation's: `the app's server of shop-admin staging`.
 */
function holder(
  deps: PhaseDeps,
  plan: DeployPlan,
  server: string,
  which: SshKeyName,
  rotation: Rotation,
): KeyHolder {
  const own = targetOf(plan, server)?.provider === "own";
  const environment = deps.paths.environment;
  const of = [
    ...(plan.app.name === rotation.app ? [] : [plan.app.name]),
    ...(environment === rotation.environment ? [] : [environment]),
  ];
  return {
    deps,
    plan,
    server,
    via: which === "deploy-key" && own ? "host-plan" : "ssh",
    words: `${serverWords(server)}${of.length === 0 ? "" : ` of ${of.join(" ")}`}`,
  };
}

/** True for a server OpsCrew logs in to with the deploy key: one it created, or the user's own. */
function hasServer(plan: DeployPlan, server: string): boolean {
  const provider = targetOf(plan, server)?.provider;
  return provider === "hetzner" || provider === "digitalocean" || provider === "own";
}

/**
 * Every server `which` opens: the deploy key every server of the environment; the check key (the
 * repository's) every server whose disk the check reads over SSH, in each environment and app with
 * the check on; the preview key the preview server (another environment's, when shared).
 */
export async function keyHolders(
  deps: PhaseDeps,
  plan: DeployPlan,
  which: SshKeyName,
): Promise<KeyHolder[]> {
  const current = { environment: deps.paths.environment, app: plan.app.name };
  if (which === "preview-key") {
    const server = await previewServer(deps, plan);
    return [holder(server.deps, server.plan, APP_SERVER, which, current)];
  }
  if (which === "deploy-key") {
    return [APP_SERVER, ...extraServers(plan)]
      .filter((server) => hasServer(plan, server))
      .map((server) => holder(deps, plan, server, which, current));
  }
  const entries = [{ plan, paths: deps.paths }, ...(await otherPlans(deps.paths, plan))];
  return entries
    .filter(
      (entry) =>
        entry.plan.observability?.check?.enabled === true &&
        entry.plan.deployment.destroyedAt === undefined,
    )
    .flatMap((entry) =>
      [...(checkReachesOverSsh(entry.plan) ? [APP_SERVER] : []), ...extraServers(entry.plan)].map(
        (server) => holder({ ...deps, paths: entry.paths }, entry.plan, server, which, current),
      ),
    );
}

/**
 * The key's line in the deploy user's authorized_keys for `publicKey`: the deploy key's public
 * line as it is, the check key's and the preview key's restricted lines (`checkKeyLine`,
 * `previewKeyLine`) of `repository` (`owner/repo`).
 */
export function keyLine(
  which: SshKeyName,
  publicKey: string,
  repository: string,
  plan: DeployPlan,
): string {
  if (which === "check-key") return checkKeyLine(bareKey(publicKey), repository);
  if (which === "preview-key") return previewKeyLine(bareKey(publicKey), repository, plan.app.name);
  return publicKey.trim();
}

/** Exit code of a script that found authorized_keys a symbolic link. */
const LINKED = 3;
/** Exit code of a removal that did not find the new key's line. */
const NEW_MISSING = 4;

const KEYS = `k="$HOME/.ssh/authorized_keys"
if [ -L "$HOME/.ssh" ] || [ -L "$k" ]; then echo "authorized_keys is a symbolic link; OpsCrew does not follow it." >&2; exit ${LINKED}; fi`;

/**
 * The script that appends `line` to the deploy user's authorized_keys unless it holds it already
 * (after a newline when the file's last line has none); every other line stays.
 */
export function addKeyScript(line: string): string {
  return `set -u
line=${shellQuote(line)}
${KEYS}
if [ -f "$k" ] && grep -qxF -- "$line" "$k"; then exit 0; fi
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || exit 1
if [ -s "$k" ] && [ -n "$(tail -c 1 "$k")" ]; then printf '\\n' >> "$k" || exit 1; fi
printf '%s\\n' "$line" >> "$k" && chmod 600 "$k"
`;
}

/**
 * The script that rewrites the deploy user's authorized_keys without the lines holding `old`
 * (`<type> <base64>`), only while it holds `keep`, the new key's line: it never leaves the server
 * without the key that proved itself.
 */
export function removeKeyScript(old: string, keep: string): string {
  return `set -u
old=${shellQuote(old)}
keep=${shellQuote(keep)}
${KEYS}
[ -f "$k" ] && grep -qxF -- "$keep" "$k" || { echo "The new key is not in authorized_keys, so OpsCrew kept the old one." >&2; exit ${NEW_MISSING}; }
grep -qF -- "$old" "$k" || exit 0
t=$(mktemp "$k.XXXXXX") || exit 1
if ! grep -vF -- "$old" "$k" > "$t"; then rm -f "$t"; exit 1; fi
chmod 600 "$t" && mv -f "$t" "$k"
`;
}

/** The test seam: the deploy user's shell at `host` with the private key file `keyFile`. */
export type KeyRemote = (host: string, keyFile: string) => RemoteExec;

/**
 * The deploy user's shell on `holder`'s server with the private key `keyFile`, at the address its
 * environment logs in to (the private one once public SSH is closed); its address is registered
 * with the redactor.
 */
export async function holderShell(
  holder: KeyHolder,
  keyFile: string,
  remote: KeyRemote | undefined,
): Promise<RemoteExec> {
  const { deps, plan, server } = holder;
  const login = await serverLogin(deps, plan, server);
  deps.redactor.addName(login.host, "server-address");
  const withKey = {
    ...deps,
    paths: { ...deps.paths, files: { ...deps.paths.files, deployKey: keyFile } },
  };
  return appServerShell(
    withKey,
    plan,
    { host: login.host, port: login.port },
    remote === undefined ? {} : { remote: (host) => remote(host, keyFile) },
    server,
  );
}

/**
 * Runs `script` on `holder`'s server as deploy over `shell`.
 * @throws OpsCrewError `COMMAND_FAILED` naming the server and what it said, never a key.
 */
export async function runKeyScript(
  holder: KeyHolder,
  shell: RemoteExec,
  script: string,
  what: string,
): Promise<void> {
  const result: CommandResult = await shell.run(script, { timeoutMs: 60_000 });
  if (result.exitCode === 0) return;
  const said = holder.deps.redactor.redact(result.stderr.trim().split(/\r?\n/).slice(-2).join(" "));
  throw new OpsCrewError(
    "COMMAND_FAILED",
    result.exitCode === 255 || result.timedOut === true
      ? `${holder.words} did not answer over SSH, so OpsCrew could not ${what}.`
      : `OpsCrew could not ${what} on ${holder.words} (exit code ${result.exitCode})${said === "" ? "." : `: ${said}`}`,
    { hint: "Check that the server is on and reachable (`opscrew status`)." },
  );
}
