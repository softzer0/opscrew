import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IacEngine, IacEngineName } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { detectEngines, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { describe, expect, it } from "vitest";
import { runProvision } from "../provision";
import { FakeEngine } from "../provision/__fixtures__/fakes";
import { ensureStatePassphrase, stateFile } from "../shared";
import { createTestPhaseDeps } from "../testing";
import {
  deployImage,
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
} from "./__fixtures__/portainer-project";
import {
  DATA_ZONE,
  encryptedState,
  MANAGED_TUNNEL,
  plainState,
  withStateList,
} from "./__fixtures__/state";
import { stateContents } from "./infra";
import { runDrift } from "./run";

async function setup(content: string | undefined) {
  const deps = await createTestPhaseDeps();
  const file = join(await mkdtemp(join(deps.paths.root, "state-")), "prod.tfstate");
  if (content !== undefined) await writeFile(file, content);
  return { deps, file };
}

/** A test engine named `name` with a scripted `state list` for encrypted state. */
function listing(inside: string[] | undefined, name: IacEngineName = "tofu") {
  const engine = new FakeEngine();
  Object.defineProperty(engine, "info", { value: { ...engine.info, name } });
  return withStateList(engine, () => inside);
}

async function writePassphrase(deps: Awaited<ReturnType<typeof createTestPhaseDeps>>) {
  const passphrase = randomBytes(24).toString("base64url");
  await mkdir(dirname(deps.paths.files.statePassphrase), { recursive: true });
  await writeFile(deps.paths.files.statePassphrase, `${passphrase}\n`);
  return passphrase;
}

describe("stateContents", () => {
  it("asks the engine for managed resources: none in an emptied state, outputs and data sources do not count", async () => {
    for (const [content, expected] of [
      [plainState([MANAGED_TUNNEL]), "resources"],
      [plainState([]), "nothing"],
      [plainState([DATA_ZONE]), "nothing"],
    ] as const) {
      const { deps, file } = await setup(content);
      const engine = listing(undefined);
      expect(await stateContents(deps, file, async () => engine)).toBe(expected);
      expect(engine.stateCalls).toEqual([{ file, encryption: undefined }]);
    }
  });

  it("holds nothing without a state file or with a blank one, without asking for an engine", async () => {
    for (const content of [undefined, "  \n"]) {
      const { deps, file } = await setup(content);
      let asked = false;
      const engine = async () => {
        asked = true;
        return listing(undefined);
      };
      expect(await stateContents(deps, file, engine)).toBe("nothing");
      expect(asked).toBe(false);
    }
  });

  it("opens an encrypted state with TF_ENCRYPTION from the existing passphrase (OpenTofu only)", async () => {
    const { deps, file } = await setup(encryptedState());
    const passphrase = await writePassphrase(deps);
    const removed = listing([]);
    expect(await stateContents(deps, file, async () => removed)).toBe("nothing");
    expect(removed.stateCalls).toEqual([{ file, encryption: tofuEncryptionEnv(passphrase) }]);
    expect(deps.redactor.redact(`x ${passphrase} y`)).toBe("x [REDACTED:state-passphrase] y");
    const held = listing(["module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this"]);
    expect(await stateContents(deps, file, async () => held)).toBe("resources");

    // Terraform cannot read OpenTofu-encrypted state.
    const terraform = listing([], "terraform");
    expect(await stateContents(deps, file, async () => terraform)).toBe("unknown");
    expect(terraform.stateCalls).toEqual([]);
  });

  it("is unknown when the engine cannot read the state, or there is no passphrase or engine", async () => {
    const { deps, file } = await setup(encryptedState());
    // No passphrase on this computer: never created, never asked of the engine.
    const engine = listing([]);
    expect(await stateContents(deps, file, async () => engine)).toBe("unknown");
    expect(engine.stateCalls).toEqual([]);
    await expect(readFile(deps.paths.files.statePassphrase, "utf8")).rejects.toThrow();

    await writePassphrase(deps);
    expect(await stateContents(deps, file, async () => listing(undefined))).toBe("unknown");
    const missing = async (): Promise<IacEngine> => {
      throw new Error("no engine");
    };
    expect(await stateContents(deps, file, missing)).toBe("unknown");
    const damaged = await setup("{ not json");
    expect(await stateContents(damaged.deps, damaged.file, async () => engine)).toBe("unknown");
  });

  it("counts a plain state itself for an engine without `state list` (a test fake)", async () => {
    const fake = async () => new FakeEngine();
    for (const [content, expected] of [
      [plainState([MANAGED_TUNNEL]), "resources"],
      [plainState([]), "nothing"],
      [plainState([DATA_ZONE]), "nothing"],
      [plainState([{ ...MANAGED_TUNNEL, instances: [] }]), "nothing"],
      [JSON.stringify({ fake: true }), "unknown"],
      [encryptedState(), "unknown"],
    ] as const) {
      const { deps, file } = await setup(content);
      expect(await stateContents(deps, file, fake)).toBe(expected);
    }
  });
});

// Real engines (OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH), only with OPSCREW_IT=1. The
// earlier setup is the built-in `terraform_data` resource, so no provider is downloaded.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];

/**
 * An earlier setup's root module: one managed resource, an output tied to it and one that is
 * not (a constant), as a Cloudflare root's outputs survive nothing but a destroy.
 */
const EARLIER_ROOT = `terraform {
  backend "local" {}
}

resource "terraform_data" "tunnel" {
  input = "opscrew-shop"
}

output "tunnel_id" {
  value = terraform_data.tunnel.id
}

output "url" {
  value = "https://shop.example.com"
}
`;

const removalTitle = "Remove what an earlier setup of this app created in Cloudflare";
const leftoverTitle = "The infrastructure state still holds what an earlier setup";

describe.skipIf(!runIt)("a removed earlier setup with the real engines (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const found = detected.find((d) => d.name === name && d.supported);
    if (runIt && !found) console.warn(`[agents] skipping ${name}: no usable ${name} binary`);
    it.skipIf(!found)(
      `after provision applies the removal (${name}), provision shows no removal and drift reports nothing`,
      async () => {
        const s = await portainerProject({
          plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }),
          env: { CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token", "removal") },
        });
        await provisionPortainerProject(s);
        await deployImage(s);
        const engine: IacEngine = await selectEngine(name, {
          runner: new NodeCommandRunner(),
          env: process.env,
          redactor: s.deps.redactor,
        });
        const services = { ...s.services, engine: async () => engine };

        // The earlier setup, committed and applied as provision applied it (state encryption with
        // OpenTofu, as the plan asks for by default).
        const dir = join(s.root, s.plan.infra.dir);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "main.tf"), EARLIER_ROOT);
        await s.git(s.root, "add", "--", s.plan.infra.dir);
        await s.git(s.root, "commit", "-q", "-m", "earlier Cloudflare setup");
        const env: Record<string, string | undefined> =
          name === "tofu"
            ? { TF_ENCRYPTION: tofuEncryptionEnv(await ensureStatePassphrase(s.deps.paths)) }
            : {};
        const statePath = stateFile(s.deps.paths);
        await mkdir(s.deps.paths.files.tfstateDir, { recursive: true });
        await engine.init(dir, { env, backendConfig: { path: statePath } });
        const planFile = join(s.root, "earlier.tfplan");
        const created = await engine.plan(dir, planFile, { env });
        const applied = await engine.apply(
          dir,
          planFile,
          { approvedPlanHash: created.planHash },
          { env },
        );
        expect(applied.ok, applied.log).toBe(true);
        await rm(planFile, { force: true });
        const listed = async () => engine;
        expect(await stateContents(s.deps, statePath, listed)).toBe("resources");
        let report = await runDrift(s.deps, { services });
        expect(report.portainer?.differences.map((d) => d.title)).toEqual([
          expect.stringContaining(leftoverTitle),
        ]);

        // Provision plans the removal (`plan -destroy`), applies it and takes the files out.
        s.handler.requests.length = 0;
        await runProvision(s.deps, { services });
        const removal = s.handler.requests.find((r) => r.kind === "iac-apply");
        expect(removal?.title).toContain(removalTitle);
        await expect(readFile(join(dir, "main.tf"), "utf8")).rejects.toThrow();
        const left = await readFile(statePath, "utf8");
        if (name === "tofu") {
          // Encrypted: before T1014, drift could not tell this emptied state from a full one.
          expect(left).toContain("encrypted_data");
        } else {
          // A destroy also takes every output out of the state, the constant one too.
          expect(JSON.parse(left)).toMatchObject({ outputs: {}, resources: [] });
        }
        expect(await stateContents(s.deps, statePath, listed)).toBe("nothing");

        // The next provision shows no removal; drift reports nothing for the earlier setup.
        s.handler.requests.length = 0;
        s.deps.reporter.lines.length = 0;
        await runProvision(s.deps, { services });
        expect(s.handler.requests.filter((r) => r.kind === "iac-apply")).toEqual([]);
        expect(s.deps.reporter.text()).not.toContain(removalTitle);
        report = await runDrift(s.deps, { services });
        expect(report.portainer?.differences).toEqual([]);
        expect(report.notes?.join("\n")).toContain("OpsCrew manages no Cloudflare resources");
      },
      600_000,
    );
  }
});
