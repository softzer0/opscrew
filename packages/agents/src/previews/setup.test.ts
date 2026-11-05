import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ApplyOptions,
  type HostFacts,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import { generateP256 } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderPreviewRecipe } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { NetworkServer } from "../provision/network";
import { generatedValuesFile } from "../shared/app-secrets";
import { freshFacts, type ScriptedApprovalHandler, type TestPhaseDeps } from "../testing";
import { previewProject } from "./__fixtures__/plan";
import { ensurePreviewKey } from "./keys";
import { applyPreviewsHostPlan, previewDeploySecrets, previewEnvironment } from "./setup";

const STRIPE = fakeSecret("stripe-live-key", "preview");

/** The preview server with `facts`, whose applies are kept. */
function serverWith(facts: HostFacts) {
  const applies: { plan: HostPlan; options: ApplyOptions }[] = [];
  const server: NetworkServer = {
    name: "app",
    remote: { host: "203.0.113.20", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    facts,
    apply: async (_remote, plan, options) => {
      if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
      applies.push({ plan, options });
      return { applied: plan.steps.map((step) => step.id), skipped: [] };
    },
    verifyLogin: async () => true,
    sshPort: 22,
    alone: true,
  };
  return { server, applies };
}

/** A certificate as Cloudflare's Origin CA issues one (PEM; not a real certificate). */
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBorigin\n-----END CERTIFICATE-----\n";

/** The previews' certificate and its key kept with the generated values, as provision keeps them. */
async function keepCertificate(deps: TestPhaseDeps): Promise<string> {
  const key = generateP256().privateKey;
  await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
  await writeFile(
    generatedValuesFile(deps),
    JSON.stringify({ originTls: { ORIGIN_TLS_KEY: key, ORIGIN_TLS_CERT: CERTIFICATE } }),
  );
  return key;
}

/** The previews host plan of `plan` on `facts`, with `.env.preview` holding the test key. */
async function installOn(deps: TestPhaseDeps, plan: DeployPlan, root: string, facts: HostFacts) {
  await writeFile(join(root, ".env.preview"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const env = await previewEnvironment(deps, plan);
  const repository = "acme/shop";
  const imageName = "ghcr.io/acme/shop";
  const { server, applies } = serverWith(facts);
  const outcome = await applyPreviewsHostPlan(deps, plan, {
    server,
    recipe: renderPreviewRecipe(plan, { repository, imageName, env: env.templates }),
    env,
    key: await ensurePreviewKey(deps.paths, deps.redactor),
    repository,
    imageName,
    branchRules: true,
    readable: [],
    command: "opscrew provision --env preview",
    phase: "provision",
  });
  return { outcome, applies };
}

describe("previewEnvironment", () => {
  it("builds the env templates without a value and keeps .env.preview's values apart", async () => {
    const { deps, plan, root } = await previewProject();
    await writeFile(
      join(root, ".env.preview"),
      `STRIPE_SECRET_KEY=${STRIPE}\nSESSION_SECRET=from-the-file\nUNUSED=1\n`,
    );
    await writeFile(join(root, ".env"), "STRIPE_SECRET_KEY=prod-only-value\n");
    const env = await previewEnvironment(deps, plan);
    expect(env.values).toBe(`STRIPE_SECRET_KEY=${STRIPE}\n`);
    expect(env.valueNames).toEqual(["STRIPE_SECRET_KEY"]);
    expect(env.missing).toEqual([]);
    expect(env.templates.app).toBe(
      [
        "DATABASE_URL=postgresql://app:@SECRET:db-password:hex32@@db:5432/app",
        "SESSION_SECRET=@SECRET:SESSION_SECRET:hex32@",
        "",
      ].join("\n"),
    );
    expect(env.templates.services.db).toContain("POSTGRES_PASSWORD=@SECRET:db-password:hex32@\n");
    const templates = JSON.stringify(env.templates);
    for (const value of [STRIPE, "from-the-file", "prod-only-value"]) {
      expect(templates).not.toContain(value);
    }
    expect(deps.redactor.redact(`key ${STRIPE}`)).not.toContain(STRIPE);
  });
});

describe("applyPreviewsHostPlan", () => {
  it("installs the recipe as root on the user's own server, cron first, approved with the typed name", async () => {
    const { deps, plan, root } = await previewProject({ own: true });
    const key = await keepCertificate(deps);
    const { outcome, applies } = await installOn(deps, plan, root, freshFacts());
    expect(outcome.applied).toBe(true);
    const [step] = applies[0]?.plan.steps ?? [];
    expect(step?.params.runAs).toBe("root");
    expect(step?.reason).toContain(", with cron installed first when it is missing.");
    const request = (deps.approvalHandler as ScriptedApprovalHandler).requests[0];
    expect(request).toMatchObject({
      kind: "host-apply",
      allowDestroy: true,
      confirmPhrase: "shop-preview",
    });
    expect(request?.details).toContain("Host plan for your server");
    expect(request?.details).toContain("Preview values from .env.preview (names only): none.");
    // An app without values of its own still gets values.env, which each preview's start needs;
    // the certificate and its key go at apply only, never in the plan or its text.
    expect(applies[0]?.options.secrets).toEqual({
      previewValues: "",
      previewTls: { certificate: CERTIFICATE, key },
    });
    const keyLine = key.split(/\r?\n/)[2] as string;
    expect(JSON.stringify(applies[0]?.plan)).not.toContain(keyLine);
    expect(request?.details).not.toContain(keyLine);
    expect(deps.redactor.redact(`key ${key}`)).not.toContain(keyLine);
  });

  it("installs nothing when this computer holds no key for the previews' certificate", async () => {
    const { deps, plan, root } = await previewProject({ own: true });
    await expect(installOn(deps, plan, root, freshFacts())).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "This computer holds no key for the previews' Cloudflare Origin CA certificate",
      ),
    });
  });
});

describe("previewDeploySecrets", () => {
  it("holds the address, the host key, the preview key and the build values, nothing else", () => {
    const key = { privateKeyOpenSsh: "preview-private\n", publicKeyOpenSsh: "", created: false };
    expect(
      previewDeploySecrets({
        host: "203.0.113.20",
        knownHosts: "203.0.113.20 ssh-ed25519 AAAA",
        key,
        env: { build: { env: "NEXT_PUBLIC_X=1\n", secrets: "\n", names: ["NEXT_PUBLIC_X"] } },
      }),
    ).toEqual({
      OPSCREW_HOST: "203.0.113.20",
      OPSCREW_SSH_KNOWN_HOSTS: "203.0.113.20 ssh-ed25519 AAAA",
      OPSCREW_SSH_PRIVATE_KEY: "preview-private\n",
      OPSCREW_BUILD_ENV: "NEXT_PUBLIC_X=1\n",
      OPSCREW_BUILD_SECRETS: "\n",
    });
  });
});
