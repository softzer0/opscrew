import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EnvironmentView,
  ImageProvenance,
  RegistryCredential,
  WorkflowRunSource,
} from "@opscrew/connector-github";
import type { ProjectPaths } from "@opscrew/core";
import { sha256Hex } from "@opscrew/core";
import { environmentTag } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../../context";
import type { DriftReport } from "../../drift";
import { environmentPaths } from "../../environments";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDeps,
  testPlan,
} from "../../testing";
import { promotionFile } from "../record";
import type { PromoteGitHubApi, PromoteServices } from "../types";

/** A GHCR digest from a seed (a hash, not a secret). */
export const digestOf = (seed: string) => `sha256:${sha256Hex(`image:${seed}`)}`;
/** A git commit from a seed. */
export const commitOf = (seed: string) => sha256Hex(`commit:${seed}`).slice(0, 40);

/** What staging runs: built by run 501 from main. */
export const STAGING_IMAGE = digestOf("staging");
export const STAGING_COMMIT = commitOf("staging");
export const STAGING_RUN = 501;
/** What prod ran before (its `opscrew-prod-previous`): built by run 400 from main. */
export const PREVIOUS_IMAGE = digestOf("previous");
export const PREVIOUS_COMMIT = commitOf("previous");
/** What prod runs now (its `opscrew-prod`). */
export const PROD_IMAGE = digestOf("prod");

/** The promotion's deploy run. */
export const DEPLOY_RUN_URL = "https://github.com/acme/shop/actions/runs/777";

const buildRunUrl = (runId: number) =>
  `https://github.com/acme/shop/actions/runs/${runId}/attempts/1`;

/** `git hash-object` of a text, as GitHub's contents API gives it. */
export function blobOf(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

/** Each environment's deploy workflow as the repository holds it (what provision rendered). */
export const WORKFLOWS: Readonly<Record<string, string>> = {
  ".github/workflows/opscrew-deploy.yml": "name: OpsCrew deploy\n# prod, promoted from staging\n",
  ".github/workflows/opscrew-deploy-qa.yml": "name: OpsCrew deploy (qa)\n# promoted from staging\n",
};

/** GitHub and GHCR fake: label and commit tags, provenance, run records, dispatches. */
export class FakePromoteGitHub implements PromoteGitHubApi {
  /** GHCR tags of `ghcr.io/acme/shop`: tag → digest. */
  readonly tags = new Map<string, string>();
  /** The SLSA provenance of each image, by digest. */
  readonly provenance = new Map<string, ImageProvenance>();
  /** GitHub's records of workflow runs, by id. */
  readonly runs = new Map<number, WorkflowRunSource>();
  /** The registry credential of every GHCR read. */
  readonly credentials: (RegistryCredential | undefined)[] = [];
  readonly dispatches: { workflowFile: string; ref: string; inputs: Record<string, string> }[] =
    [];
  /** Thrown by `dispatchWorkflow` before GitHub accepted anything. */
  dispatchError: Error | undefined;
  /** Thrown by `dispatchWorkflow` after GitHub accepted the dispatch (`onAccepted` ran). */
  afterAcceptedError: Error | undefined;
  /** Thrown by `waitForWorkflowRun`. */
  waitError: Error | undefined;
  /** The deploy run's conclusion. */
  conclusion: string | null = "success";
  /** The blob SHA of each file on the default branch, `main`: the merged workflows. */
  readonly onMain = new Map(Object.entries(WORKFLOWS).map(([path, text]) => [path, blobOf(text)]));

  async getRepo() {
    return { defaultBranch: "main", private: true, canPush: true };
  }

  /** The repository's GitHub environments with their rules, by name. */
  readonly environments = new Map<string, EnvironmentView>();
  async getEnvironment(_owner: string, _repo: string, name: string) {
    return this.environments.get(name);
  }

  async fileSha(_owner: string, _repo: string, path: string, ref: string) {
    return ref === "main" ? this.onMain.get(path) : undefined;
  }

  async taggedDigest(_owner: string, _image: string, tag: string, credential?: RegistryCredential) {
    this.credentials.push(credential);
    return this.tags.get(tag);
  }

  async imageProvenance(
    _owner: string,
    _image: string,
    digest: string,
    credential?: RegistryCredential,
  ) {
    this.credentials.push(credential);
    return this.provenance.get(digest);
  }

  async workflowRun(_owner: string, _repo: string, runId: number) {
    return this.runs.get(runId);
  }

  async dispatchWorkflow(
    _owner: string,
    _repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string> = {},
    onAccepted?: () => Promise<void>,
  ) {
    if (this.dispatchError !== undefined) throw this.dispatchError;
    this.dispatches.push({ workflowFile, ref, inputs });
    await onAccepted?.();
    if (this.afterAcceptedError !== undefined) throw this.afterAcceptedError;
    return { runId: 777, url: DEPLOY_RUN_URL };
  }

  /**
   * The deploy run's required reviewer: `none`; `approves` (the run waits for them first, and
   * `onWaiting` is told); `pending` (still waiting when the wait ends).
   */
  reviewer: "none" | "approves" | "pending" = "none";
  /** What GitHub shows when a run is read later (default: as the wait would end now). */
  reread: { status: string; conclusion: string | null } | undefined;
  async waitForWorkflowRun(
    _owner: string,
    _repo: string,
    options: { runId?: number; onWaiting?: (htmlUrl: string) => Promise<void> | void },
  ) {
    if (this.waitError !== undefined) throw this.waitError;
    if (this.reviewer !== "none") await options.onWaiting?.(DEPLOY_RUN_URL);
    const waiting = this.reviewer === "pending";
    return {
      id: options.runId ?? 777,
      status: waiting ? ("waiting" as const) : ("completed" as const),
      conclusion: waiting ? null : this.conclusion,
      htmlUrl: DEPLOY_RUN_URL,
    };
  }

  /** Workflow runs read with `getWorkflowRun`, by id. */
  readonly reads: number[] = [];
  async getWorkflowRun(_owner: string, _repo: string, runId: number) {
    this.reads.push(runId);
    const waiting = this.reviewer === "pending";
    return {
      id: runId,
      status: waiting ? "waiting" : "completed",
      conclusion: waiting ? null : this.conclusion,
      ...this.reread,
      htmlUrl: DEPLOY_RUN_URL,
      headSha: STAGING_COMMIT,
      createdAt: "2026-10-11T12:00:00Z",
    };
  }

  /**
   * An image the deploy workflow of `environment` (default staging) built: its provenance names
   * run `runId`, GitHub's record of that run shows a push of `commit` to `main` from that
   * environment's workflow, and GHCR tags the image with the environment's commit tag (`<commit>`
   * for prod, `<commit>-<env>` for another). `run` changes the record.
   */
  build(
    digest: string,
    build: {
      runId: number;
      commit: string;
      environment?: string;
      run?: Partial<WorkflowRunSource>;
    },
  ): void {
    const environment = build.environment ?? "staging";
    this.provenance.set(digest, {
      builderId: buildRunUrl(build.runId),
      runId: build.runId,
      repository: "acme/shop",
    });
    this.runs.set(build.runId, {
      repository: "acme/shop",
      headRepository: "acme/shop",
      event: "push",
      headBranch: "main",
      headSha: build.commit,
      path: `.github/workflows/opscrew-deploy${environment === "prod" ? "" : `-${environment}`}.yml`,
      ...build.run,
    });
    this.tags.set(environmentTag(build.commit, environment), digest);
  }
}

/** A clean drift report: nothing changed outside OpsCrew and nothing waiting for provision. */
export function cleanDrift(changes: Partial<DriftReport> = {}): DriftReport {
  return {
    drift: [],
    pending: [],
    files: { changed: [], created: [] },
    foreignDnsRecords: [],
    clean: true,
    engine: { name: "tofu", version: "1.10.0", binary: "/fake/tofu" },
    checkedAt: "2026-10-11T12:00:00.000Z",
    provider: "hetzner",
    ...changes,
  };
}

type Environment = NonNullable<DeployPlan["environment"]>;

/** `prod` as the plan of the environment `name`, as design writes it. */
export function inEnvironment(
  prod: DeployPlan,
  name: string,
  block: Partial<Omit<Environment, "name">> = {},
): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name, ...block },
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
    dns: prod.dns.domain === undefined ? prod.dns : { ...prod.dns, domain: `${name}.example.com` },
  });
}

/** A runner whose git knows the GitHub remote `acme/shop`. */
function gitRemote(): ScriptedRunner {
  return new ScriptedRunner((_command, args) =>
    args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "not scripted" },
  );
}

/** The environment's recorded promotion (`promotion.json`), or `undefined` when there is none. */
export async function recordedPromotion(paths: ProjectPaths): Promise<unknown> {
  return readFile(promotionFile(paths), "utf8").then(
    (text) => JSON.parse(text),
    () => undefined,
  );
}

export interface PromoteWorld {
  deps: TestPhaseDeps;
  github: FakePromoteGitHub;
  handler: ScriptedApprovalHandler;
  services: PromoteServices;
  /** The paths each drift check ran with. */
  driftPaths: ProjectPaths[];
  /** What the drift check reports (clean by default). */
  drift: { report: DriftReport };
  /** Writes `plan` as the environment `name`'s plan. */
  writePlan(name: string, plan: DeployPlan): Promise<void>;
  /** Writes a file of the repository's working tree. */
  writeRepoFile(path: string, text: string): Promise<void>;
  prodPlan: DeployPlan;
  stagingPlan: DeployPlan;
}

export interface PromoteWorldOptions {
  /** Changes to prod's plan (promoted from staging, deployed). */
  prod?: (plan: DeployPlan) => DeployPlan;
  /** Changes to staging's plan (deployed from main, deployed). */
  staging?: (plan: DeployPlan) => DeployPlan;
  env?: Record<string, string | undefined>;
  /** The environment the deps are built for (default: prod, the target). */
  environment?: string;
  approve?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
}

/**
 * An app with staging (deployed from main) and prod (promoted from staging), both deployed, with
 * every promoted environment's workflow in the working tree and merged on main. GHCR labels
 * staging's image `opscrew-staging`, prod's running image `opscrew-prod` and its previous one
 * `opscrew-prod-previous`, each built by a push of this repository to main.
 */
export async function promoteWorld(options: PromoteWorldOptions = {}): Promise<PromoteWorld> {
  const handler = new ScriptedApprovalHandler(options.approve ?? (() => true));
  const deps = await createTestPhaseDeps({
    runner: gitRemote(),
    approvalHandler: handler,
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
  });
  if (options.env !== undefined) Object.assign(deps.env, options.env);
  const writePlan = (name: string, plan: DeployPlan) =>
    writeArtifact("plan", environmentPaths(deps.paths, name).files.plan, plan);
  const writeRepoFile = async (path: string, text: string) => {
    const file = join(deps.paths.root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };

  const base = testPlan({ domain: "shop.example.com", deployed: true });
  const promotedProd = DeployPlanSchema.parse({
    ...base,
    environment: { deploySource: { from: "promote", source: "staging" } },
  });
  const prodPlan = options.prod?.(promotedProd) ?? promotedProd;
  const plainStaging = inEnvironment(base, "staging");
  const stagingPlan = options.staging?.(plainStaging) ?? plainStaging;
  await writePlan("prod", prodPlan);
  await writePlan("staging", stagingPlan);
  for (const [path, text] of Object.entries(WORKFLOWS)) await writeRepoFile(path, text);

  const github = new FakePromoteGitHub();
  github.build(STAGING_IMAGE, { runId: STAGING_RUN, commit: STAGING_COMMIT });
  github.build(PREVIOUS_IMAGE, { runId: 400, commit: PREVIOUS_COMMIT });
  github.build(PROD_IMAGE, { runId: 450, commit: commitOf("prod") });
  github.tags.set("opscrew-staging", STAGING_IMAGE);
  github.tags.set("opscrew-prod", PROD_IMAGE);
  github.tags.set("opscrew-prod-previous", PREVIOUS_IMAGE);

  const driftPaths: ProjectPaths[] = [];
  const drift = { report: cleanDrift() };
  const services: PromoteServices = {
    github,
    drift: async (target: PhaseDeps) => {
      driftPaths.push(target.paths);
      return drift.report;
    },
  };
  return {
    deps,
    github,
    handler,
    services,
    driftPaths,
    drift,
    writePlan,
    writeRepoFile,
    prodPlan,
    stagingPlan,
  };
}
