import type { AppEnvironment } from "../runtime-dir";
import { registryCode } from "./retention";
import { DIGEST_REF_PATTERN, planFilePath } from "./shared";

/**
 * The preview workflow's image cleanup program, run with the runner's Node.js (`shell: node {0}`,
 * followed by `main();`), plain JavaScript in the committed workflow as the image retention's
 * ({@link registryCode} holds what they share); the tests run this exact text.
 *
 * `previewPrunable` is the pure selection: pull requests' images (`pr-<n>-<commit>` and
 * `build-pr-<n>-<commit>`, every tag of the version one pull request's) of pull requests no longer
 * open, and this pull request's intermediates and, once its preview runs an image (`running`), its
 * other images; then what only deleted versions list. Never another tag, nor what a kept version
 * lists. `main` reads `NUMBER` (this pull request), `RUNNING` (the image its preview now runs;
 * absent when none is known: its images stay), `TOKEN`, `GITHUB_REPOSITORY` and `GITHUB_ACTOR`,
 * reads the package's versions, then the open pull requests (in that order, so a pull request
 * opened in between has no version in the list yet), and deletes what `previewPrunable` selects.
 * Any error before the first deletion deletes nothing.
 */
export function previewImagesScript(plan: AppEnvironment): string {
  return `// OpsCrew preview images (${planFilePath(plan)}, environment.previews): deletes the images of pull
// requests no longer open, and this pull request's older ones, from GitHub Container Registry.

/**
 * The ids of the package versions to delete.
 * versions, children: as the image retention reads them (each version's id, digest, tags and
 * creation time; by digest, what an image index lists).
 * open: the numbers of the repository's open pull requests.
 * number: this pull request's; running: the digest its preview runs, or null when none is known.
 */
function previewPrunable(versions, children, open, number, running) {
  const pullOf = (tag) => {
    const match = /^(?:build-)?pr-([1-9][0-9]{0,5})-[0-9a-f]{40}$/.exec(tag);
    return match ? Number(match[1]) : undefined;
  };
  const goes = (v) => {
    const pulls = new Set(v.tags.map(pullOf));
    if (v.tags.length === 0 || pulls.size !== 1 || pulls.has(undefined)) return false;
    const [pull] = pulls;
    if (!open.includes(pull)) return true;
    if (pull !== number) return false;
    return v.tags.every((tag) => tag.startsWith("build-")) || (running !== null && v.digest !== running);
  };
  const reach = (digests) => {
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
  };
  // Every tagged version that stays, and the running image, keep what they list.
  const kept = reach([
    ...versions.filter((v) => v.tags.length > 0 && !goes(v)).map((v) => v.digest),
    ...(running === null ? [] : [running]),
  ]);
  const deleted = reach(versions.filter(goes).map((v) => v.digest));
  return versions
    .filter((v) => (v.tags.length === 0 || goes(v)) && deleted.has(v.digest) && !kept.has(v.digest))
    .map((v) => v.id);
}

async function main() {
  const fail = (message) => {
    console.log("::error::" + message);
    process.exitCode = 1;
  };
  const number = Number(process.env.NUMBER);
  const digestRef = new RegExp(${JSON.stringify(DIGEST_REF_PATTERN)});
  const ref = process.env.RUNNING || "";
  const running = ref === "" ? null : digestRef.test(ref) ? ref.split("@")[1] : undefined;
  if (!/^[1-9][0-9]{0,5}$/.test(process.env.NUMBER || "") || running === undefined) {
    fail("OpsCrew could not tell which pull request or image this run is about, so it deleted no image.");
    return;
  }
  ${registryCode(plan)}

  let deleting = false;
  try {
    const base = await packageVersions();
    const { versions, children } = await readPackage(base, running === null ? [] : [running]);
    const open = [];
    for (let page = 1; ; page++) {
      const batch = await read(
        await github("GET", "/repos/" + owner + "/" + repo + "/pulls?state=open&per_page=100&page=" + page),
        "The GitHub pull requests API",
      );
      for (const pull of batch) open.push(pull.number);
      if (batch.length < 100) break;
    }
    const ids = new Set(previewPrunable(versions, children, open, number, running));
    console.log("The package has " + versions.length + " image versions; deleting " + ids.size + " of pull requests' images.");
    deleting = true;
    const failed = await deleteVersions(base, versions, ids);
    if (failed > 0) fail(failed + " image versions were not deleted; the next preview run tries again.");
  } catch (error) {
    fail(
      (deleting ? "OpsCrew stopped deleting pull requests' images: " : "OpsCrew could not list the images, so it deleted none: ") +
        error.message + ". The next preview run tries again.",
    );
  }
}`;
}
