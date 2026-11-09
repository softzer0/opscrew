/**
 * Pure helpers of feature 025's live passes (`rotation*.test.ts`, docs/e2e.md "Credential
 * rotation"): which passes `OPSCREW_E2E_ROTATION` selects and what each needs, what the tests read
 * in OpsCrew's output (the hashes a rotation asks to approve, the windows its plan states,
 * `rotate --json`), the record of the rotations, the scripts that log in to a service with a value
 * on their standard input, the cookie jar of the session checks, the Laravel routes the app pass
 * adds, the prompts a rotation in a terminal asks, the pty that runs it, and Cloudflare's answers
 * about a tunnel's connections and a Worker version's secrets. No network, no processes;
 * unit-tested in `rotation-support.test.ts`.
 */
import { stripVTControlCharacters } from "node:util";
import { pinnedVersion, serviceSpec } from "@opscrew/iac-templates";
import {
  type CredentialsRecord,
  type DeployPlan,
  type PlanService,
  PlanServiceSchema,
  REDIS_PROTOCOL_KINDS,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { ENVIRONMENT_E2E_VARIABLES } from "./environments-support";
import { GITHUB_PAGES_VARIABLES } from "./serverless-support";

// ---------------------------------------------------------------------------------------------
// The passes and their variables.

/** The passes' gate: a comma list of the passes to run (`services,keys`). */
export const ROTATION_GATE = "OPSCREW_E2E_ROTATION";

/** With the restore pass, `1` also runs the whole-server restore after a rotation (T2520). */
export const SERVER_RESTORE_GATE = "OPSCREW_E2E_ROTATION_SERVER_RESTORE";

/**
 * With the tunnel pass on a computer without `script` (Windows), `1` has the pass wait for the
 * tunnel token's rotation run by hand in a terminal, from the launcher it writes.
 */
export const TERMINAL_GATE = "OPSCREW_E2E_ROTATION_TERMINAL";

/** Every pass, in the order the docs list them. */
export const ROTATION_PASSES = [
  "services",
  "keys",
  "app",
  "tunnel",
  "restore",
  "own",
  "portainer",
  "addons",
  "sites",
] as const;
export type RotationPass = (typeof ROTATION_PASSES)[number];

/** The Worker's part of the sites pass: one throwaway repository, and the deploy token. */
const WORKER_VARIABLES = [
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** What each pass needs besides being named in the gate. */
export const PASS_VARIABLES: Readonly<Record<RotationPass, readonly string[]>> = {
  services: ENVIRONMENT_E2E_VARIABLES,
  keys: ENVIRONMENT_E2E_VARIABLES,
  app: ENVIRONMENT_E2E_VARIABLES,
  tunnel: ENVIRONMENT_E2E_VARIABLES,
  restore: ENVIRONMENT_E2E_VARIABLES,
  own: ENVIRONMENT_E2E_VARIABLES,
  portainer: [...ENVIRONMENT_E2E_VARIABLES, "OPSCREW_E2E_GHCR_READ_TOKEN"],
  addons: ENVIRONMENT_E2E_VARIABLES,
  sites: WORKER_VARIABLES,
};

/** The GitHub Pages part of the sites pass: the public throwaway repository C. */
export const PAGES_VARIABLES = GITHUB_PAGES_VARIABLES;

/** The passes the gate's value names, and the names in it that are no pass. */
export function selectedPasses(value: string | undefined): {
  passes: RotationPass[];
  unknown: string[];
} {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const known = (name: string): name is RotationPass =>
    (ROTATION_PASSES as readonly string[]).includes(name);
  return { passes: names.filter(known), unknown: names.filter((name) => !known(name)) };
}

/**
 * Why `pass` does not run (its title says it), or `undefined` when it does: the gate without it,
 * then each of `variables` that is not set.
 */
export function passSkip(
  env: Record<string, string | undefined>,
  pass: RotationPass,
  variables: readonly string[] = PASS_VARIABLES[pass],
): string | undefined {
  const missing = [
    ...(selectedPasses(env[ROTATION_GATE]).passes.includes(pass)
      ? []
      : [`${ROTATION_GATE}=${pass}`]),
    ...variables.filter((name) => (env[name] ?? "").trim() === ""),
  ];
  return missing.length === 0 ? undefined : `set ${missing.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------
// The plans and the values.

/**
 * `plan` with each service of `added` (name → kind) it does not have yet, as a user adds services
 * to `services` in plan.yaml before design runs again: the catalog's pinned version and default
 * memory, and an engine on Redis's protocol as a cache.
 */
export function withServices(
  plan: DeployPlan,
  added: Readonly<Record<string, PlanService["kind"]>>,
): DeployPlan {
  const services = Object.entries(added)
    .filter(([name]) => !plan.services.some((service) => service.name === name))
    .map(([name, kind]) => {
      const spec = serviceSpec(kind);
      return PlanServiceSchema.parse({
        name,
        kind,
        version: pinnedVersion(spec),
        memoryMb: spec.memory.defaultMb,
        ...((REDIS_PROTOCOL_KINDS as readonly string[]).includes(kind)
          ? { options: { mode: "cache" } }
          : {}),
        reason: "Added in plan.yaml by the credential rotation live test.",
        licence: spec.licence.id,
      });
    });
  return { ...plan, services: [...plan.services, ...services] };
}

/**
 * `plan` with the app's bucket in Garage on its server (`storage.objectStorage.provider`), as the
 * guide tells a user to choose it; design adds the Garage service. Throws without a bucket.
 */
export function withGarageBucket(plan: DeployPlan): DeployPlan {
  const bucket = plan.storage?.objectStorage;
  if (bucket === undefined) throw new Error("The plan has no bucket to keep in Garage.");
  return {
    ...plan,
    storage: { ...plan.storage, objectStorage: { ...bucket, provider: "garage" } },
  };
}

/**
 * The string at `path` in OpsCrew's generated values (`["services", "db", "password"]`); throws,
 * naming the path only, when there is none.
 */
export function generatedSecret(json: unknown, path: readonly string[]): string {
  let at: unknown = json;
  for (const key of path) {
    at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
  }
  if (typeof at !== "string" || at === "") {
    throw new Error(`OpsCrew's generated values hold no ${path.join(".")}.`);
  }
  return at;
}

/** Whether `plan` has the app variable `name` with a value OpsCrew generates. */
export function generatesVariable(plan: Pick<DeployPlan, "app">, name: string): boolean {
  return plan.app.env.some((variable) => variable.name === name && variable.source === "generated");
}

// ---------------------------------------------------------------------------------------------
// What a rotation printed.

/**
 * Every distinct hash a run asks to approve, in order: after `Rotation hash:`, `Undo hash:`, an
 * infrastructure plan's `Plan hash:`, a `Host plan hash:` or a `Stack plan hash:`, and in a
 * printed `--approve <hash>`.
 */
export function rotationHashes(output: string): string[] {
  const hashes: string[] = [];
  const pattern =
    /(?:(?:Rotation|Undo|Plan|Host plan|Stack plan) hash: |--approve )([0-9a-f]{64})\b/g;
  for (const [, hash] of output.matchAll(pattern)) {
    if (hash !== undefined && !hashes.includes(hash)) hashes.push(hash);
  }
  return hashes;
}

/**
 * The longest time a rotation's plan says new connections of the running app fail (a swap's
 * "fail for about N seconds", a restart's "about N seconds in all", a seamless service that
 * restarts "about N seconds, answering no one"): 0 when every change is seamless.
 */
export function statedWindowSeconds(output: string): number {
  const patterns = [
    /fail for about (\d+) seconds/g,
    /about (\d+) seconds in all/g,
    /about (\d+) seconds, answering no one/g,
  ];
  let longest = 0;
  for (const pattern of patterns) {
    for (const [, seconds] of output.matchAll(pattern)) {
      longest = Math.max(longest, Number(seconds));
    }
  }
  return longest;
}

/** The seconds a window may run over what the plan states, which says "about". */
export const WINDOW_SLACK_SECONDS = 15;

/**
 * The gap the tunnel token's rotation may leave with one connector, as its plan says ("a few
 * seconds"): one restart and reconnect of cloudflared.
 */
export const TUNNEL_GAP_SECONDS = 30;

/**
 * Accepts the failed requests of a load within one window of `seconds` (and
 * {@link WINDOW_SLACK_SECONDS}) after the first failure it is asked about: the reason, or
 * `undefined` for one outside it, which then counts. With `seconds` 0 nothing is accepted.
 */
export function windowAcceptor(seconds: number): (at: string) => string | undefined {
  let first: number | undefined;
  return (at) => {
    if (seconds <= 0) return undefined;
    const time = Date.parse(at);
    first ??= time;
    const after = (time - first) / 1000;
    return after <= seconds + WINDOW_SLACK_SECONDS
      ? `within the window of about ${seconds} seconds the plan states (${Math.round(after)} s after the first failure)`
      : undefined;
  };
}

const ListedCredentialSchema = z.looseObject({
  name: z.string(),
  kind: z.string(),
  rotation: z.looseObject({ mode: z.string(), seconds: z.number().optional() }),
  changes: z.string(),
  date: z.looseObject({ at: z.string(), source: z.string() }).optional(),
});

/** One credential of `opscrew rotate --json`. */
export type ListedCredential = z.infer<typeof ListedCredentialSchema>;

/** The credentials `opscrew rotate --json` printed on its standard output. */
export function listedCredentials(stdout: string): ListedCredential[] {
  const parsed = z
    .object({
      app: z.string(),
      environment: z.string(),
      credentials: z.array(ListedCredentialSchema),
    })
    .safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    throw new Error(`opscrew rotate --json printed another shape: ${parsed.error.message}`);
  }
  return parsed.data.credentials;
}

/**
 * The longest window the listing states for `names` (a swap's or a restart's `seconds`, until the
 * app runs on the new value): 0 when each of them is seamless.
 */
export function listedWindowSeconds(
  listed: readonly ListedCredential[],
  names: readonly string[],
): number {
  return Math.max(
    0,
    ...listed
      .filter((credential) => names.includes(credential.name))
      .map((credential) => credential.rotation.seconds ?? 0),
  );
}

/** The listed credential `name`; throws with the names listed when there is none. */
export function credentialOf(listed: readonly ListedCredential[], name: string): ListedCredential {
  const found = listed.find((credential) => credential.name === name);
  if (found === undefined) {
    throw new Error(
      `opscrew rotate does not list ${name}; it lists ${listed.map((c) => c.name).join(", ") || "nothing"}.`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// The record.

/**
 * What is wrong with `record` (`opscrew/credentials.yaml`) in `environment` for `expected`, each
 * credential's generation by name: an entry missing, another generation, or no `rotatedAt` at or
 * after `since` (the rotation's start). Names only, never a value (the record holds none).
 */
export function recordProblems(
  record: CredentialsRecord,
  environment: string,
  expected: Readonly<Record<string, number>>,
  since: Date,
): string[] {
  const entries = record.environments[environment] ?? {};
  return Object.entries(expected).flatMap(([name, generation]) => {
    const entry = entries[name];
    if (entry === undefined) return [`the record has no ${name} in ${environment}`];
    const problems: string[] = [];
    if (entry.generation !== generation) {
      problems.push(`the record has ${name} at generation ${entry.generation}, not ${generation}`);
    }
    const at = entry.rotatedAt === undefined ? Number.NaN : Date.parse(entry.rotatedAt);
    if (!(at >= since.getTime() - 60_000)) {
      problems.push(`the record does not date ${name}'s rotation in this run`);
    }
    return problems;
  });
}

// ---------------------------------------------------------------------------------------------
// Logging in to a service with a value on standard input.

/** The services the passes log in to, by the catalog's kind. */
export type LoginKind = "postgres" | "mysql" | "valkey" | "rabbitmq";

/** Who logs in: the app's own login by default (`app`, in the database `app`). */
export interface LoginAs {
  user?: string;
  database?: string;
}

/**
 * The script run with `sh -c` in a service's container that logs in once over its own loopback
 * with the value on the first line of its standard input (never on a command line on the server,
 * but RabbitMQ's `rabbitmqctl`, which takes it only as an argument, inside the container for the
 * second it runs, as OpsCrew's own recipe does) and prints `login ok` or `login refused`.
 */
export function loginScript(kind: LoginKind, as: LoginAs = {}): string {
  const user = as.user ?? "app";
  const database = as.database ?? "app";
  for (const name of [user, database]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a plain name.`);
  }
  const login = {
    // The image trusts 127.0.0.1 without a password (its pg_hba.conf); the container's own
    // address takes the password check every other client gets.
    postgres: `PGPASSWORD="$v" psql -h "$(hostname -i | cut -d ' ' -f1)" -U ${user} -d ${database} -tAc 'select 1' > /dev/null 2>&1`,
    mysql: `MYSQL_PWD="$v" mysql -h 127.0.0.1 -u${user} -N -B ${database} -e 'select 1' > /dev/null 2>&1`,
    valkey: `[ "$(REDISCLI_AUTH="$v" valkey-cli --no-auth-warning ping 2> /dev/null)" = PONG ]`,
    rabbitmq: `rabbitmqctl authenticate_user ${user} "$v" > /dev/null 2>&1`,
  }[kind];
  return `IFS= read -r v; if ${login}; then echo 'login ok'; else echo 'login refused'; fi; v=''`;
}

/** What {@link loginScript} printed: whether the login worked; throws when it printed neither. */
export function loginAnswer(stdout: string): boolean {
  const said = stdout.trim().split(/\r?\n/).at(-1);
  if (said === "login ok") return true;
  if (said === "login refused") return false;
  throw new Error("The login script printed neither `login ok` nor `login refused`.");
}

/**
 * The host command that runs `script` with `sh -c` in the running container of `service` in the
 * Compose project `project`, its standard input passed on (`docker exec -i`). The script travels
 * in base64, so no quoting reaches it.
 */
export function inContainerWithInput(project: string, service: string, script: string): string {
  for (const name of [project, service]) {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new Error(`"${name}" is not a plain name.`);
  }
  const encoded = Buffer.from(script).toString("base64");
  return [
    `c=$(docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=${service} | head -n 1)`,
    `if [ -z "$c" ]; then echo "no running container of ${service} in ${project}" >&2; exit 3; fi`,
    `docker exec -i "$c" sh -c "$(echo ${encoded} | base64 -d)"`,
  ].join("; ");
}

/**
 * The script run with `sh -c` in a container that prints `same` when its variable `name` holds
 * the value on the first line of its standard input, `other` when it holds another, `unset`
 * when it holds none: the container's value is never printed.
 */
export function envValueScript(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a variable's name.`);
  return `IFS= read -r v; if [ -z "\${${name}:-}" ]; then echo unset; elif [ "$${name}" = "$v" ]; then echo same; else echo other; fi; v=''`;
}

/**
 * The script run on a server that POSTs the JSON body on the first line of its standard input to
 * `url` (`insecure`: a self-signed certificate on the loopback) and prints only the HTTP status.
 */
export function postStatusScript(url: string, insecure = false): string {
  if (!/^https?:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_/.-]*$/.test(url)) {
    throw new Error(`${url} is not a loopback URL.`);
  }
  return `IFS= read -r body; printf '%s' "$body" | curl -s${insecure ? "k" : ""} --max-time 30 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @- '${url}'; body=''`;
}

/**
 * The script run on a server that GETs `url` as the user `admin` with the password on the first
 * line of its standard input (curl reads the login from its own standard input) and prints only
 * the HTTP status: Grafana's API.
 */
export function basicAuthStatusScript(url: string): string {
  if (!/^https?:\/\/[0-9.]+:\d+\/[A-Za-z0-9_/.-]*$/.test(url)) {
    throw new Error(`${url} is not an address URL.`);
  }
  return `IFS= read -r pw; printf 'user = "admin:%s"\\n' "$pw" | curl -s --max-time 30 -o /dev/null -w '%{http_code}' -K - '${url}'; pw=''`;
}

/**
 * The script run on the app's server that signs in to Beszel's hub (`hub`, its loopback URL) as
 * the dashboard's user with the password on the first line of its standard input, then prints
 * each system's status the hub shows (`status up`), never the token.
 */
export function beszelStatusScript(hub: string, email: string): string {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub)) throw new Error(`${hub} is not a loopback URL.`);
  if (!/^[a-z0-9.@_-]+$/.test(email)) throw new Error(`"${email}" is not a plain address.`);
  return [
    "IFS= read -r pw",
    `auth=$(printf '{"identity":"${email}","password":"%s"}' "$pw" | curl -fsS --max-time 30 -X POST -H 'Content-Type: application/json' --data-binary @- '${hub}/api/collections/users/auth-with-password' 2> /dev/null)`,
    "pw=''",
    `tok=$(printf '%s' "$auth" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')`,
    "auth=''",
    `if [ -z "$tok" ]; then echo 'no sign-in'; exit 0; fi`,
    `printf 'header = "Authorization: %s"\\n' "$tok" | curl -fsS --max-time 30 -K - '${hub}/api/collections/systems/records?fields=name,status' 2> /dev/null | grep -o '"status":"[a-z]*"' | sed 's/"status":"\\([a-z]*\\)"/status \\1/'`,
    "tok=''",
  ].join("\n");
}

/** The statuses {@link beszelStatusScript} printed (`up`, `down`, `pending`), in order. */
export function beszelStatuses(stdout: string): string[] {
  return [...stdout.matchAll(/^status ([a-z]+)$/gm)].map((match) => match[1] as string);
}

// ---------------------------------------------------------------------------------------------
// The session checks.

/** A client's cookies by name, as a browser keeps them for one site. */
export type CookieJar = Readonly<Record<string, string>>;

/** `jar` with the cookies an answer's `Set-Cookie` headers set (an empty value removes one). */
export function withCookies(jar: CookieJar, setCookie: string | string[] | undefined): CookieJar {
  const next: Record<string, string> = { ...jar };
  for (const line of typeof setCookie === "string" ? [setCookie] : (setCookie ?? [])) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (value === "" || value === "deleted") delete next[name];
    else next[name] = value;
  }
  return next;
}

/** The `Cookie` header of `jar`. */
export function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** The routes the app pass adds to examples/laravel-app (`routes/web.php`, the whole file). */
export const LARAVEL_ROUTES = `<?php

use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Crypt;
use Illuminate\\Support\\Facades\\Route;

Route::get('/', function () {
    return view('welcome');
});

// The credential rotation live test (docs/e2e.md "Credential rotation"): a session's counter,
// and a value encrypted with the app's key, read back.
Route::get('/e2e-session', fn () => (string) session()->increment('e2e'));
Route::get('/e2e-encrypt', fn () => Crypt::encryptString('opscrew-e2e'));
Route::get('/e2e-decrypt', function (Request $request) {
    try {
        return Crypt::decryptString((string) $request->query('v')) === 'opscrew-e2e' ? 'readable' : 'other';
    } catch (\\Throwable) {
        return response('unreadable', 409);
    }
});
`;

/** The session setting the app pass changes in examples/laravel-app's `config/session.php`. */
const SESSION_DRIVER_LINE = "'driver' => env('SESSION_DRIVER', 'database'),";

/**
 * examples/laravel-app's `config/session.php` (`text`) with the session kept in its encrypted
 * cookie, so a session survives the app's switch to a new container and only the app's key
 * decides whether it reads. Throws when the line is not there.
 */
export function cookieSessions(text: string): string {
  if (!text.includes(SESSION_DRIVER_LINE)) {
    throw new Error("config/session.php no longer reads SESSION_DRIVER as the pass expects.");
  }
  return text.replace(SESSION_DRIVER_LINE, "'driver' => 'cookie',");
}

/**
 * `text`, an example's `.env.example` (empty when it has none), with each of `names` listed
 * (`NAME=`), as a user lists a variable the app reads.
 */
export function withExampleVariables(text: string, names: readonly string[]): string {
  const listed = new Set(
    text.split(/\r?\n/).map((line) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1] ?? ""),
  );
  const added = names.filter((name) => !listed.has(name)).map((name) => `${name}=`);
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${added.join("\n")}${added.length > 0 ? "\n" : ""}`;
}

// ---------------------------------------------------------------------------------------------
// A rotation in a terminal.

/** A prompt a rotation asks in a terminal: an approval, or a name to type. */
export type Prompt = { kind: "approve" } | { kind: "type"; phrase: string };

/**
 * The prompts a terminal's `output` asked, in order: "Approve this change?" and `Type "<phrase>"
 * to approve` (the approvals' prompts), each as its prompt library (clack) draws it while it waits
 * for an answer, once, after its active mark (`◆`, or `*` in a terminal without Unicode); the
 * answered prompt is drawn again after another mark (`◇`, `o`), which is not counted. Colours and
 * cursor moves are left out first.
 */
export function terminalPrompts(output: string): Prompt[] {
  const text = stripVTControlCharacters(output);
  return [...text.matchAll(/(?:◆|\*) +(?:Approve this change\?|Type "([^"]+)" to approve)/g)].map(
    (match) => (match[1] === undefined ? { kind: "approve" } : { kind: "type", phrase: match[1] }),
  );
}

/** The keys that answer `prompt`: `y` approves (and submits), a phrase is typed and entered. */
export function promptKeys(prompt: Prompt): string {
  return prompt.kind === "approve" ? "y" : `${prompt.phrase}\r`;
}

/** `value` quoted for a POSIX shell. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The `script` command that runs `argv` in a pty: util-linux's (Linux, WSL) takes the command as
 * one shell string and returns its exit code with `-e`; the BSD one (macOS) takes the words.
 */
export function ptyCommand(
  platform: NodeJS.Platform,
  argv: readonly string[],
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "script", args: ["-q", "/dev/null", ...argv] };
  return { command: "script", args: ["-qefc", argv.map(quoted).join(" "), "/dev/null"] };
}

/**
 * The launcher of a rotation run by hand in a terminal: it changes to `cwd`, exports `env.set`
 * (the run's own settings, never printed), unsets `env.unset` and `CI` (the CLI asks only without
 * it), runs `argv` and writes its exit code to `exitFile`.
 */
export function terminalLauncher(
  cwd: string,
  env: { set: Readonly<Record<string, string>>; unset: readonly string[] },
  argv: readonly string[],
  exitFile: string,
): string {
  const name = (variable: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      throw new Error(`"${variable}" is not a variable.`);
    }
    return variable;
  };
  return [
    "#!/bin/sh",
    "# Written by OpsCrew's credential rotation live test; it holds the run's settings.",
    `cd ${quoted(cwd)} || exit 1`,
    ...Object.entries(env.set).map(
      ([variable, value]) => `export ${name(variable)}=${quoted(value)}`,
    ),
    `unset ${[...env.unset, "CI"].map(name).join(" ")}`,
    `${argv.map(quoted).join(" ")}`,
    `echo $? > ${quoted(exitFile)}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: a tunnel's connections, a Worker version's secrets.

const ConnectionsSchema = z.looseObject({
  result: z.array(
    z.looseObject({
      id: z.string(),
      conns: z.array(z.looseObject({ id: z.string() })).nullish(),
    }),
  ),
});

/**
 * A tunnel's connectors and their connections to Cloudflare, by id, from
 * `GET /accounts/{account}/cfd_tunnel/{id}/connections`.
 */
export function tunnelConnections(json: unknown): { connectors: string[]; connections: string[] } {
  const parsed = ConnectionsSchema.safeParse(json);
  if (!parsed.success)
    throw new Error("Cloudflare listed the tunnel's connections in another shape.");
  return {
    connectors: parsed.data.result.map((connector) => connector.id),
    connections: parsed.data.result.flatMap((connector) =>
      (connector.conns ?? []).map((conn) => conn.id),
    ),
  };
}

const VersionSchema = z.looseObject({
  result: z.looseObject({
    resources: z.looseObject({
      bindings: z.array(z.looseObject({ type: z.string(), name: z.string() })).optional(),
    }),
  }),
});

/** The names of a Worker version's secrets, from `GET …/workers/scripts/{name}/versions/{id}`. */
export function versionSecretNames(json: unknown): string[] {
  const parsed = VersionSchema.safeParse(json);
  if (!parsed.success) throw new Error("Cloudflare showed the Worker's version in another shape.");
  return (parsed.data.result.resources.bindings ?? [])
    .filter((binding) => binding.type === "secret_text")
    .map((binding) => binding.name)
    .sort();
}

// ---------------------------------------------------------------------------------------------
// Better Auth with both of its variables.

/** The Better Auth check's markers, which the script prints. */
export const BETTER_AUTH_MARKERS = {
  started: "started with both: yes",
  oldKept: "old session: kept",
  newOk: "new session: ok",
} as const;

/**
 * The Node script of the Better Auth check, run in two processes: `phase` `old` signs a user up
 * with `BETTER_AUTH_SECRET` alone and keeps the users and sessions (in Better Auth's memory
 * adapter) and the session's cookie in `/work`; `phase` `both` starts with `BETTER_AUTH_SECRET`
 * the new value and `BETTER_AUTH_SECRETS` both, as a rotation leaves them, reads the old session
 * and signs in again. Values come from the environment only, and none is printed.
 */
export function betterAuthScript(): string {
  return `import { readFileSync, writeFileSync } from "node:fs";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
const phase = process.argv[2];
const file = "/work/db.json";
const revive = (key, value) => (/At$/.test(key) && typeof value === "string" ? new Date(value) : value);
const db = phase === "old" ? { user: [], session: [], account: [], verification: [] } : JSON.parse(readFileSync(file, "utf8"), revive);
const auth = betterAuth({ baseURL: "http://localhost:3000", database: memoryAdapter(db), emailAndPassword: { enabled: true } });
const body = { email: "e2e@example.invalid", password: process.env.E2E_USER_PASSWORD, name: "OpsCrew E2E" };
const cookieOf = (headers) => (headers.get("set-cookie") ?? "").split(";")[0];
if (phase === "old") {
  const signed = await auth.api.signUpEmail({ body, returnHeaders: true });
  writeFileSync(file, JSON.stringify(db));
  writeFileSync("/work/cookie", cookieOf(signed.headers));
  console.log("signed up");
} else {
  console.log("${BETTER_AUTH_MARKERS.started}");
  const old = await auth.api.getSession({ headers: new Headers({ cookie: readFileSync("/work/cookie", "utf8") }) });
  console.log(old?.session ? "${BETTER_AUTH_MARKERS.oldKept}" : "old session: lost");
  const signed = await auth.api.signInEmail({ body: { email: body.email, password: body.password }, returnHeaders: true });
  const fresh = await auth.api.getSession({ headers: new Headers({ cookie: cookieOf(signed.headers) }) });
  console.log(fresh?.session ? "${BETTER_AUTH_MARKERS.newOk}" : "new session: failed");
}
`;
}
