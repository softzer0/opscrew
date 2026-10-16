/**
 * Support code for the end-to-end tests over `examples/`: the examples and their `expected.json`
 * schema, the project's git repository with a bare `origin`, the fake secret values an example
 * plants, a snapshot of the materialised files and a leak search over every file a run wrote.
 */
import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { FAKE_SECRET_KINDS, type FakeSecretKind, fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import { EXAMPLES_DIR, git, type TempProject } from "../../src/ui/__fixtures__/harness";

/** Every example with an `expected.json`, sorted. */
export function exampleNames(): string[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(EXAMPLES_DIR, name, "expected.json")))
    .sort();
}

/** Interview answers for one small production setup; tests change only what they vary. */
export const BASE_ANSWERS: Readonly<Record<string, unknown>> = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "20 EUR",
  region: "eu-central",
  uptime: "standard",
  dataCriticality: "important",
};

/** The project's `opscrew/plan.yaml`, read and validated. */
export function readPlan(root: string): Promise<DeployPlan> {
  return readArtifact("plan", path.join(root, "opscrew", "plan.yaml"));
}

/**
 * Makes the project a git repository on `main` with one commit of everything, and a bare
 * `origin.git` next to it that receives every push. With `fetchUrl` (a GitHub URL, from which
 * provision reads the owner and name) `origin` fetches from there and pushes to the bare one.
 * Returns the bare repository's path.
 */
export async function initRepoWithBareOrigin(
  project: TempProject,
  fetchUrl?: string,
): Promise<string> {
  const { env, root, dir } = project;
  await git(env, root, "init", "-q", "-b", "main");
  await git(env, root, "add", "-A");
  await git(env, root, "commit", "-q", "-m", "initial import");
  const bare = path.join(dir, "origin.git");
  await git(env, dir, "init", "-q", "--bare", "-b", "main", bare);
  await git(env, root, "remote", "add", "origin", fetchUrl ?? bare);
  if (fetchUrl !== undefined) await git(env, root, "remote", "set-url", "--push", "origin", bare);
  return bare;
}

/** `examples/<name>/expected.json` (see `examples/README.md`). */
export const ExpectedSchema = z.strictObject({
  facts: z.strictObject({
    platformExport: z.strictObject({ platform: z.string().min(1) }),
    appKind: z.string().min(1),
    frameworkNames: z.array(z.string().min(1)).optional(),
    port: z.number().int().positive().optional(),
    services: z.array(z.string().min(1)).optional(),
    languages: z.array(z.string().min(1)).optional(),
    clientExposedEnv: z.array(z.string().min(1)).optional(),
    secretEnv: z.array(z.string().min(1)).optional(),
  }),
  scan: z.strictObject({
    clean: z.boolean(),
    mustInclude: z.array(z.string().min(1)),
    notes: z.string().optional(),
  }),
  codeChanges: z.array(z.string().min(1)).optional(),
  /** Monorepos: the app chosen in the interview and what analysis describes afterwards. */
  chosenApp: z
    .strictObject({
      appDir: z.string().min(1),
      appKind: z.string().min(1),
      frameworkNames: z.array(z.string().min(1)).optional(),
      port: z.number().int().positive().optional(),
    })
    .optional(),
});
export type Expected = z.infer<typeof ExpectedSchema>;

/** Reads and validates `<exampleDir>/expected.json`. */
export async function readExpected(exampleDir: string): Promise<Expected> {
  const text = await readFile(path.join(exampleDir, "expected.json"), "utf8");
  return ExpectedSchema.parse(JSON.parse(text));
}

/** Every file below `dir` (absolute paths), skipping `.git` directories and bare repositories. */
export async function listFiles(dir: string, skipDirs: readonly string[] = []): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || skipDirs.includes(full)) continue;
      files.push(...(await listFiles(full, skipDirs)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

const MARKER = /\{\{FAKE:([a-z0-9-]+)(?::([A-Za-z0-9_-]+))?\}\}/g;

/** The fake secret values the `{{FAKE:…}}` markers in `exampleDir` expand to (deduplicated). */
export async function plantedSecrets(exampleDir: string): Promise<string[]> {
  const values = new Set<string>();
  for (const file of await listFiles(exampleDir)) {
    const text = await readFile(file, "utf8");
    for (const [, kind, seed] of text.matchAll(MARKER)) {
      if (!(FAKE_SECRET_KINDS as readonly string[]).includes(kind ?? "")) {
        throw new Error(`Unknown fake secret kind "${kind}" in ${file}.`);
      }
      values.add(fakeSecret(kind as FakeSecretKind, seed ?? "opscrew"));
    }
  }
  return [...values];
}

/** Path → content of every file below `dir`, for telling inputs apart from what a run wrote. */
export async function snapshotFiles(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const file of await listFiles(dir)) snapshot.set(file, await readFile(file, "utf8"));
  return snapshot;
}

/** One place a planted secret showed up. */
export interface Leak {
  where: string;
  /** Index of the secret in the list that was searched for (never the value itself). */
  secret: number;
}

/**
 * Finds every secret in `texts` (labelled outputs) and in the files below `dir`. A file from
 * `inputs` (the materialised example) only counts when it now holds a secret it did not hold
 * before, so the planted values in the example's own source are not reported.
 */
export async function findLeaks(options: {
  secrets: readonly string[];
  texts: ReadonlyMap<string, string>;
  dir: string;
  inputs: ReadonlyMap<string, string>;
  skipDirs?: readonly string[];
}): Promise<Leak[]> {
  const leaks: Leak[] = [];
  const check = (where: string, text: string, before?: string) => {
    options.secrets.forEach((secret, i) => {
      if (text.includes(secret) && !(before ?? "").includes(secret))
        leaks.push({ where, secret: i });
    });
  };
  for (const [label, text] of options.texts) check(label, text);
  for (const file of await listFiles(options.dir, options.skipDirs)) {
    check(
      path.relative(options.dir, file).split(path.sep).join("/"),
      await readFile(file, "utf8"),
      options.inputs.get(file),
    );
  }
  return leaks;
}

/**
 * The scripted human for `adapt`: approves committing (`repo-write`) and refuses everything else
 * (pushing, pull requests, applies), recording every request it saw.
 */
export class ScriptedApprovals implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly approve: readonly ApprovalRequest["kind"][] = ["repo-write"]) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    const approved = this.approve.includes(request.kind);
    return {
      approved,
      approver: "e2e test",
      decidedAt: "2026-10-11T12:00:00.000Z",
      ...(approved ? {} : { reason: `the e2e script does not approve ${request.kind}` }),
    };
  }
}
