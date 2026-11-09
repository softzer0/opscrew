// Feature 025 (T2519): rotating Beszel's hub secrets through its add-on host plan (US8, FR-2511).
import { readFile } from "node:fs/promises";
import { type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensureBeszelHubSecrets, readBeszelSecrets } from "../addons/secrets";
import { beszelSettings, withAddon } from "../addons/settings";
import { buildAppEnvironment } from "../provision/secrets";
import type { GitHubApi } from "../provision/types";
import { hostPlanFile, recordOwnServer, updateServerAddresses } from "../shared";
import { gitRemote } from "../snapshot/__fixtures__/world";
import {
  createTestPhaseDeps,
  FakeAddonServer,
  freshFacts,
  OWN_IPV4,
  ownPlan,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { rotateBeszel } from "./addons-beszel";
import { credentialsRecordFile } from "./record";
import { rotateServices } from "./server";
import {
  ADDON_ROTATION_HASH,
  keepPendingRotation,
  pendingRotationFile,
  readPendingRotation,
} from "./values-pending";

const NOW = new Date("2026-11-08T10:00:00.000Z");

/**
 * A deployed app with Beszel in hub mode, its secrets on this computer: on a Hetzner server, or
 * (`own`) on the user's own server, reached with its admin login. Each apply notes how far this
 * computer's unfinished rotation had got (`steps`).
 */
async function world(
  o: {
    plan?: DeployPlan;
    own?: boolean;
    answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  } = {},
) {
  const base = o.own === true ? ownPlan({ deployed: true }) : testPlan({ deployed: true });
  const plan = o.plan ?? withAddon(base, "beszel", beszelSettings(base, {}, undefined));
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    runner: gitRemote(),
    clock: { now: () => NOW },
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: SERVER_IPV4 },
  }));
  if (o.own === true) {
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
    });
  }
  const old =
    plan.observability?.beszel?.mode === "hub" ? await ensureBeszelHubSecrets(deps) : undefined;
  const server = new FakeAddonServer();
  const steps: (string | undefined)[] = [];
  const services = {
    remote: server.shell,
    serverHost: {
      inspect: async () =>
        o.own === true ? freshFacts() : freshFacts({ user: "deploy", privilege: "docker" }),
      apply: async (...args: Parameters<FakeAddonServer["apply"]>) => {
        steps.push((await readPendingRotation(deps))?.step);
        return server.apply(...args);
      },
    },
  };
  return {
    deps,
    plan,
    handler,
    server,
    old,
    steps,
    run: () => rotateBeszel(deps, plan, { services }),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Everything OpsCrew showed, audited, asked or saved. */
async function everythingShown(w: World): Promise<string> {
  const plans = await Promise.all(
    w.server.applies.map((a) => readFile(hostPlanFile(w.deps.paths, hostPlanHash(a.plan)), "utf8")),
  );
  return [
    w.deps.reporter.text(),
    JSON.stringify(w.deps.audit.entries),
    JSON.stringify(w.handler.requests),
    JSON.stringify(w.server.applies.map((a) => a.plan)),
    w.server.commands.join("\n"),
    ...plans,
  ].join("\n");
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const stepOf = (plan: HostPlan | undefined) => plan?.steps.find((step) => step.id === "beszel");

describe("opscrew rotate beszel", () => {
  it("sends new hub secrets through Beszel's host plan, approved by its hash, then keeps them, records the rotation and refreshes the copy", async () => {
    const w = await world();
    const old = w.old as NonNullable<World["old"]>;
    const result = await w.run();

    const requests = w.handler.requests.filter((r) => r.kind === "host-apply");
    expect(requests.map((r) => r.planHash)).toEqual(result.hostPlanHashes);
    expect(requests[0]?.title).toContain("Rotate Beszel's dashboard password");
    expect(requests[0]?.details).toContain("set in the running hub first");
    const [apply] = w.server.applies;
    expect(w.server.applies).toHaveLength(1);
    expect(apply?.options.approvedHash).toBe(result.hostPlanHashes[0]);
    // Begun once approved, before the apply: it only goes forward from there.
    expect(w.steps).toEqual(["switched"]);
    // A step its check never skips, as the add-on runs it: the deploy user's, hub mode.
    const now = await readBeszelSecrets(w.deps);
    if (now?.mode !== "hub") throw new Error("no hub secrets");
    expect(stepOf(apply?.plan)?.params).toMatchObject({
      runAs: "login",
      mode: "hub",
      hubKey: now.hubPublicKey,
      rewrite: true,
    });
    expect(
      Object.keys(stepOf(apply?.plan)?.params ?? {}).filter((k) => k.startsWith("file:")),
    ).toEqual(["file:compose.yaml", "file:Caddyfile", "file:config.yml"]);
    // The new values, sent only on apply, are the ones this computer keeps now.
    expect(apply?.options.secrets).toEqual({
      beszelPassword: now.password,
      beszelToken: now.token,
      beszelHubKey: now.hubKey,
    });
    for (const name of ["password", "token", "hubKey", "hubPublicKey"] as const) {
      expect(now[name]).not.toBe(old[name]);
    }
    expect(now.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(now.token).toMatch(/^[0-9a-f]{48}$/);

    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(record.environments.prod?.beszel).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expect(await readPendingRotation(w.deps)).toBeUndefined();
    // The recovery copy is refreshed (this project has none yet, so it says how to make it).
    expect(result.copy).toMatchObject({
      changed: false,
      warning: expect.stringContaining("recovery copy"),
    });

    const shown = await everythingShown(w);
    for (const value of [
      old.password,
      old.token,
      old.hubKey,
      now.password,
      now.token,
      now.hubKey,
    ]) {
      expect(shown).not.toContain(value);
    }
  });

  it("keeps the new values beside the old when its plan is refused, and goes on with the same ones", async () => {
    let approve = false;
    const w = await world({ answer: () => approve });
    const old = w.old as NonNullable<World["old"]>;
    await expect(w.run()).rejects.toThrow(/not approved|refused/i);
    expect(w.server.applies).toHaveLength(0);
    expect(await readBeszelSecrets(w.deps)).toEqual(old);
    const pending = await readPendingRotation(w.deps);
    // Nothing was approved, so nothing began: another rotation may replace it.
    expect(pending).toMatchObject({ names: ["beszel"], step: "planned" });
    const next = pending?.services.beszel;
    expect(next?.password?.old).toBe(old.password);

    approve = true;
    const result = await w.run();
    expect(w.server.applies[0]?.options.secrets?.beszelPassword).toBe(next?.password?.new);
    // The same plan as the one shown first: `--approve <hash>` applies it.
    expect(new Set(w.handler.requests.map((r) => r.planHash))).toEqual(
      new Set(result.hostPlanHashes),
    );
    expect(await readBeszelSecrets(w.deps)).toMatchObject({
      password: next?.password?.new,
      token: next?.token?.new,
    });
  });

  it("is refused before any change for agent mode, Beszel off, or another unfinished rotation", async () => {
    const base = testPlan({ deployed: true });
    const agent = withAddon(
      base,
      "beszel",
      beszelSettings(
        base,
        {
          mode: "agent",
          hubUrl: "https://hub.example.com",
          hubKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`,
        },
        undefined,
      ),
    );
    const a = await world({ plan: agent });
    expect((await failure(a.run())).message).toContain("agent mode");
    const off = await world({ plan: base });
    expect((await failure(off.run())).message).toContain("Beszel is off");

    const w = await world();
    await keepPendingRotation(w.deps, {
      names: ["db"],
      services: { db: { password: { old: "a".repeat(64), new: "b".repeat(64) } } },
      hash: "c".repeat(64),
      step: "started",
    });
    const busy = await failure(w.run());
    expect(busy.message).toContain("The rotation of db in prod is unfinished");
    expect(busy.hint).toContain("opscrew rotate db");
    // A service's rotation named `beszel` is another rotation, never this one's to reuse.
    const named = await world();
    await keepPendingRotation(named.deps, {
      names: ["beszel"],
      services: { beszel: { rootPassword: { old: "a".repeat(64), new: "b".repeat(64) } } },
      hash: "c".repeat(64),
      step: "started",
    });
    expect((await failure(named.run())).message).toContain(
      "The rotation of beszel in prod is unfinished",
    );
    for (const world of [a, off, w, named]) expect(world.server.applies).toHaveLength(0);
    expect(JSON.parse(await readFile(pendingRotationFile(w.deps), "utf8")).names).toEqual(["db"]);
  });

  it("rotates Beszel on the user's own server as root, with what inspection found there", async () => {
    const w = await world({ own: true });
    const result = await w.run();
    const [apply] = w.server.applies;
    expect(apply?.options.approvedHash).toBe(result.hostPlanHashes[0]);
    expect(stepOf(apply?.plan)?.params).toMatchObject({
      runAs: "root",
      mode: "hub",
      rewrite: true,
    });
    expect(await readPendingRotation(w.deps)).toBeUndefined();
  });

  it("once begun only goes forward: provision and other rotations name no undo", async () => {
    const failing = await world();
    // The apply fails after the approval: the rotation began.
    const services = {
      remote: failing.server.shell,
      serverHost: {
        inspect: async () => freshFacts({ user: "deploy", privilege: "docker" }),
        apply: async () => {
          throw new OpsCrewError("COMMAND_FAILED", "The server dropped the connection.");
        },
      },
    };
    await expect(rotateBeszel(failing.deps, failing.plan, { services })).rejects.toThrow();
    expect(await readPendingRotation(failing.deps)).toMatchObject({ step: "switched" });
    const provision = await buildAppEnvironment(failing.deps, failing.plan, {}).catch(
      (e: unknown) => e as OpsCrewError,
    );
    expect(provision).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((provision as OpsCrewError).hint).toContain("Finish it with `opscrew rotate beszel`");
    expect((provision as OpsCrewError).hint).not.toContain("--undo");
    const other = await failure(
      rotateServices(failing.deps, failing.plan, ["db"], {
        github: { api: {} as GitHubApi, owner: "acme", repo: "shop" },
      }),
    );
    expect(other.message).toContain("The rotation of beszel in prod is unfinished");
    expect(other.hint).toContain("Finish it with `opscrew rotate beszel`");
    expect(other.hint).not.toContain("--undo");
  });

  it("is never taken for a service's own: a service named beszel is refused while Beszel's is planned", async () => {
    const base = testPlan({ deployed: true });
    const plan = {
      ...base,
      services: base.services.map((s) => (s.kind === "postgres" ? { ...s, name: "beszel" } : s)),
    };
    const w = await world({ plan });
    const addon = {
      names: ["beszel"],
      services: { beszel: { password: { old: "a".repeat(32), new: "b".repeat(32) } } },
      hash: ADDON_ROTATION_HASH,
      step: "planned" as const,
    };
    await keepPendingRotation(w.deps, addon);
    const before = await readFile(pendingRotationFile(w.deps), "utf8");
    const refused = await failure(
      rotateServices(w.deps, plan, ["beszel"], {
        github: { api: {} as GitHubApi, owner: "acme", repo: "shop" },
      }),
    );
    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toContain("The rotation of beszel in prod is unfinished");
    expect(refused.hint).not.toContain("--undo");
    // Nothing changed: no approval asked, no server reached, the add-on's file as it was.
    expect(w.handler.requests).toHaveLength(0);
    expect(w.server.applies).toHaveLength(0);
    expect(await readFile(pendingRotationFile(w.deps), "utf8")).toBe(before);
  });
});
