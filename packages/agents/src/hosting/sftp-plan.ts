/**
 * An SFTP-only host's hosting plan (027 plan 10, ADR 0030 D3, D6, ADR 0011's pattern): the app's
 * folder with the placeholder release and `current`, the files that load the app's settings, the
 * settings themselves and GitHub Actions' SSH key, as steps of fixed kind approved by the SHA-256
 * of the plan's canonical JSON (`hosting-apply`) and applied over SFTP. The hostname, its document
 * root, its certificate and any database stay the user's, named in the plan.
 */
import { join, posix } from "node:path";
import { tarStream } from "@opscrew/connector-docker";
import { isRemotePath } from "@opscrew/connector-sftp";
import type { HostingFiles } from "@opscrew/contracts";
import {
  canonicalJson,
  ENVIRONMENT_NAME_PATTERN,
  isPlanHash,
  listText,
  OpsCrewError,
  type ProjectPaths,
  plural,
  type Redactor,
  sha256Hex,
} from "@opscrew/core";
import { z } from "zod";
import {
  type AdapterPlanItem,
  describeAdapterPlan,
  type Ed25519KeyPair,
  generateEd25519KeyPair,
} from "../shared";
import { valuesDigest, valuesLine } from "./apply";
import { HostnameSchema, PathSchema } from "./plan";
import type { FileContents, PlannedValues } from "./provision-plans";
import { type HostingObject, type HostingRecord, recordedObject } from "./record";

/** A path as SFTP shows it, by the SFTP connector's own rule (`isRemotePath`). */
export const SftpPathSchema = z.string().refine(isRemotePath, {
  message: "must be a path on the SFTP host without empty parts, ., .. or line breaks",
});
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const SftpStepSchema = z.discriminatedUnion("kind", [
  // The app's folder in one archive: `releases/` and `shared/` 0711, `state/` 0700, the empty
  // placeholder release `placeholder` (`releases/0-0/<web root>`) and `current` linked to it, so
  // the hostname's document root exists before the first release. With `parent`, the folder it is
  // in is made first, and is OpsCrew's too.
  z.strictObject({ kind: z.literal("folder"), parent: z.boolean(), placeholder: PathSchema }),
  // A file of the app's folder: `shared/env.php`, `shared/env.htaccess`, `shared/env.user.ini`.
  z.strictObject({
    kind: z.literal("file"),
    path: PathSchema,
    mode: z.int().min(0).max(0o777),
    sha256: Sha256Schema,
  }),
  // The app's settings, `shared/.env` (0600): their keys, the generated ones, their values' digest.
  z.strictObject({
    kind: z.literal("values"),
    keys: z.array(z.string()),
    generated: z.array(z.string()),
    digest: Sha256Schema,
  }),
  // A new SSH key for GitHub Actions (Ed25519), made at apply: its private half goes straight to
  // GitHub with the host's reach (their own approval); its public half, with `restrict`, is added
  // to `~/.ssh/authorized_keys` when the host shows that file over SFTP, else listed for the user
  // to add in the host's panel.
  z.strictObject({ kind: z.literal("ci-key"), authorizedKeys: z.boolean() }),
]);

/** An SFTP-only host's plan, as saved in `.opscrew/plans/hosting-<env>-sftp.json`. */
export const SftpPlanSchema = z.strictObject({
  plan: z.literal("sftp"),
  /** The SFTP login: `<user> at <host>`. */
  account: z.string().min(1),
  environment: z.string().regex(ENVIRONMENT_NAME_PATTERN),
  hostname: HostnameSchema,
  /** The app's folder as SFTP shows it. */
  folder: SftpPathSchema,
  /** The hostname's document root as the host sees it, which the user points the hostname at. */
  documentRoot: z.string().regex(/^\/[^\0\r\n]*$/),
  steps: z.array(SftpStepSchema),
});

export type SftpPlan = z.infer<typeof SftpPlanSchema>;
export type SftpStep = SftpPlan["steps"][number];

/** SHA-256 of the plan's canonical JSON: the hash `hosting-apply` binds. */
export function sftpPlanHash(plan: SftpPlan): string {
  return sha256Hex(canonicalJson(SftpPlanSchema.parse(plan)));
}

/** Where the plan is saved: `.opscrew/plans/hosting-<env>-sftp.json`. */
export function sftpPlanFile(paths: Pick<ProjectPaths, "files">, environment: string): string {
  return join(paths.files.plansDir, `hosting-${environment}-sftp.json`);
}

/** Why each file of the app's folder is written. */
const FILE_REASONS: Readonly<Record<string, string>> = {
  "shared/env.php":
    "PHP runs it before each request to load the app's settings from shared/.env; no value is in it.",
  "shared/env.htaccess":
    "The lines each release's .htaccess gets to run env.php before each request (LiteSpeed and Apache's PHP module). They also turn on opcache.revalidate_path, so PHP's code cache follows a switch.",
  "shared/env.user.ini":
    "The lines each release's .user.ini gets to run env.php before each request (PHP-FPM and CGI). They also turn on opcache.revalidate_path, so PHP's code cache follows a switch.",
};

/** One step in plain English, as the plan shows it. */
function stepItem(plan: SftpPlan, step: SftpStep): AdapterPlanItem {
  const { folder } = plan;
  switch (step.kind) {
    case "folder":
      return {
        title: `Make ${folder}/${step.parent ? ` (and ${posix.dirname(folder)}/)` : ""} with releases/ and shared/ (0711), state/ (0700), the empty release ${step.placeholder}/ and the link current to it`,
        state: "change",
        reason: `${plan.hostname}'s document root is ${plan.documentRoot}: it serves the release current points at, which each deploy switches in one step.`,
      };
    case "file":
      return {
        title: `Write ${folder}/${step.path} (0${step.mode.toString(8)})`,
        state: "change",
        ...(FILE_REASONS[step.path] !== undefined ? { reason: FILE_REASONS[step.path] } : {}),
      };
    case "values":
      return {
        title: `Write the app's settings into ${folder}/shared/.env (0600, outside the web root): ${step.keys.length === 0 ? "no values" : listText(step.keys)}`,
        state: "change",
        reason: [
          `The values have the digest ${step.digest.slice(0, 12)}…`,
          step.generated.length > 0 ? `Generated: ${listText(step.generated)}.` : "",
        ]
          .filter((part) => part !== "")
          .join(" "),
      };
    case "ci-key":
      return {
        title: `Make a new SSH key for GitHub Actions (Ed25519): its private half into GitHub with the host's address, the folder and its host key; its public half ${step.authorizedKeys ? "into ~/.ssh/authorized_keys with restrict" : "for you to add to the SFTP user's keys in your host's panel"}`,
        state: "change",
        reason: `The key can read, change and remove every file the SFTP user ${plan.account} can${step.authorizedKeys ? "; restrict turns off forwarding and terminals for it" : ""}. Its private half goes straight to GitHub as secrets of the deploy environment, after their own approval, and is never written on this computer.`,
      };
  }
}

/** The plan in plain English, as shown before its approval, ending with its hash. */
export function describeSftpPlan(plan: SftpPlan, hash: string): string {
  return describeAdapterPlan({
    heading: `Hosting plan for ${plan.hostname} on the SFTP host ${plan.account}`,
    items: plan.steps.map((step) => stepItem(plan, step)),
    findings: [],
    note: [
      `Yours to set in your host's panel, as OpsCrew can't over SFTP: ${plan.hostname} pointed at ${plan.documentRoot}, its certificate, and a database if the app needs one (give its values as the app's settings).`,
      "OpsCrew makes only what this plan lists, over SFTP, records each object it makes in .opscrew/hosting.json, and never changes or removes anything it didn't make.",
    ].join("\n"),
    hashLabel: "Hosting plan hash",
    hash,
  });
}

/** The approval's title for `plan`. */
export function sftpPlanTitle(plan: SftpPlan): string {
  return `Apply the hosting plan to the SFTP host ${plan.account}: ${plan.hostname} (${plural(plan.steps.length, "change")})`;
}

/**
 * Stops when the host has `folder`, which OpsCrew's record doesn't list: a folder is never taken
 * over, also one that appeared between the plan and its apply.
 */
async function requireNoFolder(files: HostingFiles, folder: string): Promise<void> {
  if ((await files.list(folder)) === undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Your SFTP host already has the folder ${folder}, and OpsCrew's record (.opscrew/hosting.json) doesn't list it as OpsCrew's. OpsCrew never changes or takes over what it didn't make: nothing was changed.`,
    {
      hint: "If it is OpsCrew's from another computer, copy that computer's .opscrew/hosting.json here (or restore the recovery copy). Otherwise run `opscrew interview` and choose another folder.",
    },
  );
}

/** What {@link buildSftpPlan} reads. */
export interface SftpPlanInput {
  header: Omit<SftpPlan, "plan" | "steps">;
  files: HostingFiles;
  record: HostingRecord | undefined;
  /** The folder inside a release the hostname serves (`target.webRoot`). */
  webRoot: string;
  /** `shared/env.php`, `shared/env.htaccess` and `shared/env.user.ini`, for a PHP app. */
  contents: FileContents;
  values: Pick<PlannedValues, "values" | "generated" | "digest"> | undefined;
}

/**
 * The plan (027 plan 10) from what is on the host now and what OpsCrew recorded: the app's folder
 * unless OpsCrew made it (a folder that is there and that OpsCrew didn't make stops it), the files
 * that differ, the settings when their digest changed, and the key unless OpsCrew made one.
 * @throws OpsCrewError `PHASE_PRECONDITION` for the app's folder made by someone else.
 */
export async function buildSftpPlan(input: SftpPlanInput): Promise<SftpPlan> {
  const { header, files, record, contents, values } = input;
  const { folder } = header;
  const steps: SftpStep[] = [];
  const made = recordedObject(record, "folder", folder) !== undefined;
  if (!made) {
    await requireNoFolder(files, folder);
    const parent = posix.dirname(folder);
    steps.push({
      kind: "folder",
      parent: parent !== "." && parent !== "/" && (await files.list(parent)) === undefined,
      placeholder: input.webRoot === "." ? "releases/0-0" : `releases/0-0/${input.webRoot}`,
    });
  }
  for (const [path, content] of contents) {
    if (made && (await files.readFile(`${folder}/${path}`)) === content) continue;
    steps.push({ kind: "file", path, mode: 0o600, sha256: sha256Hex(content) });
  }
  if (values !== undefined) {
    const written = recordedObject(record, "file", `${folder}/shared/.env`);
    if (written?.value !== values.digest) {
      steps.push({
        kind: "values",
        keys: Object.keys(values.values).sort(),
        generated: values.generated,
        digest: values.digest,
      });
    }
  }
  if (
    recordedObject(record, "file", AUTHORIZED_KEYS) === undefined &&
    recordedObject(record, "panel-step", CI_KEY_STEP) === undefined
  ) {
    steps.push({
      kind: "ci-key",
      authorizedKeys: (await files.readFile(AUTHORIZED_KEYS)) !== undefined,
    });
  }
  return { plan: "sftp", ...header, steps };
}

/** The SFTP user's authorized keys, where the host shows them. */
export const AUTHORIZED_KEYS = ".ssh/authorized_keys";
/** The panel step that adds GitHub Actions' key where the host doesn't show that file. */
export const CI_KEY_STEP = "ci-key";

/** What applying an SFTP host's plan needs besides the plan. */
export interface SftpApplyContext {
  files: HostingFiles;
  /** The content of each file step, by its path in the app's folder (checked against the plan). */
  contents: ReadonlyMap<string, string>;
  /** The app's values, by name (checked against the values step). */
  values?: Readonly<Record<string, string>>;
  redactor: Redactor;
  /** Records an object right after it is made, so a stop later leaves it recorded. */
  made: (object: HostingObject) => Promise<void>;
  /**
   * Stores a new key's private half, with the host's reach, as the deploy environment's GitHub
   * secrets, after their own approval; GitHub first, so a refusal changes nothing on the host.
   */
  storeKey: (privateKey: string) => Promise<void>;
  /** The new key's comment: `opscrew-<app>-<env>`. */
  keyComment: string;
  /** A new Ed25519 pair (default: {@link generateEd25519KeyPair}). */
  newKeyPair?: (comment: string) => Ed25519KeyPair;
}

/** An apply that stopped at a failure: `applied` lists the steps done before it. */
export class SftpApplyError extends OpsCrewError {
  readonly applied: SftpStep["kind"][];

  constructor(cause: unknown, applied: SftpStep["kind"][]) {
    const known = cause instanceof OpsCrewError;
    super(
      known ? cause.code : "PROVIDER_ERROR",
      `${known ? cause.message : "The SFTP host's answer was unexpected."} ${
        applied.length === 0
          ? "Nothing was changed before it."
          : `OpsCrew made ${applied.length} of the plan's changes before it, each recorded in .opscrew/hosting.json.`
      }`,
      { ...(known && cause.hint !== undefined ? { hint: cause.hint } : {}), cause },
    );
    this.name = "SftpApplyError";
    this.applied = applied;
  }
}

/** The archive's bytes. */
async function tarBytes(entries: Parameters<typeof tarStream>[0]): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream(entries)) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** The app's folder as one archive, its paths from the folder it is in (027 plan 5's modes). */
function folderTar(name: string, placeholder: string): Promise<Uint8Array> {
  const parts = placeholder.split("/");
  const dir = (path: string, mode: number) => ({
    name: `${name}${path === "" ? "" : `/${path}`}/`,
    type: "dir" as const,
    mode,
    uid: 0,
    gid: 0,
  });
  return tarBytes([
    dir("", 0o711),
    dir("shared", 0o711),
    dir("state", 0o700),
    ...parts.map((_, i) => dir(parts.slice(0, i + 1).join("/"), 0o711)),
    {
      name: `${name}/current`,
      type: "symlink",
      mode: 0o777,
      uid: 0,
      gid: 0,
      target: parts.slice(0, 2).join("/"),
    },
  ]);
}

/**
 * Applies an approved SFTP host's plan: refuses with `PLAN_HASH_MISMATCH` before any change when
 * its hash isn't `approvedHash`. The steps then run in order, each object made recorded at once,
 * and the first failure stops with an {@link SftpApplyError}. The key's private half goes only to
 * `ctx.storeKey`. Answers the steps applied, and the key's line when the user adds it in the panel.
 */
export async function applySftpPlan(
  plan: SftpPlan,
  ctx: SftpApplyContext & { approvedHash: string },
): Promise<{ applied: SftpStep["kind"][]; keyLine?: string }> {
  if (!isPlanHash(ctx.approvedHash) || ctx.approvedHash.toLowerCase() !== sftpPlanHash(plan)) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This hosting plan is not the one that was approved, so OpsCrew changes nothing on the SFTP host.",
      { hint: "Look at the current hosting plan and approve it by its hash." },
    );
  }
  const applied: SftpStep["kind"][] = [];
  let keyLine: string | undefined;
  for (const step of plan.steps) {
    try {
      keyLine = (await applyStep(plan, step, ctx)) ?? keyLine;
    } catch (error) {
      throw new SftpApplyError(error, applied);
    }
    applied.push(step.kind);
  }
  return { applied, ...(keyLine !== undefined ? { keyLine } : {}) };
}

async function applyStep(
  plan: SftpPlan,
  step: SftpStep,
  ctx: SftpApplyContext,
): Promise<string | undefined> {
  const { files } = ctx;
  const { folder } = plan;
  const encode = (text: string) => new TextEncoder().encode(text);
  switch (step.kind) {
    case "folder": {
      await requireNoFolder(files, folder);
      const parent = posix.dirname(folder);
      await files.uploadTar(parent, await folderTar(posix.basename(folder), step.placeholder));
      if (step.parent) await ctx.made({ kind: "folder", key: parent });
      await ctx.made({ kind: "folder", key: folder });
      return undefined;
    }
    case "file": {
      const text = ctx.contents.get(step.path);
      if (text === undefined || sha256Hex(text) !== step.sha256) {
        throw new OpsCrewError(
          "INTERNAL",
          `OpsCrew has no content for ${step.path} that matches the approved plan.`,
          { hint: "This is a bug in OpsCrew; please report it." },
        );
      }
      await files.writeFile(`${folder}/${step.path}`, encode(text), step.mode);
      return undefined;
    }
    case "values": {
      const values = ctx.values ?? {};
      if (valuesDigest(values) !== step.digest) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "The app's values changed after this hosting plan was made, so OpsCrew didn't write them.",
          { hint: "Run `opscrew provision` again to make a plan with the values as they are now." },
        );
      }
      const text = Object.keys(values)
        .sort()
        .map((name) => `${valuesLine(name, values[name] ?? "")}\n`)
        .join("");
      await files.writeFile(`${folder}/shared/.env`, encode(text), 0o600);
      await ctx.made({ kind: "file", key: `${folder}/shared/.env`, value: step.digest });
      return undefined;
    }
    case "ci-key": {
      const pair = (ctx.newKeyPair ?? generateEd25519KeyPair)(ctx.keyComment);
      ctx.redactor.addLiteral(pair.privateKeyOpenSsh, "the SFTP key of GitHub Actions");
      await ctx.storeKey(pair.privateKeyOpenSsh);
      const line = `restrict ${pair.publicKeyOpenSsh}`;
      if (!step.authorizedKeys) {
        await ctx.made({ kind: "panel-step", key: CI_KEY_STEP, value: line });
        return line;
      }
      const keys = (await files.readFile(AUTHORIZED_KEYS)) ?? "";
      const before = keys === "" || keys.endsWith("\n") ? keys : `${keys}\n`;
      await files.writeFile(AUTHORIZED_KEYS, encode(`${before}${line}\n`), 0o600);
      await ctx.made({ kind: "file", key: AUTHORIZED_KEYS, value: line });
      return undefined;
    }
    default:
      return step satisfies never;
  }
}
