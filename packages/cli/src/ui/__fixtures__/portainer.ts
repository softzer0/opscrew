/**
 * Fakes for the user's existing Portainer as a deploy target (`target.provider: portainer`): a
 * plan, a recorded connection in `.opscrew/server.json`, saved stack plans and a fake phase that
 * records the options the CLI passes and asks for the approvals a real run asks for. The full
 * flows (inspection, stack plans, apply, teardown) are tested in `@opscrew/agents`; these fakes
 * only check the CLI's wiring. Tests only: no network, no Portainer.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PhaseDeps,
  type ProvisionOptions,
  type ProvisionResult,
  recordPortainerConnection,
  stackPlanFile,
} from "@opscrew/agents";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, type PortainerWeb } from "@opscrew/plan-schema";
import { testPlan } from "./deploy";
import type { TempProject } from "./harness";

/** Portainer's address: it must never be printed. */
export const PORTAINER_HOST = "nas-portainer.home.arpa";
export const PORTAINER_URL = `https://${PORTAINER_HOST}:9443`;
export const PORTAINER_FINGERPRINT = `SHA256:${Array.from({ length: 32 }, () => "5A").join(":")}`;

export interface PortainerPlanOptions {
  web?: PortainerWeb;
  redeploy?: "updater" | "cloudflare";
  /** Default `shop.example.com` on Cloudflare; `null` for no domain. */
  domain?: string | null;
  /** Record an apply in `deployment`, as provision does. */
  deployed?: boolean;
}

/** A valid `opscrew/plan.yaml` for the `shop` app in the user's Portainer (environment 3). */
export function portainerTestPlan(options: PortainerPlanOptions = {}): DeployPlan {
  const web = options.web ?? { mode: "tunnel" };
  const domain = options.domain === undefined ? "shop.example.com" : options.domain;
  const base = testPlan({
    ...(domain === null ? {} : { domain }),
    ...(options.deployed === true ? { deployed: true } : {}),
  });
  return DeployPlanSchema.parse({
    ...base,
    target: {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 3,
      arch: "amd64",
      redeploy: options.redeploy ?? "updater",
      web,
    },
    dns:
      domain === null
        ? { provider: "none", proxied: false }
        : { ...base.dns, proxied: web.mode === "tunnel" },
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [
        { item: "Your Portainer (you already run it)", monthly: { amount: 0, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-10-15T00:00:00.000Z",
    },
  });
}

/** Records how OpsCrew reaches the user's Portainer, as the interview does. */
export async function recordPortainer(
  project: TempProject,
  created: { stacks?: { id: number; name: string; role: "app" | "updater" | "tunnel-connector" }[]; volumes?: string[] } = {},
): Promise<void> {
  await recordPortainerConnection(resolveProjectPaths(project.root, { env: project.env }), {
    url: PORTAINER_URL,
    certFingerprint: PORTAINER_FINGERPRINT,
    environmentId: 3,
    environmentName: "nas",
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "tunnel" },
    created: { stacks: created.stacks ?? [], volumes: created.volumes ?? [] },
  });
}

/**
 * Saves a stack plan as provision does (`.opscrew/plans/stack-<hash>.json`) and returns its hash:
 * `changes` changes and `inPlace` changes already in place.
 */
export async function saveStackPlan(
  deps: Pick<PhaseDeps, "paths">,
  options: { changes: number; inPlace?: number; seed?: string },
): Promise<string> {
  const plan = {
    schemaVersion: 1,
    purpose: "setup",
    app: "shop",
    environmentId: 3,
    changes: [
      ...Array.from({ length: options.changes }, (_, i) => ({
        id: i === 0 ? "app-stack" : "updater-stack",
        title: `Change ${i + 1}`,
        state: "change",
        params: {},
      })),
      ...Array.from({ length: options.inPlace ?? 0 }, () => ({
        id: "registry",
        title: "Registry entry",
        state: "in-place",
        params: {},
      })),
    ],
    findings: [],
    record: { stacks: [], volumes: [] },
    seed: options.seed ?? "",
  };
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  const hash = createHash("sha256").update(text).digest("hex");
  const file = stackPlanFile(deps.paths, hash);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return hash;
}

/** Saves an infrastructure plan sidecar (`<plans>/<stamp>.tfplan.json`) with `hash`, as provision does. */
export async function saveInfraPlan(deps: Pick<PhaseDeps, "paths">, hash: string): Promise<void> {
  const dir = deps.paths.files.plansDir;
  await mkdir(dir, { recursive: true });
  const sidecar = {
    planHash: hash,
    planFile: path.join(dir, "20261015T120000.tfplan"),
    dir: "opscrew/infra/prod",
    engine: { name: "tofu", version: "1.10.0", binary: "tofu" },
    createdAt: "2026-10-15T12:00:00.000Z",
    changes: [
      {
        address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
        type: "cloudflare_zero_trust_tunnel_cloudflared",
        name: "this",
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        action: "create",
      },
    ],
    counts: { create: 1, update: 0, delete: 0, replace: 0 },
    hasDestroy: false,
    policy: [],
    planJson: {},
  };
  await writeFile(path.join(dir, "20261015T120000.tfplan.json"), `${JSON.stringify(sidecar)}\n`);
}

/** What the fake phase saw and how it answers. */
export interface FakePortainerRun {
  options: ProvisionOptions[];
  /** The approvals the fake asked for, with the decisions it got. */
  decisions: { kind: string; planHash?: string; approved: boolean }[];
  run: (deps: PhaseDeps, options: ProvisionOptions) => Promise<ProvisionResult>;
}

/**
 * A fake `runProvision` for the user's Portainer: with `planOnly` it saves a stack plan (with
 * `changes` changes) and returns its hash; otherwise it asks for the `stack-apply` approval of that
 * plan (as provision does), and reports it applied when approved. `tunnelFirst` returns no stack
 * plan on a `--plan-only` run (it needs the tunnel's token).
 */
export function fakePortainerProvision(
  options: { changes?: number; infraHash?: string; tunnelFirst?: boolean } = {},
): FakePortainerRun {
  const seen: FakePortainerRun = {
    options: [],
    decisions: [],
    run: async (deps, runOptions) => {
      seen.options.push(runOptions);
      const hash = await saveStackPlan(deps, { changes: options.changes ?? 2, inPlace: 1 });
      if (runOptions.planOnly === true) {
        if (options.infraHash !== undefined) await saveInfraPlan(deps, options.infraHash);
        return {
          ...(options.infraHash === undefined ? {} : { planHash: options.infraHash }),
          ...(options.tunnelFirst === true ? {} : { stackPlanHash: hash }),
          applied: false,
          outputs: {},
        };
      }
      let stackApplied = false;
      if ((options.changes ?? 2) > 0) {
        const decision = await deps.approvals.request({
          kind: "stack-apply",
          title: "Apply the stack plan to your Portainer (2 changes)",
          details: `Stack plan hash: ${hash}`,
          planHash: hash,
        });
        seen.decisions.push({ kind: "stack-apply", planHash: hash, approved: decision.approved });
        if (!decision.approved) {
          throw new OpsCrewError(
            "APPROVAL_REFUSED",
            `The stack plan was not approved (${decision.reason ?? "no reason"}). Nothing in Portainer was changed.`,
          );
        }
        stackApplied = true;
      }
      return { applied: false, stackPlanHash: hash, stackApplied, outputs: {} };
    },
  };
  return seen;
}
