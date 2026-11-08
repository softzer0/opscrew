// Feature 025 (T2509): the app's own secrets rotated in the user's Portainer through the app's
// stack plan, which the rotation's one approval covers (US4, FR-2502, FR-2507).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { portainerClient } from "@opscrew/connector-portainer";
import { exists, findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { portainerStackName, portainerStackTemplatePath } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PhaseDeps } from "../context";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../provision/portainer";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { generatedValuesFile } from "../shared/app-secrets";
import { recordPortainerConnection } from "../shared/server-record";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCertificate,
  fakePortainer,
  fakeSharedCloudflare,
  ownCloudflare,
  PORTAINER_URL,
  portainerPlan,
  portainerPlanJson,
  projectRunner,
  ScriptedApprovalHandler,
} from "../testing";
import { dropPreviousNames } from "./app-values";
import { rotatePortainerServices } from "./portainer";
import { pendingRotationFile } from "./values-pending";

const PORTAINER_TOKEN = fakeSecret("generic-password", "app rotation portainer token");
const REPO_TOKEN = fakeSecret("github-pat", "app rotation repository read token");
const GHCR_TOKEN = fakeSecret("github-token", "app rotation ghcr read token");
const STRIPE = fakeSecret("stripe-live-key", "app rotation");
const CERT = fakeCertificate("app rotation portainer");

/** The app in Portainer behind the user's own proxy, with Laravel's key generated. */
function plan(): DeployPlan {
  const base = portainerPlan({ web: { mode: "proxy", port: 8080 } });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      env: [...base.app.env, { name: "APP_KEY", secret: true, source: "generated" }],
    },
  });
}

/** A GitHub fake that also creates the deploy branch where pushes go. */
class PortainerGitHub extends FakeGitHub {
  constructor(private readonly createRef: (branch: string) => Promise<void>) {
    super();
  }
  override async createOrphanBranch(input: { branch: string; path: string; content: string }) {
    const created = await super.createOrphanBranch(input);
    await this.createRef(input.branch);
    return created;
  }
}

/** The app set up in Portainer by provision; Docker's proxy is never needed without a service step. */
async function world() {
  const p = plan();
  const project = await createProject(p);
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const portainer = fakePortainer({ token: PORTAINER_TOKEN, failures: {} });
  const github = new PortainerGitHub(async (branch) => {
    const head = await project.git(project.root, "rev-parse", "HEAD");
    await project.git(project.root, "push", "-q", "origin", `${head}:refs/heads/${branch}`);
  });
  const handler = new ScriptedApprovalHandler(() => true);
  const inherited = { ...process.env };
  for (const name of ["PORTAINER_API_KEY", REPOSITORY_TOKEN_VAR, REGISTRY_TOKEN_VAR]) {
    delete inherited[name];
  }
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...inherited,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      OPSCREW_APP_ENV_FILE: "production.env",
      PORTAINER_API_KEY: PORTAINER_TOKEN,
      [REPOSITORY_TOKEN_VAR]: REPO_TOKEN,
      [REGISTRY_TOKEN_VAR]: GHCR_TOKEN,
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  await recordPortainerConnection(deps.paths, {
    url: PORTAINER_URL,
    certFingerprint: CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "proxy", port: 8080 },
  });
  const engine = new FakeEngine({ changes: [], planJson: portainerPlanJson(), outputs: {} });
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: { ...ownCloudflare(), listAccounts: async () => [{ id: "acc-1", name: "acc" }] },
    sleep: async () => undefined,
    askEnv: async () => {
      throw new Error("The rotation asked for an app value.");
    },
    now: () => 0,
    portainer: {
      client: (endpoint, token, clientDeps) =>
        portainerClient(endpoint, token, { ...clientDeps, request: portainer.request }),
      inspectCertificate: async () => CERT,
      randomUUID: () => "6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e",
      wait: { now: () => 0, sleep: async () => undefined },
    },
    sharedCloudflare: fakeSharedCloudflare(),
  };
  const set = await runProvision(deps, { services });
  expect(set.stackApplied).toBe(true);
  const docker = {
    listContainers: async () => [],
    containerExec: async () => {
      throw new Error("The app's secrets run no command in a container.");
    },
    containerInspect: async () => {
      throw new Error("The app's secrets inspect no container.");
    },
  };
  return {
    deps,
    handler,
    plan: p,
    root: project.root,
    portainer,
    provisioned: handler.requests.length,
    rotate: (names: readonly string[]) =>
      rotatePortainerServices(deps, p, names, { services: { provision: services, docker } }),
  };
}

async function generatedEnv(deps: Pick<PhaseDeps, "paths">): Promise<Record<string, string>> {
  return JSON.parse(await readFile(generatedValuesFile(deps), "utf8")).env ?? {};
}

describe.skipIf(!findExecutable("git"))(
  "rotatePortainerServices with the app's own secrets",
  () => {
    it("keeps Laravel's old key in APP_PREVIOUS_KEYS through the stack plan, with no typed name; a drop removes it", async () => {
      const w = await world();
      const appStack = () =>
        w.portainer.stacks.find((stack) => stack.Name === portainerStackName(w.plan));
      const stackValue = (name: string) => appStack()?.Env.find((p) => p.name === name)?.value;
      const old = (await generatedEnv(w.deps)).APP_KEY as string;
      expect(stackValue("APP_KEY")).toBe(old);
      // The committed stack names it bare, so the app gets it only once the Env holds it: until a
      // rotation kept an old key, the Env has no such variable, not even an empty one.
      const template = await readFile(join(w.root, portainerStackTemplatePath(w.plan)), "utf8");
      expect(template).toMatch(/^ {6}APP_PREVIOUS_KEYS: null$/m);
      expect(appStack()?.Env.some((pair) => pair.name === "APP_PREVIOUS_KEYS")).toBe(false);

      const result = await w.rotate(["app:APP_KEY"]);
      const [request, ...others] = w.handler.requests.slice(w.provisioned);
      expect(others).toEqual([]);
      expect(request?.kind).toBe("remote-exec");
      expect(request?.planHash).toBe(result.hash);
      expect(request?.confirmPhrase).toBeUndefined();
      expect(request?.allowDestroy).toBeUndefined();
      expect(request?.details).toContain(
        "app:APP_KEY: seamless: the new value is current, and the old one stays beside it in APP_PREVIOUS_KEYS",
      );
      expect(request?.details).toMatch(/Its stack plan's hash: [0-9a-f]{64} \(1 change\)/);
      expect(request?.title).toBe(
        `Rotate the credentials of app:APP_KEY in ${w.deps.paths.environment}`,
      );

      const env = await generatedEnv(w.deps);
      expect(env.APP_KEY).not.toBe(old);
      expect(env.APP_PREVIOUS_KEYS).toBe(old);
      expect(stackValue("APP_KEY")).toBe(env.APP_KEY);
      expect(stackValue("APP_PREVIOUS_KEYS")).toBe(old);
      expect(stackValue("STRIPE_SECRET_KEY")).toBe(STRIPE);
      expect(await exists(pendingRotationFile(w.deps))).toBe(false);
      const said = [
        w.deps.reporter.text(),
        JSON.stringify(w.deps.audit.entries),
        JSON.stringify(w.handler.requests),
      ].join("\n");
      for (const value of [old, env.APP_KEY as string]) expect(said).not.toContain(value);

      // The drop: the app's name typed, the variable gone from the stack's Env.
      await w.rotate(await dropPreviousNames(w.deps, w.plan));
      const drop = w.handler.requests.slice(w.provisioned)[1];
      expect(drop?.confirmPhrase).toBe(w.plan.app.name);
      expect(appStack()?.Env.some((pair) => pair.name === "APP_PREVIOUS_KEYS")).toBe(false);
      expect(stackValue("APP_KEY")).toBe(env.APP_KEY);
      expect((await generatedEnv(w.deps)).APP_PREVIOUS_KEYS).toBeUndefined();
    });
  },
);
