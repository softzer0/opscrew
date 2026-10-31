import type {
  ImageFacts,
  ImagePlatform,
  RegistryCredential,
  WorkflowRunSource,
} from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { environmentPaths } from "../../environments";
import { commitOf, digestOf, FakePromoteGitHub } from "../../promote/__fixtures__/world";
import { createTestPhaseDeps, type TestPhaseDeps } from "../../testing";
import type { VersionsGitHubApi } from "../types";

/** GHCR's refusal of a token without `read:packages`, as the connector words it. */
export function ghcrDenied(what: string): OpsCrewError {
  return new OpsCrewError("CREDENTIALS_INVALID", `GHCR refused to ${what}.`, {
    hint: "GitHub's container registry needs a classic token with read:packages, since it may not accept fine-grained tokens. Set OPSCREW_GHCR_READ_TOKEN to one, then run the command again.",
  });
}

/**
 * Promote's GitHub and GHCR fake, plus what the versions read: the workflow's runs (from the run
 * records `build` writes), GHCR's tag list and a file's text at a commit.
 */
export class FakeRollbackGitHub extends FakePromoteGitHub implements VersionsGitHubApi {
  /** GHCR refuses the tag list, as it does a token without `read:packages`. */
  denied = false;
  /** Each file's text, by `<ref>:<path>`. */
  readonly files = new Map<string, string>();
  /** The options of every `listWorkflowRuns`. */
  readonly runLists: { workflowFile: string; branch?: string; perPage?: number }[] = [];
  /** Digests GHCR still tags but no longer has the image of. */
  readonly lost = new Set<string>();
  /** The tags of every `describeTags`. */
  readonly described: string[][] = [];

  async listWorkflowRuns(
    _owner: string,
    _repo: string,
    options: { workflowFile: string; branch?: string; event?: string; perPage?: number },
  ) {
    this.runLists.push(options);
    return [...this.runs.entries()]
      .filter(([, run]) => run.path.endsWith(`/${options.workflowFile}`))
      .filter(([, run]) => options.branch === undefined || run.headBranch === options.branch)
      .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.perPage ?? 5)
      .map(([id, run]) => ({
        id,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: `https://github.com/acme/shop/actions/runs/${id}`,
        headSha: run.headSha,
        createdAt: run.createdAt,
        event: run.event,
        headBranch: run.headBranch,
        ...(run.headCommit !== undefined ? { headCommit: run.headCommit } : {}),
      }));
  }

  async imageTags(owner: string, image: string, credential?: RegistryCredential) {
    this.credentials.push(credential);
    this.images.push(`${owner}/${image}`);
    if (this.denied) throw ghcrDenied(`list the tags of ghcr.io/${owner}/${image}`);
    return [...this.tags.keys()].sort();
  }

  async describeTags(
    owner: string,
    image: string,
    tags: string[],
    credential?: RegistryCredential,
  ): Promise<{ tag: string; digest?: string; facts?: ImageFacts }[]> {
    this.credentials.push(credential);
    this.images.push(`${owner}/${image}`);
    this.described.push(tags);
    return tags.map((tag) => {
      const digest = this.tags.get(tag);
      if (digest === undefined) return { tag };
      if (this.lost.has(digest)) return { tag, digest };
      const provenance = this.provenance.get(digest);
      const platforms = this.platforms.get(digest);
      return { tag, digest, facts: { provenance, platforms } };
    });
  }

  async fileText(_owner: string, _repo: string, path: string, ref: string) {
    return this.files.get(`${ref}:${path}`);
  }
}

/** A build of the deploy workflow, as `VersionsWorld.deploy` records it. */
export interface Built {
  digest: string;
  commit: string;
  runId: number;
}

export interface VersionsWorld {
  deps: TestPhaseDeps;
  github: FakeRollbackGitHub;
  /** Writes `plan` as the environment `name`'s plan. */
  writePlan(name: string, plan: DeployPlan): Promise<void>;
  /**
   * A run of `environment`'s deploy workflow (default prod) for the commit of `seed`, created at
   * minute `minute` of 2026-10-20 10:00 UTC: a push to main that succeeded, whose image (built for
   * linux/amd64) GHCR tags with the environment's commit tag. `run` changes GitHub's record of the
   * run; `platforms` the image's CPUs.
   */
  deploy(
    seed: string,
    minute: number,
    options?: {
      environment?: string;
      /** The commit, instead of the one of `seed`. */
      commit?: string;
      run?: Partial<WorkflowRunSource>;
      platforms?: ImagePlatform[];
    },
  ): Built;
  /** Labels the image of `built` `opscrew-<environment>` (`previous`: `…-previous`). */
  label(environment: string, built: Built, previous?: boolean): void;
}

/** The time of minute `minute` of 2026-10-20 10:00 UTC. */
export function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 20, 10, minute)).toISOString().replace(".000Z", "Z");
}

/** An empty project whose deps are built for `environment` (default prod), with no plan yet. */
export async function versionsWorld(
  options: { environment?: string; env?: Record<string, string> } = {},
): Promise<VersionsWorld> {
  const deps = await createTestPhaseDeps(
    options.environment !== undefined ? { environment: options.environment } : {},
  );
  if (options.env !== undefined) Object.assign(deps.env, options.env);
  const github = new FakeRollbackGitHub();
  let runId = 100;
  return {
    deps,
    github,
    writePlan: (name, plan) =>
      writeArtifact("plan", environmentPaths(deps.paths, name).files.plan, plan),
    deploy(seed, minute, deployOptions = {}) {
      const environment = deployOptions.environment ?? "prod";
      const digest = digestOf(`${environment}:${seed}`);
      const commit = deployOptions.commit ?? commitOf(seed);
      runId++;
      github.build(digest, {
        runId,
        commit,
        environment,
        run: {
          createdAt: at(minute),
          headCommit: { message: `${seed}\n\nThe body.`, timestamp: at(minute) },
          ...deployOptions.run,
        },
      });
      if (deployOptions.platforms !== undefined) github.platforms.set(digest, deployOptions.platforms);
      return { digest, commit, runId };
    },
    label(environment, built, previous = false) {
      github.tags.set(`opscrew-${environment}${previous ? "-previous" : ""}`, built.digest);
    },
  };
}
