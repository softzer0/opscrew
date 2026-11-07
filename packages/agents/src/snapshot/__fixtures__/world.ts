/** Plans and environments for the snapshot commands' tests, with fake machines and GitHub. */
import { serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  REDIS_PROTOCOL_KINDS,
  type SelfHostedServiceKind,
  writeArtifact,
} from "@opscrew/plan-schema";
import { networked, splitPlan } from "../../network/__fixtures__/plans";
import { inEnvironment } from "../../promote/__fixtures__/world";
import { updateServerAddresses } from "../../shared";
import {
  createTestPhaseDeps,
  OWN_IPV4,
  SERVER_IPV4,
  ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDeps,
  testPlan,
} from "../../testing";
import type { SnapshotServices } from "../types";
import { FakeSnapshotServer } from "./server";

/** The data server's address: never printed, audited or asked about. */
export const DATA_IPV4 = "203.0.113.30";

/** The running version's 64 hex digits. */
export const RUNNING = "a".repeat(64);

/** One service of a test plan. */
export interface ServiceEntry {
  kind: SelfHostedServiceKind;
  name: string;
  server?: string;
  options?: Record<string, unknown>;
}

/** `entries` as the plan's services, at the catalog's versions and memory. */
function planServices(entries: readonly ServiceEntry[]) {
  return entries.map((entry) => {
    const spec = serviceSpec(entry.kind);
    return {
      version: spec.defaultVersion,
      memoryMb: spec.memory.defaultMb,
      enabled: true,
      options: (REDIS_PROTOCOL_KINDS as readonly string[]).includes(entry.kind)
        ? { mode: "cache" }
        : {},
      reason: "The app uses it.",
      licence: spec.licence.id,
      ...entry,
    };
  });
}

/**
 * `shop` in staging on a Hetzner server with `services`, and the app's SQLite volume with
 * `sqlite`; `base` replaces the Hetzner plan (an own server's, a Portainer's, this computer's).
 */
export function stagingPlan(
  services: readonly ServiceEntry[],
  o: { sqlite?: boolean; base?: DeployPlan; fields?: Record<string, unknown> } = {},
): DeployPlan {
  const base = o.base ?? testPlan({ deployed: true });
  return inEnvironment(
    DeployPlanSchema.parse({
      ...base,
      services: planServices(services),
      ...(o.sqlite === true
        ? {
            storage: { ...base.storage, sqlite: { dir: "storage" } },
            deploy: { ...base.deploy, strategy: "recreate" },
          }
        : {}),
      ...o.fields,
    }),
    "staging",
  );
}

/** `shop` in staging with its database `db` on the extra server `data`, Valkey on the app's. */
export function splitStagingPlan(): DeployPlan {
  const { plan } = networked(splitPlan());
  return inEnvironment(
    DeployPlanSchema.parse({
      ...plan,
      services: planServices([
        { kind: "postgres", name: "db", server: "data" },
        { kind: "valkey", name: "cache" },
      ]),
    }),
    "staging",
  );
}

/** The fake deploy workflow's runs: none by default. */
export function fakeRuns(runs: { status: string; htmlUrl: string }[] = []) {
  return {
    listWorkflowRuns: async () =>
      runs.map((run, index) => ({
        id: index + 1,
        status: run.status,
        conclusion: null,
        htmlUrl: run.htmlUrl,
        headSha: "0".repeat(40),
        createdAt: "2026-11-06T18:00:00Z",
      })),
  } as unknown as NonNullable<SnapshotServices["github"]>;
}

/** A runner whose git knows the GitHub remote `acme/shop`. */
export function gitRemote(): ScriptedRunner {
  return new ScriptedRunner((_command, args) =>
    args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "not scripted" },
  );
}

/** What a snapshot test works with. */
export interface SnapshotWorld {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  /** The app's server, and `data` with a split plan. */
  servers: Record<string, FakeSnapshotServer>;
  services: SnapshotServices;
  handler: ScriptedApprovalHandler;
}

/**
 * The staging environment of `plan` with its machines recorded and faked: the app's server at
 * {@link SERVER_IPV4} running {@link RUNNING}, an extra server `data` at {@link DATA_IPV4}, and
 * GitHub's runs. Approvals answer `answer` (all approved by default).
 */
export async function snapshotWorld(
  plan: DeployPlan,
  o: {
    answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
    runs?: { status: string; htmlUrl: string }[];
  } = {},
): Promise<SnapshotWorld> {
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    environment: "staging",
    approvalHandler: handler,
    runner: gitRemote(),
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: SERVER_IPV4 },
    servers: { data: { ipv4: DATA_IPV4 } },
  }));
  const folder = `/srv/apps/${plan.app.name}`;
  const servers: Record<string, FakeSnapshotServer> = {
    app: await FakeSnapshotServer.create(folder, { version: RUNNING }),
    data: await FakeSnapshotServer.create(folder),
  };
  const byHost: Record<string, FakeSnapshotServer | undefined> = {
    [SERVER_IPV4]: servers.app,
    [OWN_IPV4]: servers.app,
    [DATA_IPV4]: servers.data,
  };
  const services: SnapshotServices = {
    github: fakeRuns(o.runs),
    remote: (host) => {
      const server = byHost[host];
      if (server === undefined) throw new Error(`no fake server at ${host}`);
      return server.remote(host);
    },
  };
  return { deps, plan, servers, services, handler };
}

/**
 * Everything a snapshot command showed or recorded: the reporter's lines, the audit entries and
 * the approval requests, for the leak checks.
 */
export function everythingShown(
  world: Pick<SnapshotWorld, "deps" | "handler">,
  error?: unknown,
): string {
  return [
    world.deps.reporter.text(),
    JSON.stringify(world.deps.audit.entries),
    JSON.stringify(world.handler.requests),
    error instanceof Error ? `${error.message} ${(error as { hint?: string }).hint ?? ""}` : "",
  ].join("\n");
}
