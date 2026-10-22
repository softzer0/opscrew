/**
 * Applying the local plan (contracts/localhost.md "applyLocal"): only the plan the approval's hash
 * names, under this computer's deploy lock, with the production scripts through the local
 * executor: the files into the app's folder, the leaf certificate into the edge's, the image, then
 * the same start script as a server's deploy, the health check through 127.0.0.1 and, when the new
 * version fails, the same rollback.
 */
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import {
  initStepsFor,
  localhostTlsUpload,
  rollbackCommands,
  switchCommands,
} from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";
import { caFiles, ensureLocalCa, issueLeaf } from "./ca";
import { nodeLocalRequest } from "./https";
import type { LocalRegistry } from "./image";
import { withLocalLock } from "./lock";
import { type LocalDeploy, planLocal } from "./plan";
import {
  appFolder,
  computer,
  type LocalhostServices,
  localRoots,
  localShell,
  ownerFile,
  requireShell,
  shellPath,
  shellWord,
} from "./services";
import { localTarget, recordServedSite } from "./site";

/** How long the start script and a local build may take (image pulls, builds). */
const SCRIPT_TIMEOUT_MS = 30 * 60_000;

/** The health check's tries after the switch, 3 seconds apart. */
const HEALTH_TRIES = 10;

/** The last lines of a script's output, without GitHub Actions' `::error::` markers. */
function outputTail(result: { stdout: string; stderr: string }): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.replace(/^::(?:error|warning|notice)::/, "").trimEnd())
    .filter((line) => line !== "");
  return lines.slice(-12).join("\n");
}

/**
 * Builds the app's image on this computer as GitHub Actions does (the plan's Dockerfile and
 * context, the build arguments, the secret values as BuildKit secrets read from the environment of
 * the script, which reaches the shell on its stdin), tags it `opscrew-local/<app>:<image id>` and
 * returns that tag.
 */
async function buildImage(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  exec: RemoteExec,
  deploy: LocalDeploy,
): Promise<string> {
  if (deploy.image.source !== "local-build") throw new Error("Only a local build is built here.");
  const { dockerfile, context } = deploy.image;
  const { args, secrets } = deploy.buildValues;
  const script = [
    "set -eu",
    `cd ${shellWord(shellPath(deps.paths.root))}`,
    ...Object.entries(secrets).map(([name, value]) => `export ${name}=${shellWord(value)}`),
    `id="$(docker build -q -f ${shellWord(dockerfile)} ${[
      ...Object.entries(args).map(
        ([name, value]) => `--build-arg ${shellWord(`${name}=${value}`)}`,
      ),
      ...Object.keys(secrets).map((name) => `--secret ${shellWord(`id=${name},env=${name}`)}`),
    ].join(" ")} ${shellWord(context)})"`,
    `tag="opscrew-local/${deploy.plan.app.name}:$(printf '%s' "\${id#sha256:}" | cut -c1-12)"`,
    'docker tag "$id" "$tag"',
    "printf '%s\\n' \"$tag\"",
  ].join("\n");
  const result = await exec.run(script, { timeoutMs: SCRIPT_TIMEOUT_MS });
  const tag = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  if (result.exitCode !== 0 || !/^opscrew-local\/[a-z0-9-]+:[0-9a-f]{12}$/.test(tag)) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      deps.redactor.redact(
        `Docker could not build the app's image from ${dockerfile} on this computer. Nothing of the running stack was changed:\n${outputTail(result)}`,
      ),
      {
        hint: "Fix the build error above (it is the same build GitHub Actions runs), then run `opscrew provision` again.",
      },
    );
  }
  return tag;
}

/**
 * Runs `start` (the start script, which pulls the image) logged in to GHCR with `registry`'s
 * login in the app's own Docker settings, the token only on the login's stdin, and logs out
 * afterwards whatever happened, so the token never stays on this computer's disk. Without a
 * registry (a local build) it runs `start` as it is.
 */
async function withRegistryLogin<T>(
  exec: RemoteExec,
  inShell: string,
  registry: LocalRegistry | undefined,
  start: () => Promise<T>,
): Promise<T> {
  if (registry === undefined) return start();
  const config = `DOCKER_CONFIG=${inShell}/.docker`;
  const login = await registry.login();
  try {
    const logged = await exec.run(
      `${config} docker login ghcr.io -u ${shellWord(login.username)} --password-stdin > /dev/null`,
      { input: `${login.token}\n`, timeoutMs: 60_000 },
    );
    if (logged.exitCode !== 0) {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        "Docker on this computer could not log in to GitHub Container Registry with your token. Nothing of the running stack was changed.",
        {
          hint: "Give the token read access to the repository's packages (a classic token with read:packages in OPSCREW_GHCR_READ_TOKEN), then run `opscrew provision` again.",
        },
      );
    }
    return await start();
  } finally {
    await exec.run(`${config} docker logout ghcr.io > /dev/null 2>&1 || true`, {
      timeoutMs: 60_000,
    });
  }
}

/**
 * Applies the local plan of `deploy`. Under this computer's deploy lock it plans again and refuses
 * unless that is exactly the plan `approvedHash` names and its `host-apply` approval is recorded.
 * Then it builds a local image; makes the local CA on first use and, when the plan says so, issues
 * the app's leaf certificate (key at 0600) where the start script takes it; writes this project's
 * id, the files and the env files into the app's folder; runs the start script, logged in to GHCR
 * only meanwhile (`withRegistryLogin`); checks the app over HTTPS through 127.0.0.1, and records
 * the hostname it now serves. When the start or the check fails, the rollback script puts the
 * previous version back, and the error says what happened. Audited by the hash, never with a
 * secret.
 */
export async function applyLocal(
  deps: PhaseDeps,
  deploy: LocalDeploy,
  options: {
    approvedHash: string;
    phase?: PhaseName;
    /** GHCR's login for a private image (`registry` images). */
    registry?: LocalRegistry;
    services?: LocalhostServices;
  },
): Promise<{ image: string }> {
  const local = computer(deps, options.services);
  const exec = localShell(deps, await requireShell(local));
  const { plan, site } = deploy;
  const target = localTarget(plan);

  return withLocalLock(deps.paths, local.sleep, async () => {
    // Planned again under the lock: another deploy may have changed the shared edge meanwhile.
    const { plan: localPlan, hash } = await planLocal(deps, deploy, options.services);
    if (hash !== options.approvedHash) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The local stack's plan is no longer the one you approved (${options.approvedHash}): this computer, the files or the image changed since. Nothing was changed.`,
        { hint: "Run `opscrew provision` again, review the new local plan and approve its hash." },
      );
    }
    await deps.approvals.assertApprovedHostPlan(hash);
    const audit = (action: string, decision: "approved" | "refused", detail?: string) =>
      deps.audit.append({
        kind: "remote-exec",
        actor: "opscrew",
        action,
        ...(options.phase !== undefined ? { phase: options.phase } : {}),
        target: hash,
        decision,
        ...(detail !== undefined ? { detail } : {}),
      });
    await audit("local apply started", "approved", `${plan.app.name} on this computer`);
    try {
      const folder = appFolder(deps.paths, plan);
      const edge = localRoots(deps.paths).edge;
      await mkdir(folder, { recursive: true });
      await mkdir(join(edge, "sites"), { recursive: true });
      // A local build first: a failed one leaves the app's folder as it was.
      const inShell = `"$OPSCREW_APPS_DIR"/${shellWord(plan.app.name)}`;
      const image =
        deploy.image.source === "local-build"
          ? await buildImage(deps, exec, deploy)
          : deploy.image.ref;

      const leaf = localPlan.items.find(
        (item) => item.kind === "certificate" && item.name === site.hostname,
      );
      if (leaf?.action !== "keep") {
        const ca = await ensureLocalCa(deps.paths, {
          computerName: local.computerName,
          now: deps.clock.now(),
        });
        const issued = issueLeaf(ca, site.hostname, deps.clock.now());
        const upload = localhostTlsUpload(plan.app.name);
        const dir = join(edge, "tls", plan.app.name);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
        await writeFileAtomic(join(edge, upload.certificate), issued.certificate, { mode: 0o600 });
        await writeFileAtomic(join(edge, upload.key), issued.key, { mode: 0o600 });
      }
      await writeFileAtomic(ownerFile(deps.paths, plan), `${deps.paths.projectId}\n`, {
        mode: 0o644,
      });
      for (const file of deploy.uploads) {
        await writeFileAtomic(join(folder, file.path), file.content, { mode: 0o644 });
      }
      for (const file of deploy.envFiles) {
        await writeFileAtomic(join(folder, file.path), file.content, { mode: 0o600 });
      }

      // As the workflow's start step: the running version is kept as `.env.previous` first.
      await exec.run(
        `cd ${inShell} && rm -f .env.previous && if [ -f .env ]; then cp .env .env.previous; fi`,
        { timeoutMs: 30_000 },
      );
      const edgeFiles = {
        originTls: false,
        additions: deploy.uploads.some((file) => file.path.startsWith("additions.")),
        localhost: site,
      };
      const start = await withRegistryLogin(exec, inShell, options.registry, () =>
        exec.run(
          [
            `set -- ${shellWord(image)}`,
            ...switchCommands(plan, initStepsFor(plan), edgeFiles),
          ].join("\n"),
          { timeoutMs: SCRIPT_TIMEOUT_MS },
        ),
      );
      const path = plan.app.healthPath;
      const healthy =
        start.exitCode === 0 &&
        (await healthCheck(deps, local, { site, port: target.ports.https, path }));
      if (!healthy) {
        const rollback = await exec.run(
          [`set -- ${shellWord(image)}`, ...rollbackCommands(plan, site)].join("\n"),
          { timeoutMs: SCRIPT_TIMEOUT_MS },
        );
        const outcome = rollback.stdout.trim().split(/\r?\n/).pop();
        const after =
          outcome === "restored"
            ? "OpsCrew put the previous version back."
            : outcome === "no-previous"
              ? "There is no earlier version on this computer to go back to."
              : outcome === "unchanged"
                ? "The previous version keeps running."
                : `OpsCrew could not put the previous version back: run \`docker compose ps\` in ${folder}.`;
        const why =
          start.exitCode === 0
            ? `The new version did not answer at ${localPlan.address}${path}.`
            : `The deploy on this computer failed:\n${outputTail(start)}`;
        throw new OpsCrewError("COMMAND_FAILED", deps.redactor.redact(`${why}\n${after}`), {
          hint: "Fix the cause shown above, then run `opscrew provision` again.",
        });
      }
      await recordServedSite(deps.paths, site);
      await audit("local apply finished", "approved", image);
      return { image };
    } catch (error) {
      await audit(
        "local apply failed",
        "refused",
        "the local stack's last step did not finish; `opscrew status` shows what runs",
      );
      throw error;
    }
  });
}

/**
 * Whether the app answers over HTTPS at its hostname through 127.0.0.1, trusting only the local
 * CA: a status below 400 within {@link HEALTH_TRIES} tries, as `curl -f` counts it.
 */
async function healthCheck(
  deps: Pick<PhaseDeps, "paths">,
  local: ReturnType<typeof computer>,
  o: { site: { hostname: string }; port: number; path: string },
): Promise<boolean> {
  const ca = await readTextIfExists(caFiles(deps.paths).certificate);
  const request = local.request ?? nodeLocalRequest;
  for (let attempt = 1; attempt <= HEALTH_TRIES; attempt += 1) {
    const answer = await request({
      scheme: "https",
      port: o.port,
      hostname: o.site.hostname,
      path: o.path,
      ...(ca !== undefined ? { ca } : {}),
      timeoutMs: 10_000,
    }).catch(() => undefined);
    if (answer !== undefined && answer.status > 0 && answer.status < 400) return true;
    if (attempt < HEALTH_TRIES) await local.sleep(3000);
  }
  return false;
}
