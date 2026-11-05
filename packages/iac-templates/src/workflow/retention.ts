import { MANIFEST_ACCEPT } from "../registry";
import type { AppEnvironment } from "../runtime-dir";
import {
  appFlag,
  DIGEST_REF_PATTERN,
  environmentName,
  environmentTag,
  planFilePath,
  workflowName,
} from "./shared";

/** How many days a pull request's image stays before every deploy workflow's prune deletes it. */
const PREVIEW_IMAGE_DAYS = 31;

/**
 * A pull request's image tag in the image programs, `pr-<n>-<commit>` or its intermediate
 * `build-pr-<n>-<commit>`, the number its group.
 */
export const PULL_TAG = "^(?:build-)?pr-([1-9][0-9]{0,5})-[0-9a-f]{40}$";

/**
 * The JavaScript the image programs' selections share, inside them (indented for it, beside their
 * `children` parameter): `reach(digests)`, the digests, everything they list, and what that lists
 * in turn.
 */
export const REACH = `const reach = (digests) => {
    const seen = new Set(digests);
    const queue = [...digests];
    while (queue.length > 0) {
      for (const digest of children[queue.pop()] || []) {
        if (!seen.has(digest)) {
          seen.add(digest);
          queue.push(digest);
        }
      }
    }
    return seen;
  };`;

/**
 * The JavaScript the image programs share, inside their `main` (indented for it), for the app's
 * own package (`<owner>/<repo>`, a further app's `<owner>/<repo>/<key>`: plan-schema's
 * `ghcrImageFor`): `owner`, `repo` and `name`; `read` and `github` (the GitHub API with `TOKEN`);
 * `packageVersions()`, the package's versions API under the owner's kind of account;
 * `readPackage(base, protect)`, the versions and what each tagged or protected one lists, read again
 * while a version goes during the reading; and `deleteVersions(base, versions, ids)`, which deletes
 * those `ids` and returns how many GitHub did not delete. They read `GITHUB_REPOSITORY`,
 * `GITHUB_ACTOR` and `TOKEN`. `pages(path, what, field)` reads every page of a GitHub API list
 * (`what` names the API in errors; `field`, when given, is the answer's list).
 */
export function registryCode(plan: AppEnvironment): string {
  const key = plan.app.key;
  return `const [owner, repo] = process.env.GITHUB_REPOSITORY.toLowerCase().split("/");
  // The app's own package: ghcr.io/<owner>/<repo>${key === undefined ? "" : `/${key}`}.
  const name = ${key === undefined ? "repo" : `repo + "/${key}"`};
  const token = process.env.TOKEN;
  const read = async (response, what) => {
    if (!response.ok) {
      throw Object.assign(new Error(what + " answered HTTP " + response.status), { status: response.status });
    }
    return response.json();
  };
  const github = (method, path) =>
    fetch("https://api.github.com" + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  const pages = async (path, what, field) => {
    const all = [];
    for (let page = 1; ; page++) {
      const body = await read(await github("GET", path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page), what);
      const batch = field === undefined ? body : body[field];
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  };
  const packageVersions = async () => {
    const user = await read(await github("GET", "/users/" + owner), "The GitHub users API");
    return (
      (user.type === "Organization" ? "/orgs/" : "/users/") +
      owner + "/packages/container/" + encodeURIComponent(name) + "/versions"
    );
  };
  // The package's versions, and what each tagged or protected one lists.
  const survey = async (base, protect) => {
    const versions = (await pages(base, "The GitHub packages API")).map((v) => ({
      id: v.id,
      digest: v.name,
      tags: v.metadata.container.tags,
      created: v.created_at,
    }));
    const basic = Buffer.from(process.env.GITHUB_ACTOR + ":" + token).toString("base64");
    const scope = "repository:" + owner + "/" + name + ":pull";
    const login = await read(
      await fetch("https://ghcr.io/token?service=ghcr.io&scope=" + scope, { headers: { Authorization: "Basic " + basic } }),
      "GitHub Container Registry",
    );
    const children = {};
    const tagged = versions.filter((v) => v.tags.length > 0).map((v) => v.digest);
    for (const digest of new Set([...protect, ...tagged])) {
      const manifest = await read(
        await fetch("https://ghcr.io/v2/" + owner + "/" + name + "/manifests/" + digest, {
          headers: {
            Authorization: "Bearer " + login.token,
            Accept: ${JSON.stringify(MANIFEST_ACCEPT)},
          },
        }),
        "GitHub Container Registry",
      );
      children[digest] = (manifest.manifests || []).map((m) => m.digest);
    }
    return { versions, children };
  };
  // Another run may delete versions while this one reads them (one merge runs several
  // environments' workflows): the registry then answers 404 for a version the list still has.
  // Read it all again; a 404 that stays still stops, so nothing is deleted on a guess.
  const readPackage = async (base, protect) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await survey(base, protect);
      } catch (error) {
        if (error.status !== 404 || attempt === 3) throw error;
        console.log("A version went while OpsCrew read the package (HTTP 404); reading it again in 20 s.");
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
    }
  };
  const deleteVersions = async (base, versions, ids) => {
    let failed = 0;
    for (const v of versions.filter((version) => ids.has(version.id))) {
      const response = await github("DELETE", base + "/" + v.id);
      const what = v.digest + (v.tags.length > 0 ? " (" + v.tags.join(", ") + ")" : "");
      if (response.ok) {
        console.log("Deleted " + what);
      } else if (response.status === 404) {
        // Another run deleted it first.
        console.log("Already deleted: " + what);
      } else {
        failed++;
        console.log("::warning::GitHub did not delete " + what + ": HTTP " + response.status + ".");
      }
    }
    return failed;
  };`;
}

/**
 * The image retention step's program (FR-1229) in the workflow of the plan's app's environment,
 * run with the runner's Node.js (`shell: node {0}`, followed by `main();`). It is plain JavaScript
 * in the committed workflow, so the user can read it and it needs no action or download; the tests
 * run this exact text. It works on the app's own package ({@link registryCode}).
 *
 * It deletes only the environment's own builds: the versions with its commit tag
 * ({@link environmentTag}: `<commit>` in prod's workflow, `<commit>-<env>` in another's) and its
 * `build-<commit tag>` intermediates. Another environment's builds and Buildpacks caches carry
 * tags it does not know, so it keeps them as it keeps the user's own: each environment's workflow
 * deletes its own, and keeps its newest `keep` however many the others build. Untagged versions
 * nothing kept lists go too, but only once they are 30 minutes old (unless a deleted version lists
 * them): two environments build at the same time, and another one's push has its platform
 * manifests untagged for a few seconds before the index that lists them arrives. Pull requests'
 * images (`pr-<n>-<commit>` and `build-pr-<n>-<commit>`, the preview workflow's) go too once they
 * are older than {@link PREVIEW_IMAGE_DAYS} days, retention on or off: a preview is removed after
 * at most 30 days without a push, so none of them still runs (research R5).
 *
 * `prunable` is the pure selection, which never deletes a version the label tags of one of the
 * app's environments mark (`opscrew-<env>` or `opscrew-<env>-previous`, from the label job). Any
 * other `opscrew-*` tag (an environment removed since, a stray one) keeps nothing. `main` reads
 * `IMAGE` (the running image), `PREVIOUS` (the image that ran before, empty on the first deploy),
 * `KEEP` (absent: delete only the intermediate images and old pull requests' images), `TOKEN`,
 * `GITHUB_REPOSITORY` and `GITHUB_ACTOR`; lists the app's environments from the repository's
 * workflows (one OpsCrew deploy workflow each, by its name: {@link workflowName}, which names the
 * app), the package's versions through the GitHub API and the image indexes' children from GitHub
 * Container Registry, and deletes what `prunable` selects. Any error before the first deletion
 * deletes nothing. The image reference pattern and the manifest types are OpsCrew's own
 * ({@link DIGEST_REF_PATTERN}, {@link MANIFEST_ACCEPT}), written into the program as literals.
 */
export function retentionScript(plan: AppEnvironment): string {
  const own = (commit: string) => environmentTag(commit, environmentName(plan));
  /** The app's prod workflow's name; another environment's adds ` (<env>)`. */
  const workflow = workflowName({ app: plan.app });
  return String.raw`// OpsCrew image retention (${planFilePath(plan)}, cicd.imageRetention): deletes old versions of
// this repository's image from GitHub Container Registry.

/**
 * The ids of the package versions to delete.
 * versions: [{ id, digest, tags, created }], as the GitHub API lists them.
 * children: by digest, the digests an image index lists (its platform manifests and attestations).
 * keep: how many ${own("<commit>")} versions to keep, newest first; undefined (retention off) deletes only
 * the build-${own("<commit>")} intermediates, old pull requests' images and what only they list.
 * protect: digests never deleted: the running and the previous image.
 * recent: a time (milliseconds since 1970): an untagged version created since then stays unless
 * a version deleted here lists it, since another environment's build may be pushing it right now.
 * environments: the names of the app's environments (prod and each one beside it).
 * previewsBefore: a time (milliseconds since 1970): a version whose every tag is a pull request's
 * (pr-<n>-<commit>, build-pr-<n>-<commit>) created before then goes, retention on or off.
 *
 * Kept: the protected digests, every version the label tags of one of the environments mark
 * (opscrew-<env>, the image it runs, and opscrew-<env>-previous, the one before), the newest keep
 * ${own("<commit>")} versions, versions with a tag this environment's builds did not push and that is no
 * other opscrew-* tag (yours, Buildpacks' caches, another environment's images, pull requests'
 * images until previewsBefore), signatures of kept images, and whatever a kept index lists, tagged
 * or not. Deleted: build-${own("<commit>")} intermediates, older ${own("<commit>")} versions with their
 * signatures, old pull requests' images, and untagged versions nothing kept lists, once they are
 * older than recent.
 */
function prunable(versions, children, keep, protect, recent, environments, previewsBefore) {
  const commit = (tag) => /^${own("[0-9a-f]{40}")}$/.test(tag);
  const build = (tag) => /^build-${own("[0-9a-f]{40}")}$/.test(tag);
  const pull = (tag) => /${PULL_TAG}/.test(tag);
  const oldPull = (v) => v.tags.length > 0 && v.tags.every(pull) && Date.parse(v.created) < previewsBefore;
  const labels = new Set(environments.flatMap((env) => ["opscrew-" + env, "opscrew-" + env + "-previous"]));
  const label = (tag) => labels.has(tag);
  // An opscrew-* tag that labels none of the environments (one removed since, a stray one).
  const strayLabel = (tag) => /^opscrew-[a-z][a-z0-9-]*$/.test(tag) && !label(tag);
  const subject = (tag) => {
    const match = /^sha256-([0-9a-f]{64})(\.[a-z]+)?$/.exec(tag);
    return match ? "sha256:" + match[1] : undefined;
  };
  const ours = (tag) => commit(tag) || build(tag) || subject(tag) !== undefined || strayLabel(tag);
  const listed = (digests) => new Set([...digests].flatMap((digest) => children[digest] || []));

  const kept = new Set(protect);
  for (const v of versions) if (v.tags.some(label)) kept.add(v.digest);
  if (keep === undefined) {
    for (const v of versions) if (!v.tags.every(build) && !oldPull(v)) kept.add(v.digest);
  } else {
    const deployed = versions
      .filter((v) => v.tags.some(commit))
      .sort((a, b) => b.created.localeCompare(a.created) || b.id - a.id);
    for (const v of deployed.slice(0, keep)) kept.add(v.digest);
    for (const v of versions) if (!v.tags.every(ours) && !oldPull(v)) kept.add(v.digest);
    for (const v of versions) if (v.tags.some((tag) => kept.has(subject(tag)))) kept.add(v.digest);
  }

  // Everything a kept version lists, and what that lists in turn, stays.
  ${REACH}
  const reachable = reach(kept);
  const goes = (v) => !reachable.has(v.digest);
  const listedByDeleted = listed(versions.filter((v) => v.tags.length > 0 && goes(v)).map((v) => v.digest));
  // Another environment's build pushes its platform manifests and attestations untagged, moments
  // before the index that lists them: until then nothing lists them, so a recent one stays.
  const old = (v) => Date.parse(v.created) < recent;
  return versions
    .filter((v) => goes(v) && (v.tags.length > 0 || listedByDeleted.has(v.digest) || (keep !== undefined && old(v))))
    .map((v) => v.id);
}

async function main() {
  const fail = (message) => {
    console.log("::error::" + message);
    process.exitCode = 1;
  };
  const digestRef = new RegExp(${JSON.stringify(DIGEST_REF_PATTERN)});
  const digestOf = (ref) => (digestRef.test(ref) ? ref.split("@")[1] : undefined);
  const running = digestOf(process.env.IMAGE || "");
  const previous = process.env.PREVIOUS ? digestOf(process.env.PREVIOUS) : null;
  if (running === undefined || previous === undefined) {
    fail("OpsCrew could not tell which images the server runs, so it deleted none. The deploy itself succeeded.");
    return;
  }
  const protect = previous === null ? [running] : [running, previous];
  const keep = process.env.KEEP ? Number(process.env.KEEP) : undefined;
  // Untagged versions younger than 30 minutes stay: another environment may be pushing them.
  const recent = Date.now() - 30 * 60 * 1000;
  // Pull requests' images older than this go: no preview runs one that old.
  const previewsBefore = Date.now() - ${PREVIEW_IMAGE_DAYS} * 24 * 60 * 60 * 1000;
  ${registryCode(plan)}

  let deleting = false;
  try {
    // The app's environments: each has its OpsCrew deploy workflow, named "${workflow}" (prod)
    // or "${workflow} (<env>)".
    const environments = [];
    const workflows = await pages("/repos/" + owner + "/" + repo + "/actions/workflows", "The GitHub workflows API", "workflows");
    for (const w of workflows) {
      const match = /^${workflow}(?: \(([a-z][a-z0-9-]*)\))?$/.exec(w.name);
      if (match && w.state !== "deleted") environments.push(match[1] || "prod");
    }
    // None found means the workflows were renamed: no environment's labels could be kept.
    if (environments.length === 0) {
      fail(
        'OpsCrew found no workflow named "${workflow}" in this repository, so it cannot tell which images the environments run, and it deleted none. The deploy itself succeeded; run "opscrew provision${appFlag(plan)}" to write the deploy workflow again.',
      );
      return;
    }
    const base = await packageVersions();
    const { versions, children } = await readPackage(base, protect);
    const ids = new Set(prunable(versions, children, keep, protect, recent, environments, previewsBefore));
    console.log("The package has " + versions.length + " image versions; deleting " + ids.size + ".");
    deleting = true;
    const failed = await deleteVersions(base, versions, ids);
    if (failed > 0) {
      fail(failed + " image versions were not deleted; the next deploy tries again. The deploy itself succeeded.");
    }
  } catch (error) {
    fail(
      (deleting ? "OpsCrew stopped deleting old images: " : "OpsCrew could not list the images, so it deleted none: ") +
        error.message + ". The deploy itself succeeded; the next deploy tries again.",
    );
  }
}`;
}
