import type { GitHubClient } from "@opscrew/connector-github";
import type { ProjectPaths } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { AppImage } from "../promote/image";
import type { PromoteGitHubApi } from "../promote/types";

/**
 * The GitHub and GHCR calls the versions of an environment need: promote's, plus the workflow's
 * runs, GHCR's tags and a file's text (a `GitHubClient` or a test fake).
 */
export type VersionsGitHubApi = PromoteGitHubApi &
  Pick<GitHubClient, "listWorkflowRuns" | "imageTags" | "describeTags" | "fileText">;

/** The app's image on GHCR, read with the calls the versions need. */
export interface VersionsImage extends AppImage {
  github: VersionsGitHubApi;
}

/**
 * `running`: the image the environment runs (its `opscrew-<env>` label). `previous`: the version a
 * rollback goes back to by default (ADR 0023 D4).
 */
export type VersionMark = "running" | "previous";

/** One image of a server environment, by its digest (data-model.md "A version"). */
export interface Version {
  /** `sha256:…`. */
  digest: string;
  /** `ghcr.io/<owner>/<repo>[/<key>]@<digest>`. */
  image: string;
  /** Its commit tag: `<commit>` (prod) or `<commit>-<env>`, a promoted environment's builder's form. */
  tag: string;
  commit: string;
  /** The first line of the commit's message, redacted; absent when GitHub gave none. */
  message?: string;
  /** When its build run was created (ISO 8601). */
  builtAt: string;
  /** The build run its provenance names. */
  runUrl: string;
  /** The build run's conclusion was `success`. */
  buildSucceeded: boolean;
  marks: VersionMark[];
}

/**
 * A version as the rollback's output and `status` show it, on any target: a server's image (a
 * {@link Version} is one), this computer's image, a Worker version or a GitHub Pages run.
 */
export interface VersionView {
  /** The image's digest, `sha256:…`. */
  digest?: string;
  /** A Worker version's id, or a GitHub Pages run's id. */
  version?: string;
  commit?: string;
  message?: string;
  /** When it was built or created (ISO 8601). */
  builtAt?: string;
  marks?: VersionMark[];
}

/** An image of the environment that is not offered, and why (FR-1903). */
export interface LeftOutVersion {
  commit: string;
  /** Absent when GHCR no longer has the image. */
  digest?: string;
  /** Plain words, for example that it is built for another CPU. */
  reason: string;
}

/** The environment's versions, newest first, and the images left out. */
export interface VersionList {
  versions: Version[];
  leftOut: LeftOutVersion[];
  /** The digest `opscrew-<env>` names, even when that image is not listed. */
  running?: string;
  /** The digest `opscrew-<env>-previous` names, even when that image is not listed. */
  previous?: string;
}

/** The environment whose versions are listed. */
export interface VersionsContext {
  image: VersionsImage;
  /** The environment's plan (a server environment's). */
  plan: DeployPlan;
  /** The environment's paths; `paths.environment` names it. */
  paths: ProjectPaths;
}
