import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments/paths";
import { sharedPartsSource } from "../environments/shared-parts";
import { testPlan } from "../testing";
import { DIGEST, FakeComputer, localPlan, localProject } from "./__fixtures__/computer";
import { imageSource, type LocalRegistry, resolveLocalImage } from "./image";
import { appFolder } from "./services";

/** The image dev's own workflow built and its local runner deployed. */
const DEV_DIGEST = `sha256:${"cd".repeat(32)}`;
/** The image staging runs. */
const STAGING_DIGEST = `sha256:${"ef".repeat(32)}`;

/** dev on this computer (`registry`), with `environment` merged into its environment block. */
function devPlan(
  environment: Record<string, unknown> = {},
  o: { arch?: "amd64" | "arm64"; railpack?: boolean } = {},
): DeployPlan {
  const plan = localPlan({ environment: "dev", image: "registry", arch: o.arch ?? "amd64" });
  return DeployPlanSchema.parse({
    ...plan,
    app: o.railpack
      ? {
          ...plan.app,
          build: {
            builder: "railpack",
            chosen: "auto",
            reason: "no Dockerfile",
            runtime: { language: "node", version: "22" },
            probe: "none",
          },
        }
      : plan.app,
    environment: { ...plan.environment, ...environment },
  });
}

/** dev's deploy job on the local runner, following main. */
const LOCAL_RUNNER = { runner: "local", deploySource: { from: "main" } };

/**
 * dev's project beside prod on a server OpsCrew creates (amd64 images), with the Dockerfile a
 * local build needs unless `dockerfile` is false; GHCR has the labels in `computer.digests`
 * (prod's by default).
 */
async function dev(plan: DeployPlan, o: { dockerfile?: boolean } = {}) {
  const computer = new FakeComputer();
  const { deps, root } = await localProject(plan, computer, {
    environment: "dev",
    prod: testPlan({ userSecret: false }),
  });
  if (o.dockerfile !== false) await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
  const registry = computer.services().registry as LocalRegistry;
  const resolve = (p: DeployPlan = plan) => resolveLocalImage(deps, p, async () => registry);
  return { deps, computer, resolve };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("a localhost environment on the local runner runs its own image (FR-1540)", () => {
  it("is its own image source, so its shared parts come from its own design", async () => {
    const plan = devPlan(LOCAL_RUNNER);
    const { deps } = await dev(plan);
    expect(await imageSource(deps.paths, plan)).toBeUndefined();
    expect(await sharedPartsSource(deps.paths, plan)).toBeUndefined();
  });

  it("runs its own labelled image once GHCR has it", async () => {
    const { computer, resolve, deps } = await dev(devPlan(LOCAL_RUNNER));
    computer.digests.set("opscrew-dev", DEV_DIGEST);
    expect(await resolve()).toEqual({
      source: "registry",
      ref: `ghcr.io/acme/shop@${DEV_DIGEST}`,
      environment: "dev",
      emulated: false,
    });
    expect(deps.reporter.text()).toBe("");
  });

  it("starts from a local build before its first deploy, when this computer builds the image", async () => {
    const { resolve, deps } = await dev(devPlan(LOCAL_RUNNER));
    expect(await resolve()).toEqual({
      source: "local-build",
      dockerfile: "Dockerfile",
      context: ".",
    });
    expect(deps.reporter.text()).toBe(
      "info: dev has no image of its own on GitHub Container Registry yet (opscrew-dev), so OpsCrew starts it from an image built on this computer from Dockerfile. The first deploy after a push to main replaces it with dev's own image, which its workflow builds.",
    );
  });

  it("keeps the GHCR image it runs when the deploy that started it could not label it", async () => {
    const plan = devPlan(LOCAL_RUNNER);
    const { resolve, deps } = await dev(plan);
    const folder = appFolder(deps.paths, plan);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, ".env"), `APP_IMAGE=ghcr.io/acme/shop@${DEV_DIGEST}\n`);
    expect(await resolve()).toEqual({
      source: "registry",
      ref: `ghcr.io/acme/shop@${DEV_DIGEST}`,
      environment: "dev",
      emulated: false,
    });
    expect(deps.reporter.text()).toContain(
      `so OpsCrew keeps ghcr.io/acme/shop@${DEV_DIGEST}, the image an earlier deploy pulled from there and this computer still runs.`,
    );
    // An image built on this computer is built again.
    await writeFile(join(folder, ".env"), "APP_IMAGE=opscrew-local/shop-dev:0123456789ab\n");
    expect(await resolve()).toMatchObject({ source: "local-build" });
  });

  it("else starts from prod's image, with the emulation note on another CPU", async () => {
    const { resolve, deps } = await dev(devPlan(LOCAL_RUNNER, { railpack: true }));
    expect(await resolve()).toEqual({
      source: "registry",
      ref: `ghcr.io/acme/shop@${DIGEST}`,
      environment: "prod",
      emulated: false,
    });
    expect(deps.reporter.text()).toBe(
      "info: dev has no image of its own on GitHub Container Registry yet (opscrew-dev), so OpsCrew starts it from the image prod runs (opscrew-prod). The first deploy after a push to main replaces it with dev's own image, which its workflow builds.",
    );

    const arm = await dev(devPlan(LOCAL_RUNNER, { arch: "arm64", railpack: true }));
    expect(await arm.resolve()).toMatchObject({ environment: "prod", emulated: true });
    expect(arm.deps.reporter.text()).toContain(
      "info: This computer runs arm64 and prod's image is built for amd64, so Docker runs it under emulation, which is slower.",
    );

    // An app this computer could build, but whose Dockerfile is not in the repository yet.
    const unadapted = await dev(devPlan(LOCAL_RUNNER), { dockerfile: false });
    expect(await unadapted.resolve()).toMatchObject({ source: "registry", environment: "prod" });
  });

  it("else stops, with nothing changed, saying what to do", async () => {
    const railpack = await dev(devPlan(LOCAL_RUNNER, { railpack: true }));
    railpack.computer.digests.clear();
    const stop = await failure(railpack.resolve());
    expect(stop.code).toBe("PHASE_PRECONDITION");
    expect(stop.message).toBe(
      "dev has no image of its own on GitHub Container Registry yet (opscrew-dev): its workflow builds one on each push to main once provision has set it up. Until then OpsCrew starts it from an image built on this computer or from the image prod runs, but this computer cannot build the app's image as GitHub Actions does (its builder adds to it there), and GitHub Container Registry has no image labelled opscrew-prod yet. Nothing was changed.",
    );
    expect(stop.hint).toBe("Deploy prod first, then run the command again.");
    expect(railpack.computer.scripts).toEqual([]);

    const unadapted = await dev(devPlan(LOCAL_RUNNER), { dockerfile: false });
    unadapted.computer.digests.clear();
    const missing = await failure(unadapted.resolve());
    expect(missing.message).toContain("but Dockerfile is not in the repository yet, and");
    expect(missing.hint).toBe(
      "Run `opscrew adapt`, merge its pull request and pull it, or deploy prod first, then run the command again.",
    );

    // Prod on this computer on the local runner, which refuses local-build: no hint to set it.
    const prodPlan = DeployPlanSchema.parse({
      ...localPlan({ image: "registry" }),
      environment: LOCAL_RUNNER,
    });
    const computer = new FakeComputer();
    computer.digests.clear();
    const { deps } = await localProject(prodPlan, computer);
    const registry = computer.services().registry as LocalRegistry;
    const prod = await failure(resolveLocalImage(deps, prodPlan, async () => registry));
    expect(prod.message).toContain("no image labelled opscrew-prod yet");
    expect(prod.hint).toBe("Deploy prod first, then run the command again.");
  });
});

describe("a localhost environment without the local runner (unchanged)", () => {
  it("runs prod's image, and takes its shared parts from prod's plan", async () => {
    const plan = devPlan();
    const { computer, resolve, deps } = await dev(plan);
    computer.digests.set("opscrew-dev", DEV_DIGEST);
    expect(await imageSource(deps.paths, plan)).toEqual({ environment: "prod", arch: "amd64" });
    expect(await sharedPartsSource(deps.paths, plan)).toMatchObject({ name: "prod" });
    expect(await resolve()).toEqual({
      source: "registry",
      ref: `ghcr.io/acme/shop@${DIGEST}`,
      environment: "prod",
      emulated: false,
    });
    // Without prod's image it stops, as before any deploy of prod.
    computer.digests.delete("opscrew-prod");
    expect((await failure(resolve())).message).toContain(
      "GitHub Container Registry has no image labelled opscrew-prod yet",
    );
  });

  it("runs its source's image when it is promoted, also on the local runner", async () => {
    const plan = devPlan({ runner: "local", deploySource: { from: "promote", source: "staging" } });
    const { computer, resolve, deps } = await dev(plan);
    const prod = testPlan({ userSecret: false });
    await writeArtifact(
      "plan",
      environmentPaths(deps.paths, "staging").files.plan,
      DeployPlanSchema.parse({
        ...prod,
        app: { ...prod.app, name: "shop-staging" },
        environment: { name: "staging" },
      }),
    );
    computer.digests.set("opscrew-staging", STAGING_DIGEST);
    expect(await imageSource(deps.paths, plan)).toEqual({ environment: "staging", arch: "amd64" });
    expect(await resolve()).toMatchObject({
      ref: `ghcr.io/acme/shop@${STAGING_DIGEST}`,
      environment: "staging",
    });
  });

  it("always builds with target.image: local-build", async () => {
    const plan = devPlan(LOCAL_RUNNER);
    const { computer, resolve } = await dev(plan);
    computer.digests.set("opscrew-dev", DEV_DIGEST);
    const local = DeployPlanSchema.parse({
      ...plan,
      target: { ...plan.target, image: "local-build" },
    });
    expect(await resolve(local)).toEqual({
      source: "local-build",
      dockerfile: "Dockerfile",
      context: ".",
    });
    expect(await resolve(localPlan({ environment: "dev" }))).toMatchObject({
      source: "local-build",
    });
  });
});
