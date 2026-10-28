import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  HostApplyError,
  HostFactsSchema,
  type HostPlan,
  HostPlanSchema,
  hostPlanHash,
  planTeardown,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { TOOLS } from "@opscrew/iac-templates";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  everythingPrinted,
  LAN_IPV4,
  OWN_IPV4,
  type OwnProject,
  type OwnProjectOptions,
  ownProject,
  provisionOwn,
} from "../drift/__fixtures__/own-project";
import { hostPlanFile, readOwnServer, readServerAddresses } from "../shared";
import { ED25519, OTHER_DEPLOY_KEY, ownPlan, withOtherApp } from "../testing";
import { applyHostPlanApproved, savedHostPlanPurpose } from "./own";
import { runDestroy } from "./run";
import type { DestroyOptions, DestroyPreview, DestroyServices } from "./types";

/** How the user answers each approval during the destroy (provision approves everything). */
type Answer = (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };

/** A provisioned own-server project whose server also runs things OpsCrew did not create. */
async function deployed(o: OwnProjectOptions & { answer?: Answer } = {}) {
  let answer: Answer = () => true;
  const s = await ownProject({ ...o, answer: (request) => answer(request) });
  await provisionOwn(s);
  // The app is running, with its data; the user's own Nextcloud runs beside it.
  const facts = structuredClone(s.host.facts);
  facts.containers = [
    { name: "shop-app-1", project: "shop", ports: "", running: true },
    { name: "shop-db-1", project: "shop", ports: "", running: true },
    {
      name: "nextcloud-app-1",
      project: "nextcloud",
      ports: "0.0.0.0:8443->443/tcp",
      running: true,
    },
  ];
  facts.volumeProjects = ["shop", "nextcloud"];
  facts.dirs = facts.dirs.map((dir) => ({ ...dir, entries: 3 }));
  // OpsCrew's record of the SSH and firewall changes it made (what the undo puts back).
  facts.record?.changes.push(
    {
      step: "sshd",
      purpose: "setup",
      at: "2026-10-14T12:00:00.000Z",
      previous: { dropIn: "absent" },
    },
    {
      step: "ufw",
      purpose: "setup",
      at: "2026-10-14T12:00:00.000Z",
      previous: { active: false, installed: true, rules: "", defaultIncoming: "deny" },
    },
  );
  s.host.facts = HostFactsSchema.parse(facts);
  return Object.assign(s, {
    answer: (next: Answer) => {
      answer = next;
    },
  });
}

function services(s: OwnProject): DestroyServices {
  return {
    engine: s.services.engine,
    github: s.github,
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    ...(s.services.own !== undefined ? { own: s.services.own } : {}),
  };
}

const kinds = (s: OwnProject) => s.handler.requests.map((r) => r.kind);

async function expectError(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

describe.skipIf(!findExecutable("git"))("runDestroy on a server the user owns", () => {
  it("removes the Cloudflare records and the app (teardown plan), never the server, and keeps the data by default", async () => {
    const s = await deployed();
    const previews: DestroyPreview[] = [];
    const options: DestroyOptions = {
      services: services(s),
      confirm: async (preview) => {
        previews.push(preview);
        return true;
      },
    };
    const before = s.host.applies.length;
    const result = await runDestroy(s.deps, options);

    // One typed confirmation, then: Cloudflare (iac-apply), the server (host-apply), the secrets.
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ name: "shop", provider: "own", snapshot: false });
    expect(previews[0]?.hostSteps?.join("\n")).toContain('Remove the app "shop"');
    expect(previews[0]?.dataWarning).toBeUndefined();
    // The prompt asks for the app's name and says the server stays; never a "server name".
    expect(previews[0]?.confirmPrompt).toBe(
      "Type shop (the app's name) to remove the app as listed above; your server itself stays (anything else cancels)",
    );
    expect(kinds(s)).toEqual(["iac-apply", "host-apply", "cloudflare-apply", "github-secrets"]);
    const [iac, host] = s.handler.requests;
    expect(iac).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(iac?.details).toContain("never deletes, rebuilds or reinstalls it");
    expect(host).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(host?.details).toContain("Backups are your responsibility");
    expect(host?.details).toContain("its data in /srv/data/shop and its Docker volumes stay");

    // The engine destroyed only Cloudflare resources, with the address only in TF_VAR_*.
    const destroyPlans = s.engine.plans.filter((p) => p.destroy);
    expect(destroyPlans.length).toBeGreaterThan(0);
    for (const call of destroyPlans) expect(call.env.TF_VAR_server_ipv4).toBe(OWN_IPV4);
    expect(result.destroyed.every((c) => c.type.startsWith("cloudflare_"))).toBe(true);

    // The teardown host plan: approved by its hash, saved, applied once; the data stays.
    expect(s.host.applies).toHaveLength(before + 1);
    const teardown = s.host.applies.at(-1);
    expect(teardown?.plan.purpose).toBe("teardown");
    expect(teardown?.plan.deleteData).toBe(false);
    expect(teardown?.options.approvedHash).toBe(host?.planHash);
    expect(hostPlanHash(teardown?.plan as never)).toBe(host?.planHash);
    expect(result.hostPlans).toEqual({ teardown: host?.planHash });
    const saved = HostPlanSchema.parse(
      JSON.parse(await readFile(hostPlanFile(s.deps.paths, host?.planHash as string), "utf8")),
    );
    expect(saved.purpose).toBe("teardown");
    expect(
      await s.deps.approvals.assertApprovedHostPlan(host?.planHash as string, {
        allowDestroy: true,
      }),
    ).toBeTruthy();

    // What OpsCrew did not create is untouched; the app is gone; the server's setup stays.
    expect(s.host.facts.containers.map((c) => c.project)).toEqual(["nextcloud"]);
    expect(s.host.facts.volumeProjects).toEqual(["shop", "nextcloud"]);
    expect(s.host.facts.record?.apps).toEqual([]);
    expect(s.host.facts.deployUser).not.toBeNull();

    // Deploy secrets, tunnel ones included; the plan records the teardown.
    expect(s.github.deleted).toEqual(
      expect.arrayContaining([
        "OPSCREW_HOST",
        "OPSCREW_SSH_PRIVATE_KEY",
        "OPSCREW_TUNNEL_SERVICE_TOKEN_ID",
        "OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET",
      ]),
    );
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(plan.approvals.slice(-3).map((a) => a.kind)).toEqual([
      "iac-apply",
      "host-apply",
      "cloudflare-apply",
    ]);
    // The address DNS pointed at is forgotten; the login and the pinned host key stay.
    expect((await readServerAddresses(s.deps.paths)).deployment).toBeUndefined();
    expect(await readOwnServer(s.deps.paths)).toMatchObject({ host: OWN_IPV4 });
    expect(await readFile(s.deps.paths.files.knownHosts, "utf8")).toContain(ED25519);

    expect(result.remaining.join("\n")).toContain(
      "Backups of anything on it are your responsibility",
    );
    expect(result.remaining.join("\n")).toContain("--undo-host");
    expect(result.remaining.join("\n")).toContain("The app's data stays on your server");
    // No address in approvals' titles, the audit log or what remains.
    const titles = s.handler.requests.map((r) => r.title).join("\n");
    expect(
      `${titles}\n${JSON.stringify(s.deps.audit.entries)}\n${result.remaining.join("\n")}`,
    ).not.toContain(OWN_IPV4);
  });

  it("deletes the app's data only with deleteData, the destroy approval and the typed app name", async () => {
    const s = await deployed();
    // The host approval is answered with the wrong name: nothing on the server changes.
    s.answer((request) =>
      request.kind === "host-apply" ? { approved: true, confirmation: "shopp" } : true,
    );
    const before = s.host.applies.length;
    const refused = await expectError(
      runDestroy(s.deps, { services: services(s), deleteData: true }),
      "APPROVAL_REFUSED",
    );
    expect(refused.message).toContain("nothing on your server was changed");
    expect(refused.message).toContain("Cloudflare resources are deleted already");
    expect(s.host.applies).toHaveLength(before);
    expect(s.host.facts.volumeProjects).toContain("shop");
    const host = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(host?.details).toContain("cannot be undone unless you have your own backup");

    // Typed correctly, the data goes too; a re-run continues where it stopped.
    s.answer(() => true);
    s.handler.requests.length = 0;
    const result = await runDestroy(s.deps, { services: services(s), deleteData: true });
    expect(kinds(s)).toEqual(["host-apply", "cloudflare-apply", "github-secrets"]);
    expect(s.host.applies.at(-1)?.plan.deleteData).toBe(true);
    expect(s.host.facts.volumeProjects).toEqual(["nextcloud"]);
    // The data really went, so "What remains" no longer lists it.
    expect(result.remaining.join("\n")).not.toContain("The app's data stays on your server");
  });

  it("with deleteData removes every component's data, the named volumes as the data folders, and their secrets", async () => {
    const base = ownPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        // SQLite's volume is mounted in the app's folder in the image: its own Dockerfile's.
        build: {
          builder: "own-dockerfile",
          chosen: "user",
          reason: "The repository has its own Dockerfile.",
          runtime: { language: "node", version: "24" },
          probe: "node",
          workdir: "/app",
        },
      },
      services: [
        ...base.services,
        { kind: "kafka", version: "4.3", memoryMb: 1024, reason: "kafkajs", licence: "Apache-2.0" },
        { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
      ],
      storage: { sqlite: { dir: "storage" } },
      deploy: { ...base.deploy, strategy: "recreate" },
    });
    const s = await deployed({ plan });
    s.github.secrets.set("OPSCREW_SERVICE_MYSQL_ENV", "stored");
    const previews: DestroyPreview[] = [];
    const result = await runDestroy(s.deps, {
      services: services(s),
      deleteData: true,
      confirm: async (preview) => {
        previews.push(preview);
        return true;
      },
    });
    // Named from the plan and the catalog, never a hand list.
    expect(previews[0]?.dataWarning).toContain(
      "the PostgreSQL database, the Apache Kafka data, the MySQL database, the SQLite database and everything the app stored in /srv/data/shop and in its Docker volumes",
    );
    // The teardown removes the whole Compose project with its volumes (Kafka's and SQLite's).
    expect(s.host.applies.at(-1)?.plan.deleteData).toBe(true);
    expect(s.host.facts.volumeProjects).toEqual(["nextcloud"]);
    expect(result.secretsRemoved).toContain("OPSCREW_SERVICE_MYSQL_ENV");
    expect(s.github.secrets.has("OPSCREW_SERVICE_MYSQL_ENV")).toBe(false);
  });

  it("--undo-host --delete-data after an earlier destroy refuses before any change and names the data", async () => {
    const s = await deployed();
    await runDestroy(s.deps, { services: services(s) });
    const before = { host: s.host.applies.length, audit: s.deps.audit.entries.length };
    s.handler.requests.length = 0;

    const error = await expectError(
      runDestroy(s.deps, { services: services(s), undoHost: true, deleteData: true }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toBe(
      "OpsCrew cannot delete the app's data: shop was removed from your server before (opscrew/plan.yaml records when), and OpsCrew deletes an app's data only in the teardown that removes the app, so a new `opscrew destroy` cannot delete it. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "The app's data stays on your server: the directory /srv/data/shop, the Docker volumes of the Compose project \"shop\". OpsCrew took no snapshot. To remove it yourself when you no longer need it, run as root on the server: `rm -rf /srv/data/shop` and `docker volume rm $(docker volume ls -q --filter label=com.docker.compose.project=shop)`. Then run `opscrew destroy --undo-host` without `--delete-data` to undo OpsCrew's host changes.",
    );
    // Nothing was approved, applied or changed on the server.
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(before.host);
    expect(s.host.facts.deployUser).not.toBeNull();
    expect(s.host.facts.volumeProjects).toContain("shop");
    expect(s.deps.audit.entries.slice(before.audit).map((e) => e.action)).toEqual([
      "inspect host (read-only)",
    ]);
    expect(`${error.message} ${error.hint}`).not.toContain(OWN_IPV4);

    // Without --delete-data the undo runs, and "What remains" still names the kept data.
    const undo = await runDestroy(s.deps, { services: services(s), undoHost: true });
    expect(undo.hostPlans?.undo).toMatch(/^[0-9a-f]{64}$/);
    expect(undo.remaining.join("\n")).toContain("The app's data stays on your server");
  });

  it("--delete-data with nothing of the app left to remove refuses instead of keeping the data silently", async () => {
    const s = await deployed();
    // Only Compose volumes named like the app are left: no containers, no app folder, no data
    // files and no record that makes them the app's.
    const facts = structuredClone(s.host.facts);
    facts.containers = facts.containers.filter((c) => c.project !== "shop");
    facts.dirs = facts.dirs
      .filter((dir) => dir.path !== "/srv/apps/shop")
      .map((dir) => ({ ...dir, entries: 0 }));
    facts.apps = [];
    s.host.facts = HostFactsSchema.parse(facts);
    const before = s.host.applies.length;
    const error = await expectError(
      runDestroy(s.deps, { services: services(s), deleteData: true }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toBe(
      "OpsCrew cannot delete the app's data: nothing of shop is left on your server for the teardown to remove (no containers, no runtime files), and OpsCrew deletes an app's data only together with the app. Nothing was changed.",
    );
    expect(error.hint).toContain('the Docker volumes of the Compose project "shop"');
    expect(error.hint).toContain("Then run `opscrew destroy` again without `--delete-data`.");
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(before);
    expect(s.engine.applies.filter((a) => a.destroy === true)).toEqual([]);
  });

  it("--undo-host --delete-data with no data left on the server says so and undoes the host changes", async () => {
    const s = await deployed();
    await runDestroy(s.deps, { services: services(s), deleteData: true });
    const start = s.deps.reporter.lines.length;
    const result = await runDestroy(s.deps, {
      services: services(s),
      undoHost: true,
      deleteData: true,
    });
    expect(result.hostPlans?.undo).toMatch(/^[0-9a-f]{64}$/);
    const said = s.deps.reporter.lines
      .slice(start)
      .map((line) => line.message)
      .join("\n");
    expect(said).toContain(
      "None of the app's data is left on your server, so `--delete-data` has nothing to delete.",
    );
    expect(result.remaining.join("\n")).not.toContain("The app's data stays on your server");
  });

  it("--undo-host adds the undo plan as a separate host-apply approval after the teardown", async () => {
    const s = await deployed();
    const result = await runDestroy(s.deps, { services: services(s), undoHost: true });

    expect(kinds(s)).toEqual([
      "iac-apply",
      "host-apply",
      "cloudflare-apply",
      "github-secrets",
      "host-apply",
    ]);
    const [teardown, undo] = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(undo?.planHash).not.toBe(teardown?.planHash);
    // It deletes the deploy user OpsCrew created and its home: a destroy (Constitution I).
    expect(undo).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(undo?.title).toContain("Undo OpsCrew's changes to your server");
    expect(undo?.details).toContain("Docker stays installed");
    expect(undo?.details).toContain(
      "It deletes the deploy user OpsCrew created and its home directory with everything in it; this cannot be undone.",
    );
    expect(
      await s.deps.approvals.assertApprovedHostPlan(undo?.planHash as string, {
        allowDestroy: true,
      }),
    ).toBeTruthy();
    expect(await savedHostPlanPurpose(s.deps.paths, undo?.planHash)).toBe("undo");
    expect(await savedHostPlanPurpose(s.deps.paths, teardown?.planHash)).toBe("teardown");
    expect(await savedHostPlanPurpose(s.deps.paths, "0".repeat(64))).toBeUndefined();
    const applied = s.host.applies.at(-1);
    expect(applied?.plan.purpose).toBe("undo");
    expect(applied?.options.approvedHash).toBe(undo?.planHash);
    // SSH and firewall changes were proven with new logins before they were kept.
    expect(applied?.verified).toBe(true);
    expect(result.hostPlans).toEqual({ teardown: teardown?.planHash, undo: undo?.planHash });
    // The audit names each plan's apply by its purpose and hash: host teardown …, host undo ….
    const audited = (action: string) =>
      s.deps.audit.entries.filter((entry) => entry.action.startsWith(action));
    expect(audited("host teardown started")[0]?.target).toBe(teardown?.planHash);
    expect(audited("host undo started")[0]?.target).toBe(undo?.planHash);
    expect(audited("host teardown step ").length).toBeGreaterThan(0);
    expect(audited("host undo step ").length).toBeGreaterThan(0);
    expect(s.host.facts.deployUser).toBeNull();
    expect(s.host.facts.record).toBeNull();
    // The user's own containers survive both plans.
    expect(s.host.facts.containers.map((c) => c.name)).toEqual(["nextcloud-app-1"]);
    expect(result.remaining.join("\n")).toContain("Docker stays installed");
  });

  it("without a GitHub remote, leaves the server's runner and names it once; the destroy and its undo complete", async () => {
    const s = await deployed();
    s.host.facts = HostFactsSchema.parse({
      ...s.host.facts,
      runners: [
        {
          app: "shop",
          registered: true,
          active: true,
          unitCurrent: true,
          version: TOOLS.githubRunner.version,
          label: "opscrew-shop-prod",
          repositoryUrl: "https://github.com/acme/shop",
        },
      ],
    });
    await s.git(s.root, "remote", "remove", "origin");
    const before = s.host.applies.length;
    const result = await runDestroy(s.deps, { services: services(s), undoHost: true });

    const applied = s.host.applies.slice(before).map((apply) => apply.plan);
    expect(applied.map((plan) => plan.purpose)).toEqual(["teardown", "undo"]);
    for (const plan of applied) {
      expect(plan.steps.filter((step) => step.id === "github-runner")).toEqual([
        expect.objectContaining({ state: "in-place", params: { app: "shop", keep: true } }),
      ]);
    }
    const note =
      "This project has no GitHub remote named origin, so OpsCrew cannot tell which repository the runner in /srv/runners/shop belongs to, and leaves it there. Remove it under the repository's Settings → Actions → Runners and delete /srv/runners/shop, or add the origin remote and run opscrew destroy --undo-host again.";
    const records =
      "OpsCrew's records stay on the server until the runner is gone; add the origin remote and run opscrew destroy --undo-host again to finish.";
    for (const text of [note, records]) {
      expect(s.deps.reporter.text().split(text).length - 1).toBe(1);
    }
    expect(s.host.facts.runners.map((runner) => runner.app)).toEqual(["shop"]);
    expect(s.host.facts.deployUser).not.toBeNull();
    // The rest of the destroy and the undo went ahead as before; OpsCrew's records stay for the
    // runner, so an undo with the remote can finish.
    expect(s.host.facts.apps.filter((app) => app.record?.state === "active")).toEqual([]);
    expect(s.host.facts.record).not.toBeNull();
    expect(result.hostPlans).toEqual({
      teardown: hostPlanHash(applied[0] as HostPlan),
      undo: hostPlanHash(applied[1] as HostPlan),
    });
  });

  it("--undo-host needs the typed app name: a wrong name changes nothing on the server", async () => {
    const s = await deployed();
    await runDestroy(s.deps, { services: services(s) });
    const before = s.host.applies.length;
    s.answer((request) =>
      request.kind === "host-apply" ? { approved: true, confirmation: "shopx" } : true,
    );
    const refused = await expectError(
      runDestroy(s.deps, { services: services(s), undoHost: true }),
      "APPROVAL_REFUSED",
    );
    expect(refused.message).toContain("nothing on your server was changed");
    expect(s.host.applies).toHaveLength(before);
    expect(s.host.facts.deployUser).not.toBeNull();
  });

  it("removes the app's containers and folder when its record was deleted on the server", async () => {
    const s = await deployed();
    const facts = structuredClone(s.host.facts);
    facts.apps = [];
    s.host.facts = HostFactsSchema.parse(facts);
    await runDestroy(s.deps, { services: services(s) });
    const teardown = s.host.applies.at(-1)?.plan;
    expect(teardown?.purpose).toBe("teardown");
    expect(teardown?.app).toBe("shop");
    expect(teardown?.steps.map((step) => [step.id, step.params])).toEqual([
      ["app-dirs", { app: "shop", deleteData: false }],
      ["edge", { removeDir: true }],
      // The host record still lists it.
      ["app-record", { app: "shop", keepData: false, projectId: s.deps.paths.projectId }],
    ]);
    // Only the app's Compose project went; the user's Nextcloud stays.
    expect(s.host.facts.containers.map((c) => c.project)).toEqual(["nextcloud"]);
    expect(s.host.facts.dirs.some((dir) => dir.path === "/srv/apps/shop")).toBe(false);
  });

  it("--undo-host also works after an earlier destroy, and refusing it changes nothing", async () => {
    const s = await deployed();
    await runDestroy(s.deps, { services: services(s) });
    const before = s.host.applies.length;
    s.handler.requests.length = 0;

    s.answer((request) => request.kind !== "host-apply");
    const refused = await expectError(
      runDestroy(s.deps, { services: services(s), undoHost: true }),
      "APPROVAL_REFUSED",
    );
    expect(refused.message).toContain("nothing on your server was changed");
    expect(s.host.applies).toHaveLength(before);

    s.answer(() => true);
    s.handler.requests.length = 0;
    const result = await runDestroy(s.deps, { services: services(s), undoHost: true });
    expect(kinds(s)).toEqual(["host-apply"]);
    expect(result.destroyed).toEqual([]);
    expect(result.hostPlans?.undo).toMatch(/^[0-9a-f]{64}$/);

    // Without --undo-host there is nothing left to destroy.
    const error = await expectError(
      runDestroy(s.deps, { services: services(s) }),
      "PHASE_PRECONDITION",
    );
    expect(error.hint).toContain("--undo-host");
  });

  it("--undo-host against a host record that names no app still asks for the app's name", async () => {
    const s = await deployed();
    await runDestroy(s.deps, { services: services(s) });
    // A host record that lists no app: the undo plan names no app either.
    const record = s.host.facts.record;
    s.host.facts = { ...s.host.facts, record: record === null ? null : { ...record, apps: [] } };
    s.handler.requests.length = 0;
    const result = await runDestroy(s.deps, { services: services(s), undoHost: true });
    expect(s.handler.requests.filter((r) => r.kind === "host-apply")).toEqual([
      expect.objectContaining({ allowDestroy: true, confirmPhrase: "shop" }),
    ]);
    expect(s.host.applies.at(-1)?.plan).toMatchObject({ purpose: "undo", app: "" });
    expect(result.hostPlans?.undo).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never asks to approve a host plan made for another app", async () => {
    const s = await deployed();
    const before = { applies: s.host.applies.length, requests: s.handler.requests.length };
    const plan = {
      ...planTeardown(
        s.host.facts,
        {
          deleteData: false,
          app: "shop",
          projectId: s.deps.paths.projectId,
          repositoryUrl: "https://github.com/acme/shop",
        },
        "opscrew destroy",
      ),
      app: "blog",
    };
    const host = {
      session: s.host as never,
      apply: () => Promise.reject(new Error("must not apply")),
      verifyLogin: async () => true,
      repository: () => Promise.reject(new Error("must not reach GitHub")),
    };
    const error = await expectError(
      applyHostPlanApproved(s.deps, host, plan, {
        deployPlan: await readArtifact("plan", s.deps.paths.files.plan),
        name: "shop",
        title: "Remove shop from your server",
        intro: [],
        refused: "The removal of shop was not approved.",
        command: "opscrew destroy",
      }),
      "INTERNAL",
    );
    expect(error.message).toContain('for the app "blog", not "shop"');
    expect(s.handler.requests).toHaveLength(before.requests);
    expect(s.host.applies).toHaveLength(before.applies);
  });

  it("refuses before any change when the Cloudflare state is not on this computer", async () => {
    const s = await deployed();
    await rm(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), { force: true });
    const before = { host: s.host.applies.length, engine: s.engine.applies.length };
    const error = await expectError(
      runDestroy(s.deps, { services: services(s) }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toBe(
      "The infrastructure state of shop is not on this computer (.opscrew/tfstate/prod.tfstate), so OpsCrew cannot tell what to delete. Nothing was changed.",
    );
    expect(error.hint).toContain("copy its .opscrew/tfstate folder");
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(before.host);
    expect(s.engine.applies).toHaveLength(before.engine);
    expect(
      (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
    ).toBeUndefined();
  });

  it("a failed teardown after the Cloudflare deletion says so, and a re-run finishes", async () => {
    const s = await deployed();
    s.host.fail = new HostApplyError(
      "COMMAND_FAILED",
      "Removing the app's containers failed.",
      ["app-dirs"],
      { hint: "Check Docker on the server." },
    );
    const error = await expectError(
      runDestroy(s.deps, { services: services(s) }),
      "COMMAND_FAILED",
    );
    // The audit still lists the steps the adapter applied before the failure.
    expect(
      s.deps.audit.entries.find((entry) => entry.action === "host teardown failed")?.detail,
    ).toBe("steps applied before the failure: app-dirs");
    expect(error.message).toBe("Removing the app's containers failed.");
    expect(error.hint).toBe(
      "Check Docker on the server. The app's Cloudflare resources are deleted already; the app is still on your server. Run `opscrew destroy` again to finish.",
    );
    expect(`${error.message} ${error.hint}`).not.toContain(OWN_IPV4);
    expect(s.deps.audit.entries.map((entry) => entry.action)).toContain("host teardown failed");
    expect(
      (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
    ).toBeUndefined();

    s.handler.requests.length = 0;
    await runDestroy(s.deps, { services: services(s) });
    expect(kinds(s)).toEqual(["host-apply", "cloudflare-apply", "github-secrets"]);
    expect(s.host.facts.record?.apps).toEqual([]);
  });

  it("offers --delete-data only while the app can still be cancelled, and names the kept data", async () => {
    const s = await deployed();
    const start = s.deps.reporter.lines.length;
    const result = await runDestroy(s.deps, { services: services(s) });
    const said = s.deps.reporter.lines
      .slice(start)
      .map((line) => line.message)
      .join("\n");
    expect(said).toContain(
      "To delete the data as well, cancel now and run `opscrew destroy --delete-data`.",
    );
    const kept = result.remaining.find((item) => item.startsWith("The app's data stays"));
    expect(kept).toContain("/srv/data");
    expect(kept).toContain('Compose project "shop"');
    expect(kept).toContain(
      "docker volume rm $(docker volume ls -q --filter label=com.docker.compose.project=shop)",
    );

    // After the teardown, --delete-data cannot work any more and is never offered.
    const after = s.deps.reporter.lines.length;
    const undo = await runDestroy(s.deps, { services: services(s), undoHost: true });
    const later = s.deps.reporter.lines
      .slice(after)
      .map((line) => line.message)
      .join("\n");
    expect(`${later}\n${undo.remaining.join("\n")}`).not.toContain("--delete-data");
  });

  it("with a second app on the server, removes only this app's parts: the other app and the edge stay", async () => {
    const s = await deployed();
    s.host.facts = withOtherApp({ facts: s.host.facts });
    const result = await runDestroy(s.deps, { services: services(s) });

    const teardown = s.host.applies.at(-1)?.plan;
    expect(teardown?.purpose).toBe("teardown");
    expect(teardown?.otherApps).toEqual([{ app: "blog", deployKey: OTHER_DEPLOY_KEY }]);
    // No edge (it goes with the last app); the deploy user keeps only the other app's key.
    expect(teardown?.steps.map((step) => [step.id, step.scope])).toEqual([
      ["app-dirs", "app"],
      ["deploy-key", "app"],
      ["app-record", "app"],
    ]);
    expect(teardown?.steps.find((step) => step.id === "deploy-key")?.params.keys).toBe(
      OTHER_DEPLOY_KEY,
    );
    expect(s.host.facts.apps.map((app) => [app.name, app.record?.state])).toEqual([
      ["blog", "active"],
      // Its data stays (the default), so its record says so.
      ["shop", "data-kept"],
    ]);
    expect(s.host.facts.containers.map((c) => c.project)).toEqual(["nextcloud", "blog"]);
    expect(s.host.facts.dirs.find((dir) => dir.path === "/srv/edge")?.kind).toBe("dir");
    expect(s.host.facts.dirs.find((dir) => dir.path === "/srv/apps/blog")?.kind).toBe("dir");
    expect(result.remaining.join("\n")).toContain(
      'The other OpsCrew app on your server ("blog") and what the apps share: the edge (Caddy and kamal-proxy), which goes with the last app.',
    );
  });

  it("never removes an app of the same name that belongs to another project", async () => {
    const s = await deployed();
    const facts = structuredClone(s.host.facts);
    facts.apps = facts.apps.map(({ name, record }) => ({
      name,
      record: record === null ? null : { ...record, projectId: "other-project" },
    }));
    s.host.facts = HostFactsSchema.parse(facts);
    const before = { host: s.host.applies.length, engine: s.engine.applies.length };
    const error = await expectError(
      runDestroy(s.deps, { services: services(s) }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toBe(
      'Your server runs an OpsCrew app named "shop" from another project, so OpsCrew removes nothing from it. Nothing was changed.',
    );
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(before.host);
    expect(s.engine.applies).toHaveLength(before.engine);
  });

  it("a blocked teardown or undo says once to run opscrew destroy (--undo-host) again", async () => {
    const s = await deployed();
    s.host.facts = HostFactsSchema.parse({
      ...structuredClone(s.host.facts),
      privilege: "sudo-password",
      user: "alice",
    });
    const teardown = await expectError(
      runDestroy(s.deps, { services: services(s) }),
      "PHASE_PRECONDITION",
    );
    expect(teardown.message).toContain("needs a password for sudo");
    expect(teardown.hint).toMatch(/, then run opscrew destroy again\.$/);
    expect(teardown.hint?.match(/opscrew (?:destroy|provision)/g)).toEqual(["opscrew destroy"]);

    const undo = await expectError(
      runDestroy(s.deps, { services: services(s), undoHost: true }),
      "PHASE_PRECONDITION",
    );
    expect(undo.hint).toMatch(/, then run opscrew destroy --undo-host again\.$/);
    expect(undo.hint?.match(/opscrew (?:destroy|provision)/g)).toEqual(["opscrew destroy"]);
    expect(s.handler.requests).toEqual([]);
  });

  it("an unconfirmed app name changes nothing", async () => {
    const s = await deployed();
    const before = { host: s.host.applies.length, engine: s.engine.applies.length };
    await expectError(
      runDestroy(s.deps, { services: services(s), confirm: async () => false }),
      "APPROVAL_REFUSED",
    );
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(before.host);
    expect(s.engine.applies).toHaveLength(before.engine);
    expect(s.deps.audit.entries.at(-1)).toMatchObject({
      action: "destroy-confirm",
      decision: "refused",
    });
  });

  it("pauses the scheduled check, and the last app's teardown removes the repository's check key", async () => {
    const s = await deployed();
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...plan,
      observability: { check: { enabled: true } },
    });
    const facts = structuredClone(s.host.facts);
    if (facts.deployUser !== null) facts.deployUser.checkKeys = ["acme/shop", "acme/other"];
    s.host.facts = HostFactsSchema.parse(facts);
    await runDestroy(s.deps, { services: services(s) });
    // Paused once the app is removed, before its secrets go.
    expect(kinds(s)).toEqual([
      "iac-apply",
      "host-apply",
      "cloudflare-apply",
      "github-settings",
      "github-secrets",
    ]);
    expect(JSON.parse(s.github.variables.get("OPSCREW_CHECK_PAUSED") ?? "")).toEqual({
      "shop/prod": { reason: "destroyed", since: expect.any(String) },
    });
    // Only this repository's line goes; another repository's check key stays.
    const removal = s.host.applies.at(-1)?.plan.steps.filter((step) => step.id === "check-key");
    expect(removal).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ remove: true, repository: "acme/shop" }),
      }),
    ]);
  });

  it("tunnel mode: removes the tunnel and the connector; no address and no secret anywhere", async () => {
    const s = await deployed({ access: "tunnel" });
    const result = await runDestroy(s.deps, { services: services(s) });
    expect(kinds(s)).toEqual(["iac-apply", "host-apply", "cloudflare-apply", "github-secrets"]);
    const teardown = s.host.applies.at(-1)?.plan;
    expect(teardown?.steps.map((step) => step.id)).toEqual(
      expect.arrayContaining(["app-dirs", "tunnel-connector", "app-record"]),
    );
    expect(s.handler.requests[0]?.title).toContain("Cloudflare Tunnel");
    expect(s.github.deleted).toEqual(
      expect.arrayContaining([
        "OPSCREW_TUNNEL_SERVICE_TOKEN_ID",
        "OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET",
      ]),
    );
    const everything = `${everythingPrinted(s)}\n${JSON.stringify(result)}\n${JSON.stringify(s.handler.requests)}`;
    expect(everything).not.toContain(LAN_IPV4);
    for (const secret of Object.values(s.secrets)) expect(everything).not.toContain(secret);
  });

  /** Adds `extra` to the destroy plans after the first `from` ones (the preview is the first). */
  function tamper(s: OwnProject, extra: ResourceChange, from = 1) {
    const plan = s.engine.plan.bind(s.engine);
    let destroys = 0;
    s.engine.plan = async (dir, file, options) => {
      const summary = await plan(dir, file, options);
      if (options?.destroy !== true || ++destroys <= from) return summary;
      return { ...summary, changes: [...summary.changes, extra] };
    };
  }

  const record = (name: string, action: ResourceChange["action"] = "delete"): ResourceChange => ({
    address: `module.dns.cloudflare_dns_record.${name}`,
    type: "cloudflare_dns_record",
    name,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action,
  });

  it.each([
    {
      what: "deletes a resource that was not in the confirmed list",
      extra: record("extra"),
      message:
        "The teardown plan now deletes resources that were not in the list you confirmed, so OpsCrew stopped. Nothing was deleted.\n  module.dns.cloudflare_dns_record.extra",
      hint: "Run `opscrew destroy` again to see the current list and confirm it.",
    },
    {
      what: "does more than delete",
      extra: record("a", "update"),
      message:
        "The teardown plan would do more than delete, so OpsCrew stopped. Nothing was changed.\n  update module.dns.cloudflare_dns_record.a",
      hint: "Run `opscrew drift` to see what changed, then run `opscrew destroy` again.",
    },
  ])(
    "stops before any approval when the Cloudflare plan $what",
    async ({ extra, message, hint }) => {
      const s = await deployed();
      tamper(s, extra);
      const before = { host: s.host.applies.length, engine: s.engine.applies.length };
      const error = await expectError(
        runDestroy(s.deps, { services: services(s), confirm: async () => true }),
        "PHASE_PRECONDITION",
      );
      expect(error.message).toBe(message);
      expect(error.hint).toBe(hint);
      expect(s.handler.requests).toEqual([]);
      expect(s.host.applies).toHaveLength(before.host);
      expect(s.engine.applies).toHaveLength(before.engine);
    },
  );

  it("stops at the preview when the plan would delete anything but the app's Cloudflare resources", async () => {
    const s = await deployed();
    tamper(
      s,
      {
        address: "hcloud_server.other",
        type: "hcloud_server",
        name: "other",
        provider: "registry.opentofu.org/hetznercloud/hcloud",
        action: "delete",
      },
      0,
    );
    const asked: DestroyPreview[] = [];
    const error = await expectError(
      runDestroy(s.deps, {
        services: services(s),
        confirm: async (preview) => {
          asked.push(preview);
          return true;
        },
      }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toBe(
      "The teardown plan would delete resources other than the app's Cloudflare DNS records, tunnel and Access, so OpsCrew stopped. Nothing was changed.\n  hcloud_server.other",
    );
    expect(asked).toEqual([]);
    expect(s.handler.requests).toEqual([]);
  });

  it("with nothing left on Cloudflare, the summary starts with what is removed from the server", async () => {
    const s = await deployed();
    s.host.fail = new OpsCrewError("COMMAND_FAILED", "Removing the app's containers failed.");
    await expectError(runDestroy(s.deps, { services: services(s) }), "COMMAND_FAILED");
    const start = s.deps.reporter.lines.length;
    await runDestroy(s.deps, { services: services(s) });
    const said = s.deps.reporter.lines
      .slice(start)
      .map((line) => line.message)
      .join("\n");
    expect(said).toContain("The teardown removes from your server:\n  - ");
    expect(said).not.toContain("and removes from your server:");
  });
});
