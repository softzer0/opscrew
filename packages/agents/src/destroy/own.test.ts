import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { HostFactsSchema, HostPlanSchema, hostPlanHash } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
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
import { ED25519 } from "../provision/__fixtures__/own";
import { hostPlanFile } from "../provision/own";
import { readOwnServer, readServerAddresses } from "../shared";
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
    expect(kinds(s)).toEqual(["iac-apply", "host-apply", "github-secrets"]);
    const [iac, host] = s.handler.requests;
    expect(iac).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(iac?.details).toContain("never deletes, rebuilds or reinstalls it");
    expect(host).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(host?.details).toContain("Backups are your responsibility");
    expect(host?.details).toContain("its data in /srv/data and its Docker volumes stay");

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
    expect(s.host.facts.marker).toBeNull();
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
    expect(plan.approvals.slice(-2).map((a) => a.kind)).toEqual(["iac-apply", "host-apply"]);
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
    await runDestroy(s.deps, { services: services(s), deleteData: true });
    expect(kinds(s)).toEqual(["host-apply", "github-secrets"]);
    expect(s.host.applies.at(-1)?.plan.deleteData).toBe(true);
    expect(s.host.facts.volumeProjects).toEqual(["nextcloud"]);
  });

  it("--undo-host adds the undo plan as a separate host-apply approval after the teardown", async () => {
    const s = await deployed();
    const result = await runDestroy(s.deps, { services: services(s), undoHost: true });

    expect(kinds(s)).toEqual(["iac-apply", "host-apply", "github-secrets", "host-apply"]);
    const [teardown, undo] = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(undo?.planHash).not.toBe(teardown?.planHash);
    expect(undo?.allowDestroy).toBeUndefined();
    expect(undo?.title).toContain("Undo OpsCrew's changes to your server");
    expect(undo?.details).toContain("Docker stays installed");
    const applied = s.host.applies.at(-1);
    expect(applied?.plan.purpose).toBe("undo");
    expect(applied?.options.approvedHash).toBe(undo?.planHash);
    // SSH and firewall changes were proven with new logins before they were kept.
    expect(applied?.verified).toBe(true);
    expect(result.hostPlans).toEqual({ teardown: teardown?.planHash, undo: undo?.planHash });
    expect(s.host.facts.deployUser).toBeNull();
    expect(s.host.facts.record).toBeNull();
    // The user's own containers survive both plans.
    expect(s.host.facts.containers.map((c) => c.name)).toEqual(["nextcloud-app-1"]);
    expect(result.remaining.join("\n")).toContain("Docker stays installed");
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
    s.host.fail = new OpsCrewError("COMMAND_FAILED", "Removing the app's containers failed.", {
      hint: "Check Docker on the server.",
    });
    const error = await expectError(
      runDestroy(s.deps, { services: services(s) }),
      "COMMAND_FAILED",
    );
    expect(error.message).toBe("Removing the app's containers failed.");
    expect(error.hint).toBe(
      "Check Docker on the server. The app's Cloudflare resources are deleted already; the app is still on your server. Run `opscrew destroy` again to finish.",
    );
    expect(`${error.message} ${error.hint}`).not.toContain(OWN_IPV4);
    expect(
      (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
    ).toBeUndefined();

    s.handler.requests.length = 0;
    await runDestroy(s.deps, { services: services(s) });
    expect(kinds(s)).toEqual(["host-apply", "github-secrets"]);
    expect(s.host.facts.marker).toBeNull();
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

  it("never removes anything from a server that runs another OpsCrew app", async () => {
    const s = await deployed();
    const facts = structuredClone(s.host.facts);
    facts.marker = { app: "blog", projectId: "other-project" };
    s.host.facts = HostFactsSchema.parse(facts);
    const before = { host: s.host.applies.length, engine: s.engine.applies.length };
    const error = await expectError(
      runDestroy(s.deps, { services: services(s) }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toContain('runs the OpsCrew app "blog"');
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(before.host);
    expect(s.engine.applies).toHaveLength(before.engine);
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

  it("tunnel mode: removes the tunnel and the connector; no address and no secret anywhere", async () => {
    const s = await deployed({ access: "tunnel" });
    const result = await runDestroy(s.deps, { services: services(s) });
    expect(kinds(s)).toEqual(["iac-apply", "host-apply", "github-secrets"]);
    const teardown = s.host.applies.at(-1)?.plan;
    expect(teardown?.steps.map((step) => step.id)).toEqual(
      expect.arrayContaining(["runtime-dirs", "tunnel-connector", "app-marker"]),
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
});
