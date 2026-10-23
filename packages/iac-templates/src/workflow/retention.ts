import { MANIFEST_ACCEPT } from "../registry";
import { DIGEST_REF_PATTERN, environmentTag } from "./shared";

/**
 * The image retention step's program (FR-1229) in `environment`'s workflow, run with the runner's
 * Node.js (`shell: node {0}`, followed by `main();`). It is plain JavaScript in the committed
 * workflow, so the user can read it and it needs no action or download; the tests run this exact
 * text.
 *
 * It deletes only the environment's own builds: the versions with its commit tag
 * ({@link environmentTag}: `<commit>` in prod's workflow, `<commit>-<env>` in another's) and its
 * `build-<commit tag>` intermediates. Another environment's builds and Buildpacks caches carry
 * tags it does not know, so it keeps them as it keeps the user's own: each environment's workflow
 * deletes its own, and keeps its newest `keep` however many the others build. Untagged versions
 * nothing kept lists go too, but only once they are 30 minutes old (unless a deleted version lists
 * them): two environments build at the same time, and another one's push has its platform
 * manifests untagged for a few seconds before the index that lists them arrives.
 *
 * `prunable` is the pure selection, which never deletes a version the label tags of one of the
 * app's environments mark (`opscrew-<env>` or `opscrew-<env>-previous`, from the label job). Any
 * other `opscrew-*` tag (an environment removed since, a stray one) keeps nothing. `main` reads
 * `IMAGE` (the running image), `PREVIOUS` (the image that ran before, empty on the first deploy),
 * `KEEP` (absent: delete only the intermediate images), `TOKEN`, `GITHUB_REPOSITORY` and
 * `GITHUB_ACTOR`; lists the app's environments from the repository's workflows (one OpsCrew deploy
 * workflow each, by its name: {@link workflowName}), the package's versions through the GitHub API
 * and the image indexes' children from GitHub Container Registry, and deletes what `prunable`
 * selects. Any error before the first deletion deletes nothing. The image reference
 * pattern and the manifest types are OpsCrew's own ({@link DIGEST_REF_PATTERN},
 * {@link MANIFEST_ACCEPT}), written into the program as literals.
 */
export function retentionScript(environment: string): string {
  const own = (commit: string) => environmentTag(commit, environment);
  return String.raw`// OpsCrew image retention (opscrew/plan.yaml, cicd.imageRetention): deletes old versions of
// this repository's image from GitHub Container Registry.

/**
 * The ids of the package versions to delete.
 * versions: [{ id, digest, tags, created }], as the GitHub API lists them.
 * children: by digest, the digests an image index lists (its platform manifests and attestations).
 * keep: how many ${own("<commit>")} versions to keep, newest first; undefined (retention off) deletes only
 * the build-${own("<commit>")} intermediates and what only they list.
 * protect: digests never deleted: the running and the previous image.
 * recent: a time (milliseconds since 1970): an untagged version created since then stays unless
 * a version deleted here lists it, since another environment's build may be pushing it right now.
 * environments: the names of the app's environments (prod and each one beside it).
 *
 * Kept: the protected digests, every version the label tags of one of the environments mark
 * (opscrew-<env>, the image it runs, and opscrew-<env>-previous, the one before), the newest keep
 * ${own("<commit>")} versions, versions with a tag this environment's builds did not push and that is no
 * other opscrew-* tag (yours, Buildpacks' caches, another environment's images), signatures of
 * kept images, and whatever a kept index lists, tagged or not. Deleted: build-${own("<commit>")}
 * intermediates, older ${own("<commit>")} versions with their signatures, and untagged versions
 * nothing kept lists, once they are older than recent.
 */
function prunable(versions, children, keep, protect, recent, environments) {
  const commit = (tag) => /^${own("[0-9a-f]{40}")}$/.test(tag);
  const build = (tag) => /^build-${own("[0-9a-f]{40}")}$/.test(tag);
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
    for (const v of versions) if (!v.tags.every(build)) kept.add(v.digest);
  } else {
    const deployed = versions
      .filter((v) => v.tags.some(commit))
      .sort((a, b) => b.created.localeCompare(a.created) || b.id - a.id);
    for (const v of deployed.slice(0, keep)) kept.add(v.digest);
    for (const v of versions) if (!v.tags.every(ours)) kept.add(v.digest);
    for (const v of versions) if (v.tags.some((tag) => kept.has(subject(tag)))) kept.add(v.digest);
  }

  // Everything a kept version lists, and what that lists in turn, stays.
  const reachable = new Set(kept);
  const queue = [...kept];
  while (queue.length > 0) {
    for (const digest of children[queue.pop()] || []) {
      if (!reachable.has(digest)) {
        reachable.add(digest);
        queue.push(digest);
      }
    }
  }
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
  const [owner, name] = process.env.GITHUB_REPOSITORY.toLowerCase().split("/");
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

  let deleting = false;
  try {
    // The app's environments: each has its OpsCrew deploy workflow, named "OpsCrew deploy" (prod)
    // or "OpsCrew deploy (<env>)".
    const environments = [];
    for (let page = 1; ; page++) {
      const batch = await read(
        await github("GET", "/repos/" + owner + "/" + name + "/actions/workflows?per_page=100&page=" + page),
        "The GitHub workflows API",
      );
      for (const w of batch.workflows) {
        const match = /^OpsCrew deploy(?: \(([a-z][a-z0-9-]*)\))?$/.exec(w.name);
        if (match && w.state !== "deleted") environments.push(match[1] || "prod");
      }
      if (batch.workflows.length < 100) break;
    }
    const user = await read(await github("GET", "/users/" + owner), "The GitHub users API");
    const base =
      (user.type === "Organization" ? "/orgs/" : "/users/") +
      owner + "/packages/container/" + encodeURIComponent(name) + "/versions";
    // The package's versions, and what each tagged or protected one lists.
    const survey = async () => {
      const versions = [];
      for (let page = 1; ; page++) {
        const batch = await read(await github("GET", base + "?per_page=100&page=" + page), "The GitHub packages API");
        for (const v of batch) {
          versions.push({ id: v.id, digest: v.name, tags: v.metadata.container.tags, created: v.created_at });
        }
        if (batch.length < 100) break;
      }
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
    // Another environment's deploy may delete versions while this one reads them (one merge runs
    // several environments' workflows): the registry then answers 404 for a version the list still
    // has. Read it all again; a 404 that stays still stops, so nothing is deleted on a guess.
    let versions = [];
    let children = {};
    for (let attempt = 1; ; attempt++) {
      try {
        ({ versions, children } = await survey());
        break;
      } catch (error) {
        if (error.status !== 404 || attempt === 3) throw error;
        console.log("A version went while OpsCrew read the package (HTTP 404); reading it again in 20 s.");
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
    }

    const ids = new Set(prunable(versions, children, keep, protect, recent, environments));
    console.log("The package has " + versions.length + " image versions; deleting " + ids.size + ".");
    deleting = true;
    let failed = 0;
    for (const v of versions.filter((version) => ids.has(version.id))) {
      const response = await github("DELETE", base + "/" + v.id);
      const what = v.digest + (v.tags.length > 0 ? " (" + v.tags.join(", ") + ")" : "");
      if (response.ok) {
        console.log("Deleted " + what);
      } else if (response.status === 404) {
        // Another environment's deploy deleted it first.
        console.log("Already deleted: " + what);
      } else {
        failed++;
        console.log("::warning::GitHub did not delete " + what + ": HTTP " + response.status + ".");
      }
    }
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
