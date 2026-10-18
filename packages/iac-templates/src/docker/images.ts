import { OpsCrewError } from "@opscrew/core";
import type { AppBuild, ProjectFacts } from "@opscrew/plan-schema";
import { IMAGES, type ImagePin, RUNTIME_DEFAULTS } from "../pins";

/**
 * Looks up the digest (`sha256:<hex>`) of an image tag such as `node:20-alpine` in its registry;
 * undefined when it cannot (offline).
 */
export type ResolveImageDigest = (ref: string) => string | undefined;

/** A base image as a Dockerfile names it. */
export interface BaseImage {
  /** `repo:tag@sha256:<hex>`, or `repo:tag` when no digest was found. */
  ref: string;
  /** The tag, for the note when the image is pinned by tag only. */
  tag: string;
  tagOnly: boolean;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The image for `tag`: OpsCrew's pin when the tag is the pinned one, else the tag with the digest
 * `resolve` finds, else the tag alone.
 */
function baseImage(tag: string, pin: ImagePin, resolve?: ResolveImageDigest): BaseImage {
  if (pin.ref.startsWith(`${tag}@`)) return { ref: pin.ref, tag, tagOnly: false };
  const digest = resolve?.(tag);
  if (digest === undefined) return { ref: tag, tag, tagOnly: true };
  if (!DIGEST.test(digest)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The registry lookup returned "${digest}" as the digest of ${tag}, which is not a sha256 digest.`,
      { hint: "Run the command again; if it keeps failing, report it to OpsCrew." },
    );
  }
  return { ref: `${tag}@${digest}`, tag, tagOnly: false };
}

/** The plan's runtime version for `language`, when design recorded one. */
function plannedVersion(build: AppBuild | undefined, language: "node" | "python") {
  return build?.runtime.language === language ? build.runtime.version : undefined;
}

/** Node.js major: the plan's, else the one the app declares (`20`, `^20.11`, `v20`), else LTS. */
export function nodeMajor(facts: ProjectFacts, build: AppBuild | undefined): string {
  return (
    plannedVersion(build, "node")?.split(".")[0] ??
    facts.runtimeVersions.node?.match(/^[v^~=]*(\d+)/)?.[1] ??
    RUNTIME_DEFAULTS.node
  );
}

/** Python `major.minor`: the plan's, else the one the app declares (`3.12.4`), else the default. */
export function pythonMinor(facts: ProjectFacts, build: AppBuild | undefined): string {
  return (
    plannedVersion(build, "python")?.match(/^\d+\.\d+/)?.[0] ??
    facts.runtimeVersions.python?.match(/^3\.\d+/)?.[0] ??
    RUNTIME_DEFAULTS.python
  );
}

/** `node:<major>-alpine`, pinned. */
export function nodeImage(major: string, resolve?: ResolveImageDigest): BaseImage {
  return baseImage(`node:${major}-alpine`, IMAGES.nodeAlpine, resolve);
}

/** `python:<major.minor>-slim`, pinned. */
export function pythonImage(minor: string, resolve?: ResolveImageDigest): BaseImage {
  return baseImage(`python:${minor}-slim`, IMAGES.python, resolve);
}

/** Header lines saying an image is pinned by tag only, and how to pin it (none when pinned). */
export function tagOnlyNote(image: BaseImage): string[] {
  if (!image.tagOnly) return [];
  return [
    `# ${image.tag} is pinned by tag only: OpsCrew could not look up its digest. Pin it by adding`,
    `# @sha256:<digest> to the FROM lines (\`docker buildx imagetools inspect ${image.tag}\` shows it).`,
  ];
}
