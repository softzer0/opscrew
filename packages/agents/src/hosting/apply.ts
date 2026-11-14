/**
 * Applying a hosting plan (027 plan 2, ADR 0030 D3): the hash is recomputed and a plan that isn't
 * the approved one is refused before anything changes; each step then goes through the panel's
 * connector or the account's files, and each object made is recorded right away. Secrets made at
 * apply (the database's password, the release signing key) never enter the plan, the record or a
 * message.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { tarStream } from "@opscrew/connector-docker";
import type { HostingFiles, HostingPanel } from "@opscrew/contracts";
import { canonicalJson, isPlanHash, OpsCrewError, type Redactor, sha256Hex } from "@opscrew/core";
import { selectorApp } from "./apps";
import { type AppStep, type HostingPlan, type HostingStep, hostingPlanHash } from "./plan";
import type { HostingObject } from "./record";
import { sendRequest } from "./requests";

/** A release signing key pair in PEM: PKCS #8 private half, SPKI public half. */
export interface SigningKeyPair {
  privatePem: string;
  publicPem: string;
}

/** A new ECDSA P-256 pair, as the workflow signs and `openssl dgst -verify` checks. */
export function newSigningKey(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

/** The SHA-256 the record keeps of a signing key's public half. */
export const signingKeyId = (publicPem: string) => sha256Hex(publicPem.trim());

/** The folders of the app's folder and their modes (plan 5). */
const FOLDERS: readonly [string, number][] = [
  ["keys", 0o700],
  ["state", 0o700],
  ["requests", 0o700],
  ["dumps", 0o700],
  ["releases", 0o711],
  ["shared", 0o711],
];

/**
 * The files a panel makes in a new hostname's own document root (DirectAdmin's default page),
 * which the link to the release may replace. Anything else there stops provision. From
 * DirectAdmin's default domain skeleton; no account confirmed it yet.
 */
const PANEL_DEFAULT_PAGE: ReadonlySet<string> = new Set(["index.html", "logo.png"]);

/** What an apply needs besides the plan. */
export interface HostingApplyContext {
  panel: HostingPanel;
  files: HostingFiles;
  /** Records an object right after it is made, so a stop later leaves it recorded. */
  made: (object: HostingObject) => Promise<void>;
  /** Forgets an object OpsCrew removed. */
  forget: (kind: HostingObject["kind"], key: string) => Promise<void>;
  /** Records an object in place of every recorded one of its kind (a new signing key). */
  replace: (object: HostingObject) => Promise<void>;
  /** The content of each file step, by its path in the app's folder (checked against the plan). */
  contents: ReadonlyMap<string, string>;
  /** The app's values outside the database's, by name (checked against the values step). */
  values?: Readonly<Record<string, string>>;
  /** The database's full name and its user's, for the values the database fills. */
  database?: { name: string; user: string };
  /** The document roots of the account's other hostnames (`inspect()`), for a panel's own root. */
  otherRoots: readonly string[];
  redactor: Redactor;
  /** Shows what a step left undone, such as the settings the selector refused (`app`). */
  warn?: (text: string) => void;
  /** How a wait for the agent's answer sleeps: to a settings change (`env`) and to the selector's app (`app`). */
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Random bytes for the database's password (default: Node's). */
  randomBytes?: (size: number) => Uint8Array;
  /**
   * Stores a new release signing key's private half as the deploy environment's GitHub secret,
   * after its own approval; required by a plan with a `signing-key` step.
   */
  storeSigningKey?: (privatePem: string) => Promise<void>;
  /** A new release signing key pair (default: {@link newSigningKey}). */
  newSigningKey?: () => SigningKeyPair;
}

/**
 * An apply that stopped at a failure: `applied` lists the steps done before it; `who` answered
 * what OpsCrew can't read (`The panel`, `The SFTP host`).
 */
export class HostingApplyError extends OpsCrewError {
  readonly applied: readonly string[];

  constructor(cause: unknown, applied: readonly string[], who: string) {
    const known = cause instanceof OpsCrewError;
    super(
      known ? cause.code : "PROVIDER_ERROR",
      `${known ? cause.message : `${who}'s answer was unexpected.`} ${
        applied.length === 0
          ? "Nothing was changed before it."
          : `OpsCrew made ${applied.length} of the plan's changes before it, each recorded in .opscrew/hosting.json.`
      }`,
      { ...(known && cause.hint !== undefined ? { hint: cause.hint } : {}), cause },
    );
    this.name = "HostingApplyError";
    this.applied = applied;
  }
}

/** A database password: 32 letters and digits, safe in a URL, a settings file and `mysql.cnf`. */
function newPassword(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * A line of the app's settings file as `env.php` and Laravel read it: bare when plain, in single
 * quotes when it has no quote or line break, else in double quotes with `\\ \" \n \r \t \$`
 * escaped.
 */
export function valuesLine(name: string, value: string): string {
  if (/^[A-Za-z0-9_.,:/@+=-]*$/.test(value)) return `${name}=${value}`;
  if (!/['\r\n]/.test(value)) return `${name}='${value}'`;
  const escaped = value.replace(/[\\"\n\r\t$]/g, (char) =>
    char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\${char}`,
  );
  return `${name}="${escaped}"`;
}

/** The SHA-256 of the app's values outside the database's: the values step's digest. */
export function valuesDigest(values: Readonly<Record<string, string>>): string {
  return sha256Hex(canonicalJson(values));
}

/**
 * The values the database fills, by the names `keys` gives (the plan's split settings, and its URL
 * variable): `localhost` and 3306, the full names, the password, or a `mysql://` URL.
 */
export function databaseValues(
  keys: readonly string[],
  database: { name: string; user: string; password: string },
): Record<string, string> {
  const { name, user, password } = database;
  const values: Record<string, string> = {};
  for (const key of keys) {
    if (key === "DB_HOST") values[key] = "localhost";
    else if (key === "DB_PORT") values[key] = "3306";
    else if (key === "DB_DATABASE" || key === "DB_NAME") values[key] = name;
    else if (key === "DB_USERNAME" || key === "DB_USER") values[key] = user;
    else if (key === "DB_PASSWORD" || key === "DB_PASS") values[key] = password;
    else {
      values[key] =
        `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:3306/${name}`;
    }
  }
  return values;
}

/** `mysql.cnf`'s `[client]` section for the dumps. */
function mysqlCnf(database: { user: string; password: string }): string {
  return `[client]\nuser=${database.user}\npassword=${database.password}\nhost=localhost\n`;
}

/** The archive's bytes. */
export async function tarBytes(entries: Parameters<typeof tarStream>[0]): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream(entries)) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** A tar holding one symbolic link `name` to `target`. */
const linkTar = (name: string, target: string) =>
  tarBytes([{ name, type: "symlink", mode: 0o777, uid: 0, gid: 0, target }]);

/** The folder of `path` (`.` for the home folder) and its name. */
function split(path: string): { folder: string; name: string } {
  const folder = posix.dirname(path);
  return { folder, name: posix.basename(path) };
}

/** `../` up from `path`'s folder to the home folder, then `target`. */
function fromHome(path: string, target: string): string {
  const depth = path.split("/").length - 1;
  return `${"../".repeat(depth)}${target}`;
}

/**
 * Stops unless the panel's own document root `root` holds nothing but its default page and is no
 * other hostname's document root nor inside one, so replacing it by the link deletes nothing of the
 * user's (DirectAdmin keeps a removed domain's folder, and older versions put a subdomain's root
 * inside its domain's).
 */
export async function requireEmptyPanelRoot(
  files: HostingFiles,
  root: string,
  otherRoots: readonly string[],
): Promise<void> {
  const inside = otherRoots.find((other) => root === other || root.startsWith(`${other}/`));
  const names = inside === undefined ? await files.list(root) : undefined;
  const extra = (names ?? []).filter((name) => !PANEL_DEFAULT_PAGE.has(name));
  if (inside === undefined && extra.length === 0) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    inside !== undefined
      ? `The panel made the hostname's document root ~/${root}, which is ${inside === root ? "another site's own folder" : `inside another site's folder (~/${inside})`}, so OpsCrew won't replace it: it may hold that site's files.`
      : `The panel made the hostname's document root ~/${root}, and it holds files OpsCrew didn't put there (${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", …" : ""}), so OpsCrew won't replace it.`,
    {
      hint: `Move those files elsewhere in the panel's File Manager if they are yours, or remove the hostname in the panel and choose another one with \`opscrew interview\`; then run \`opscrew provision\` again.`,
    },
  );
}

/** The content of file step `path` among `contents`, checked against the plan's SHA-256. */
export function contentOf(
  contents: ReadonlyMap<string, string>,
  path: string,
  sha256: string,
): Uint8Array {
  const text = contents.get(path);
  if (text === undefined || sha256Hex(text) !== sha256) {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew has no content for ${path} that matches the approved plan.`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  return new TextEncoder().encode(text);
}

/** Stops unless the app's `values` still have the values step's `digest`: they changed since. */
export function requireValuesDigest(
  values: Readonly<Record<string, string>>,
  digest: string,
): void {
  if (valuesDigest(values) === digest) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "The app's values changed after this hosting plan was made, so OpsCrew didn't write them.",
    { hint: "Run `opscrew provision` again to make a plan with the values as they are now." },
  );
}

/** The app's settings file: a {@link valuesLine} for each of `values`, by name. */
export function settingsText(values: Readonly<Record<string, string>>): string {
  return Object.keys(values)
    .sort()
    .map((name) => `${valuesLine(name, values[name] ?? "")}\n`)
    .join("");
}

/**
 * Stops with `PLAN_HASH_MISMATCH` before any change unless `approvedHash` is the plan's `hash`.
 * `plan` names it (`hosting plan`, `hosting destroy plan`), `unchanged` what stays as it was
 * (`OpsCrew changes nothing on the account`).
 */
export function requireApprovedHash(
  approvedHash: string,
  hash: string,
  plan: "hosting plan" | "hosting destroy plan",
  unchanged: string,
): void {
  if (isPlanHash(approvedHash) && approvedHash.toLowerCase() === hash) return;
  throw new OpsCrewError(
    "PLAN_HASH_MISMATCH",
    `This ${plan} is not the one that was approved, so ${unchanged}.`,
    {
      hint: `Look at the current ${plan === "hosting plan" ? "hosting" : "destroy"} plan and approve it by its hash.`,
    },
  );
}

/** The database's password from `shared/mysql.cnf`, written before the database was made. */
async function recordedPassword(files: HostingFiles, folder: string): Promise<string> {
  const text = await files.readFile(`${folder}/shared/mysql.cnf`);
  const password = text === undefined ? undefined : /^password=(.+)$/m.exec(text)?.[1]?.trim();
  if (password === undefined || password === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew can't read the database's password from ~/${folder}/shared/mysql.cnf, so it can't write the app's settings.`,
      {
        hint: "Restore the file from the account's backup, or remove the database with `opscrew destroy` and run `opscrew provision` again.",
      },
    );
  }
  return password;
}

/**
 * Applies an approved hosting plan: refuses with `PLAN_HASH_MISMATCH` before any change when its
 * hash isn't `approvedHash`. The steps then run in order; each object made is recorded at once
 * (`ctx.made`), and the first failure stops with a {@link HostingApplyError}. A panel step isn't
 * applied: it is recorded as listed, for the user to take. A `signing-key` step's private half goes
 * only to `ctx.storeSigningKey`. Answers the steps applied.
 */
export async function applyHostingPlan(
  plan: HostingPlan,
  ctx: HostingApplyContext & { approvedHash: string },
): Promise<{ applied: HostingStep["kind"][] }> {
  requireApprovedHash(
    ctx.approvedHash,
    hostingPlanHash(plan),
    "hosting plan",
    "OpsCrew changes nothing on the account",
  );
  const applied: HostingStep["kind"][] = [];
  const state: { password?: string; root?: string } = {};
  for (const step of plan.steps) {
    try {
      await applyStep(plan, step, ctx, state);
    } catch (error) {
      throw new HostingApplyError(error, applied, "The panel");
    }
    applied.push(step.kind);
  }
  return { applied };
}

async function applyStep(
  plan: HostingPlan,
  step: HostingStep,
  ctx: HostingApplyContext & { approvedHash: string },
  state: { password?: string; root?: string },
): Promise<void> {
  const { panel, files } = ctx;
  const { folder } = plan;
  switch (step.kind) {
    case "folder": {
      const tops = folder.split("/");
      const parents = tops.map((_, i) => tops.slice(0, i + 1).join("/"));
      const archive = await tarBytes(
        [
          ...parents.map((name) => ({ name: `${name}/`, type: "dir" as const, mode: 0o711 })),
          ...FOLDERS.map(([name, mode]) => ({
            name: `${folder}/${name}/`,
            type: "dir" as const,
            mode,
          })),
          ...step.files.map((file) => ({
            name: `${folder}/${file.path}`,
            type: "file" as const,
            mode: file.mode,
            data: Buffer.from(contentOf(ctx.contents, file.path, file.sha256)),
          })),
        ].map((entry) => ({ ...entry, uid: 0, gid: 0 })),
      );
      await files.uploadTar(".", archive);
      return ctx.made({ kind: "folder", key: folder });
    }
    case "file":
      return files.writeFile(
        `${folder}/${step.path}`,
        contentOf(ctx.contents, step.path, step.sha256),
        step.mode,
      );
    case "signing-key": {
      if (ctx.storeSigningKey === undefined) {
        throw new OpsCrewError("INTERNAL", "The apply can't store a new signing key in GitHub.", {
          hint: "This is a bug in OpsCrew; please report it.",
        });
      }
      const pair = (ctx.newSigningKey ?? newSigningKey)();
      ctx.redactor.addLiteral(pair.privatePem, "OPSCREW_RELEASE_SIGNING_KEY");
      // GitHub first: a refusal leaves the account's key, and the releases it checks, as they were.
      await ctx.storeSigningKey(pair.privatePem);
      await files.writeFile(
        `${folder}/keys/release.pub`,
        new TextEncoder().encode(pair.publicPem),
        0o644,
      );
      return ctx.replace({ kind: "signing-key", key: signingKeyId(pair.publicPem) });
    }
    case "cron": {
      const job = await panel.addCron({ schedule: step.schedule, command: step.command });
      return ctx.made({ kind: "cron", key: job.key, value: `${step.schedule} ${step.command}` });
    }
    case "panel-step":
      return ctx.made({
        kind: "panel-step",
        key: step.id,
        value: step.step.value ?? step.step.what,
      });
    case "database": {
      const password = newPassword((ctx.randomBytes ?? randomBytes)(32));
      ctx.redactor.addLiteral(password, "the database's password");
      // Written first, so a stop after the database is made never loses its password.
      await files.writeFile(
        `${folder}/shared/mysql.cnf`,
        new TextEncoder().encode(mysqlCnf({ user: step.user, password })),
        0o600,
      );
      await panel.addDatabase({ name: step.name, user: step.user, password });
      state.password = password;
      return ctx.made({ kind: "database", key: step.name });
    }
    case "values":
      return applyValues(plan, step, ctx, state);
    case "link": {
      const { folder: parent, name } = split(step.path);
      await files.uploadTar(parent, await linkTar(name, step.target));
      return ctx.made({ kind: "link", key: step.path });
    }
    case "hostname": {
      const root = await panel.addHostname(step.hostname, step.documentRoot);
      state.root = root;
      return ctx.made({ kind: "hostname", key: step.hostname, value: root });
    }
    case "panel-root": {
      const root = state.root ?? (await panel.documentRoot(step.hostname));
      if (root === undefined) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `The panel doesn't name ${step.hostname}'s document root, so OpsCrew can't point it at the release.`,
          { hint: "Check the hostname in the panel, then run `opscrew provision` again." },
        );
      }
      await requireEmptyPanelRoot(files, root, ctx.otherRoots);
      await files.remove(root);
      const { folder: parent, name } = split(root);
      await files.uploadTar(parent, await linkTar(name, fromHome(root, step.target)));
      return ctx.made({ kind: "link", key: root });
    }
    case "php":
      await panel.setPhpVersion(step.hostname, step.version);
      return ctx.made({ kind: "php", key: step.hostname, value: step.version });
    case "app": {
      // Recorded before it is asked for, so destroy removes it after a stop or an unclear answer;
      // forgotten only when the agent's answer says it made nothing.
      await ctx.made({ kind: "app", key: step.interpreter, value: step.version });
      const note = await selectorApp(files, folder, "create", {
        hash: ctx.approvedHash,
        now: ctx.now(),
        sleep: ctx.sleep,
        madeNothing: () => ctx.forget("app", step.interpreter),
      });
      if (note !== undefined) ctx.warn?.(`${note}.`);
      return;
    }
    case "remove-cron":
      await panel.removeCron(step.key);
      return ctx.forget("cron", step.key);
    case "certificate":
      return panel.requestCertificate(step.hostname);
    default:
      return step satisfies never;
  }
}

/**
 * The app's settings file: the values (checked against the step's digest) and the database's
 * (its password generated by this apply, else read from `shared/mysql.cnf`), 0600. On a later run
 * it is `shared/.env.next`, which the agent puts in place on an `env` request bound to this plan.
 */
async function applyValues(
  plan: HostingPlan,
  step: Extract<AppStep, { kind: "values" }>,
  ctx: HostingApplyContext & { approvedHash: string },
  state: { password?: string },
): Promise<void> {
  const values = ctx.values ?? {};
  requireValuesDigest(values, step.digest);
  const { folder } = plan;
  let database: Record<string, string> = {};
  if (step.database.length > 0) {
    if (ctx.database === undefined) {
      throw new OpsCrewError("INTERNAL", "The app's database isn't known to the apply.", {
        hint: "This is a bug in OpsCrew; please report it.",
      });
    }
    const password = state.password ?? (await recordedPassword(ctx.files, folder));
    ctx.redactor.addLiteral(password, "the database's password");
    database = databaseValues(step.database, { ...ctx.database, password });
  }
  const text = settingsText({ ...values, ...database });
  const path = `${folder}/shared/${step.file}`;
  await ctx.files.writeFile(path, new TextEncoder().encode(text), 0o600);
  if (step.file === ".env.next") {
    const answer = await sendRequest(
      ctx.files,
      folder,
      { kind: "env" },
      { hash: ctx.approvedHash, now: ctx.now(), sleep: ctx.sleep },
    );
    if (answer.result !== "done") {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The agent didn't put the new settings in place: ${answer.reason ?? answer.result}. The app still runs with its earlier settings.`,
        { hint: "Run `opscrew logs` to see why, then run `opscrew provision` again." },
      );
    }
  }
  await ctx.made({ kind: "file", key: `${folder}/shared/.env`, value: step.digest });
}
