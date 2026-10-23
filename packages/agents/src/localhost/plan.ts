/**
 * The local plan (contracts/localhost.md "LocalPlan", FR-1503): what a deploy (or a teardown) of
 * the localhost stack creates, changes or removes on this computer, with the app's hostname and
 * ports. Its hash is the SHA-256 of its canonical JSON; it is approved as `host-apply`, like a
 * server's host plan, and applied only with that hash.
 */
import { join } from "node:path";
import {
  canonicalJson,
  exists,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  sha256Hex,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import { EDGE_PROJECT, type LocalhostSite, localComposeProject } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readValidJson } from "../shared";
import { caFiles, caName, leafState } from "./ca";
import { networkExists, projectObjects } from "./docker";
import type { LocalImage } from "./image";
import {
  appFolder,
  computer,
  type LocalhostServices,
  localRelative,
  localRoots,
  ownerFile,
  requireOwnLocalApp,
} from "./services";
import { localAddress, localTarget } from "./site";
import { stackParts } from "./stack";

/** One thing the local plan creates, changes, keeps or removes on this computer. */
export const LocalItemSchema = z.strictObject({
  kind: z.enum(["folder", "file", "certificate", "image", "network", "volume", "container"]),
  /** A folder or file relative to the OpsCrew home's `local/` folder, else Docker's name. */
  name: z.string().min(1),
  action: z.enum(["create", "change", "keep", "remove"]),
  /** What it is or why it changes; a file's SHA-256 (never an env file's: it holds secrets). */
  detail: z.string().optional(),
});
export type LocalItem = z.infer<typeof LocalItemSchema>;

/** `.opscrew/plans/local-<hash>.json`: the local plan, without a secret or an address. */
export const LocalPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** `setup`: provision's deploy. `teardown`: destroy's removal. */
  purpose: z.enum(["setup", "teardown"]),
  app: z.string().min(1),
  environment: z.string().min(1),
  /** The app's Compose project, `opscrew-<app>`. */
  project: z.string().min(1),
  /** The app's address on this computer, `https://<app>.localhost[:<port>]`. */
  address: z.string().min(1),
  ports: z.strictObject({ https: z.number().int(), http: z.number().int() }),
  items: z.array(LocalItemSchema),
});
export type LocalPlan = z.infer<typeof LocalPlanSchema>;

/** The SHA-256 of the local plan's canonical JSON, the hash its approval names. */
export function localPlanHash(plan: LocalPlan): string {
  return sha256Hex(canonicalJson(plan));
}

/** `.opscrew/plans/local-<hash>.json`: the local plan the hash names, kept for review and audit. */
export function localPlanFile(paths: Pick<ProjectPaths, "files">, hash: string): string {
  return join(paths.files.plansDir, `local-${hash}.json`);
}

/** Saves the local plan for review and audit (and the CLI's look-up of its purpose). */
export async function saveLocalPlan(
  paths: Pick<ProjectPaths, "files">,
  plan: LocalPlan,
  hash: string,
) {
  await writeFileAtomic(localPlanFile(paths, hash), `${JSON.stringify(plan, null, 2)}\n`);
}

/**
 * The purpose of the saved local plan `hash` names (`setup` or `teardown`), when it is on this
 * computer and its hash matches; else `undefined`. The CLI's typed confirmation of a destroy covers
 * a teardown only.
 */
export async function savedLocalPlanPurpose(
  paths: Pick<ProjectPaths, "files">,
  hash: string | undefined,
): Promise<LocalPlan["purpose"] | undefined> {
  if (hash === undefined || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
  const saved = await readValidJson(localPlanFile(paths, hash), LocalPlanSchema);
  return saved !== undefined && localPlanHash(saved) === hash ? saved.purpose : undefined;
}

/**
 * The saved local plan `hash` names, `undefined` when none was saved. A file that is not a local
 * plan stops with `ARTIFACT_INVALID` and `hint`, so a damaged plan never passes for one that
 * changes nothing.
 */
export async function readSavedLocalPlan(
  paths: Pick<ProjectPaths, "root" | "files">,
  hash: string,
  hint: string,
): Promise<LocalPlan | undefined> {
  const file = localPlanFile(paths, hash);
  if (!(await exists(file))) return undefined;
  const saved = await readValidJson(file, LocalPlanSchema);
  if (saved === undefined) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `The saved local plan ${hash} (${toPosixRelative(paths.root, file)}) is damaged, so OpsCrew cannot tell what it changes.`,
      { hint },
    );
  }
  return saved;
}

/** The items of the local plan that change something on this computer. */
export function localChanges(plan: LocalPlan): LocalItem[] {
  return plan.items.filter((item) => item.action !== "keep");
}

/**
 * True when the saved local plan `hash` creates, changes or removes something, so it needs its
 * own approval; false when it keeps everything or none was saved. A damaged one stops with `hint`.
 */
export async function savedLocalPlanChanges(
  paths: Pick<ProjectPaths, "root" | "files">,
  hash: string,
  hint: string,
): Promise<boolean> {
  const saved = await readSavedLocalPlan(paths, hash, hint);
  return saved !== undefined && localChanges(saved).length > 0;
}

const SYMBOL: Record<LocalItem["action"], string> = {
  create: "+",
  change: "~",
  keep: "✓",
  remove: "-",
};

/** The local plan in plain English, shown before its `host-apply` approval, then its hash. */
export function describeLocalPlan(plan: LocalPlan, hash: string): string {
  const changes = localChanges(plan).length;
  const heading =
    plan.purpose === "teardown"
      ? `Local teardown plan for ${plan.project} on this computer: ${changes} to remove.`
      : `Local plan for ${plan.project} at ${plan.address} (on 127.0.0.1 only): ${changes} to create or change.`;
  return [
    heading,
    ...plan.items.map(
      (item) =>
        `  ${SYMBOL[item.action]} ${item.kind} ${item.name}${item.detail === undefined ? "" : ` (${item.detail})`}`,
    ),
    plan.purpose === "teardown"
      ? "OpsCrew removes only what it lists here: its own containers, networks and folders of this app, and its volumes only with --delete-data."
      : "OpsCrew changes nothing on this computer it did not list here. Unlike a server's: no SSH, hardening, firewall, DNS records or Cloudflare; the ports on 127.0.0.1 only; certificates from OpsCrew's local CA; the services' data in Docker volumes.",
    `Local plan hash: ${hash}`,
  ].join("\n");
}

/** A file the deploy writes into the app's folder: its path there and its content. */
export interface LocalFile {
  path: string;
  content: string;
}

/** What a deploy of the localhost stack brings: the plan, and the files and image it deploys. */
export interface LocalDeploy {
  plan: DeployPlan;
  site: LocalhostSite;
  image: LocalImage;
  /** The files copied into the app's folder, as the repository has them (`stackUploads`). */
  uploads: readonly LocalFile[];
  /**
   * The app's and its services' env files there, `app.env` and `<service>.env` (secrets: never
   * in the plan, a log or the audit).
   */
  envFiles: readonly LocalFile[];
  /**
   * A local build's client-side values: the build arguments, and the secret ones, which reach the
   * build only as BuildKit secrets (as in GitHub Actions).
   */
  buildValues: { args: Record<string, string>; secrets: Record<string, string> };
}

/** What a file in the app's folder becomes: created, changed or kept. */
async function fileAction(file: string, content: string): Promise<LocalItem["action"]> {
  const current = await readTextIfExists(file);
  if (current === undefined) return "create";
  return current.replaceAll("\r\n", "\n") === content ? "keep" : "change";
}

/** The image the app's folder's `.env` names, as the last deploy wrote it. */
export async function runningImage(folder: string): Promise<string | undefined> {
  const env = await readTextIfExists(join(folder, ".env"));
  return env === undefined ? undefined : /^APP_IMAGE=(.+)$/m.exec(env)?.[1]?.trim();
}

/**
 * The local plan of a deploy (`setup`): the app's and the edge's folders, this project's id in the
 * app's folder, every file copied into it (with its SHA-256; env files by name only), the local CA
 * and the app's leaf certificate, the image, and the containers, networks and volumes of the app's
 * Compose project and the edge's, each `create`, `change` or `keep` from what this computer has
 * now.
 * @throws OpsCrewError `PHASE_PRECONDITION` when another project deployed an app of this name here.
 */
export async function planLocal(
  deps: Pick<PhaseDeps, "paths" | "runner" | "clock" | "env">,
  deploy: LocalDeploy,
  services: LocalhostServices = {},
): Promise<{ plan: LocalPlan; hash: string }> {
  const { plan, site, image } = deploy;
  const target = localTarget(plan);
  await requireOwnLocalApp(deps.paths, plan, "deploy");
  const local = computer(deps, services);
  const roots = localRoots(deps.paths);
  const folder = appFolder(deps.paths, plan);
  const relative = (path: string) => localRelative(deps.paths, path);
  const items: LocalItem[] = [];
  const add = (item: LocalItem) => items.push(item);

  for (const dir of [folder, roots.edge]) {
    add({ kind: "folder", name: relative(dir), action: (await exists(dir)) ? "keep" : "create" });
  }
  const owner = ownerFile(deps.paths, plan);
  add({
    kind: "file",
    name: relative(owner),
    action: await fileAction(owner, `${deps.paths.projectId}\n`),
    detail: "this project's id: only this project changes or removes the app here",
  });
  let filesChange = false;
  let edgeChanges = false;
  for (const upload of deploy.uploads) {
    const action = await fileAction(join(folder, upload.path), upload.content);
    if (action !== "keep") {
      filesChange = true;
      edgeChanges ||= upload.path.startsWith("edge/") || upload.path.startsWith("additions.");
    }
    add({
      kind: "file",
      name: `${relative(folder)}/${upload.path}`,
      action,
      detail: `sha256 ${sha256Hex(upload.content)}`,
    });
  }
  for (const env of deploy.envFiles) {
    const action = await fileAction(join(folder, env.path), env.content);
    if (action !== "keep") filesChange = true;
    add({
      kind: "file",
      name: `${relative(folder)}/${env.path}`,
      action,
      detail: "secret values, never shown",
    });
  }

  const caExists = await exists(caFiles(deps.paths).certificate);
  add({
    kind: "certificate",
    name: caName(local.computerName),
    action: caExists ? "keep" : "create",
    detail: caExists
      ? "the local CA, in your OpsCrew folder"
      : "the local CA, made once in your OpsCrew folder (its key never leaves it)",
  });
  const leaf = await leafState(deps.paths, plan, site.hostname, deps.clock.now());
  if (leaf.action !== "keep") edgeChanges = true;
  add({ kind: "certificate", name: site.hostname, action: leaf.action, detail: leaf.detail });

  const running = await runningImage(folder);
  const imageChanges = image.source === "local-build" || running !== image.ref;
  add(
    image.source === "local-build"
      ? {
          kind: "image",
          name: `built from ${image.dockerfile}`,
          action: "change",
          detail: `on this computer, for ${target.arch}`,
        }
      : {
          kind: "image",
          name: image.ref,
          action: imageChanges ? "change" : "keep",
          detail: `the image ${image.environment} runs${image.emulated ? ", under emulation" : ""}`,
        },
  );

  const parts = stackParts(plan, deploy.uploads);
  const app = await projectObjects(deps, parts.app.project);
  const edge = await projectObjects(deps, EDGE_PROJECT);
  const containers = (
    objects: typeof app,
    project: string,
    names: readonly string[],
    changes: boolean,
  ) => {
    for (const service of names) {
      const there = objects.containers.some((c) => c.service === service);
      add({
        kind: "container",
        name: `${project}-${service}`,
        action: !there ? "create" : changes ? "change" : "keep",
      });
    }
  };
  containers(
    app,
    parts.app.project,
    parts.app.services.map((s) => s.name),
    filesChange || imageChanges,
  );
  containers(
    edge,
    EDGE_PROJECT,
    parts.edge.services.map((s) => s.name),
    edgeChanges,
  );
  for (const network of parts.app.networks) {
    add({
      kind: "network",
      name: network,
      action: app.networks.includes(network) ? "keep" : "create",
    });
  }
  add({
    kind: "network",
    name: EDGE_PROJECT,
    action: (await networkExists(deps, EDGE_PROJECT)) ? "keep" : "create",
  });
  for (const [objects, volumes] of [
    [app, parts.app.volumes],
    [edge, parts.edge.volumes],
  ] as const) {
    for (const volume of volumes) {
      add({
        kind: "volume",
        name: volume,
        action: objects.volumes.includes(volume) ? "keep" : "create",
      });
    }
  }

  const localPlan = LocalPlanSchema.parse({
    schemaVersion: 1,
    purpose: "setup",
    app: plan.app.name,
    environment: deps.paths.environment,
    project: localComposeProject(plan),
    address: localAddress(site, target),
    ports: target.ports,
    items,
  });
  return { plan: localPlan, hash: localPlanHash(localPlan) };
}
