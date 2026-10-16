/**
 * The CLI side of the tests for the user's existing Portainer as a deploy target: the recorded
 * connection in `.opscrew/server.json`, saved stack plans and a fake phase that records the
 * options the CLI passes and asks for the approvals a real run asks for. The full flows
 * (inspection, stack plans, apply, teardown) are tested in `@opscrew/agents`; these fakes only
 * check the CLI's wiring. Tests only: no network, no Portainer.
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
import { fakeCertificate, PORTAINER_URL } from "@opscrew/agents/testing";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import type { TempProject } from "./harness";

/** Records how OpsCrew reaches the user's Portainer, as the interview does. */
export async function recordPortainer(
  project: TempProject,
  created: {
    stacks?: { id: number; name: string; role: "app" | "updater" | "tunnel-connector" }[];
    volumes?: string[];
  } = {},
): Promise<void> {
  await recordPortainerConnection(resolveProjectPaths(project.root, { env: project.env }), {
    url: PORTAINER_URL,
    certFingerprint: fakeCertificate().fingerprint,
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
async function saveStackPlan(
  deps: Pick<PhaseDeps, "paths">,
  options: { changes: number; inPlace?: number },
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
    seed: "",
  };
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  const hash = createHash("sha256").update(text).digest("hex");
  const file = stackPlanFile(deps.paths, hash);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return hash;
}

/** Saves an infrastructure plan sidecar (`<plans>/<stamp>.tfplan.json`) with `hash`, as provision does. */
async function saveInfraPlan(deps: Pick<PhaseDeps, "paths">, hash: string): Promise<void> {
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
