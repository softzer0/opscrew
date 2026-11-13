// Feature 027 (T2713): `opscrew destroy` on a hosting account, through each panel's fakes, the
// agent's part played by the test.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApprovalRequest, HostingFiles, HostingPanel } from "@opscrew/contracts";
import { OpsCrewError, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDestroy } from "../destroy/run";
import type { DestroyOptions } from "../destroy/types";
import {
  FakeDestroyGitHub,
  fakeCloudflare,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
} from "../testing";
import { plainState } from "../testing/state";
import {
  type AgentAnswer,
  cpanelAccount,
  directAdminAccount,
  type FakeAccount,
  HOSTNAME,
  type HostedOptions,
  hostedApp,
  PANEL_TOKEN,
  playAgent,
  pleskAccount,
} from "./__fixtures__/account";
import {
  applyHostingDestroy,
  type DestroyStep,
  destroyHosting,
  HostingDestroyPlanSchema,
  hostingDestroyHash,
} from "./destroy";
import { agentCronCommand } from "./php";
import { readHostingRecord, recordObject, updateHostingRecord } from "./record";

/** GitHub as the teardown reaches it, each change logged in `events`. */
function destroyGitHub(events: string[]) {
  const github = new FakeDestroyGitHub(events);
  return Object.assign(github, {
    async removeDeployKey(_owner: string, _repo: string, id: number) {
      events.push(`deploy key ${id}`);
      return "deleted" as const;
    },
    async deleteBranch(_owner: string, _repo: string, branch: string) {
      events.push(`branch ${branch}`);
      return "deleted" as const;
    },
  });
}

/** An app on a fake account, and one `opscrew destroy` run. */
async function world(o: HostedOptions & { answer?: AgentAnswer } = {}) {
  const app = await hostedApp(o);
  const agent = playAgent(app, o.answer);
  const events: string[] = [];
  const github = destroyGitHub(events);
  const run = async (
    options: Omit<DestroyOptions, "services"> & {
      approve?: (request: ApprovalRequest) => boolean;
      services?: DestroyOptions["services"];
    } = {},
  ) => {
    const { approve, services, ...rest } = options;
    const handler = new ScriptedApprovalHandler(approve ?? (() => true));
    const deps = await app.deps(handler);
    const all = { github, sleep: agent.sleep, ...services };
    const work =
      app.account.files === undefined
        ? runDestroy(deps, { ...rest, services: all })
        : destroyHosting(
            deps,
            await readArtifact("plan", deps.paths.files.plan),
            { ...rest, services: all },
            { files: app.account.files },
          );
    const outcome = await work.then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { deps, handler, ...outcome };
  };
  return { app, agent, events, github, run };
}

/** What the user has on the account besides the app: a site, its database and a cron line. */
async function usersOwn(
  account: FakeAccount,
  panel: Awaited<ReturnType<typeof hostedApp>>["panel"],
) {
  await panel.addHostname("blog.example.com", "public_html/blog");
  const password = fakeSecret("generic-password", "wordpress");
  await panel.addDatabase({ name: "acct_wp", user: "acct_wp", password });
  await panel.addCron({ schedule: "0 3 * * *", command: "php ~/public_html/wp-cron.php" });
  account.write("public_html/index.html", "<p>my site</p>");
}

/** The fake cPanel's calls that change the account, as `Module::func`. */
const changes = (account: FakeAccount) =>
  (account.cpanel?.calls ?? [])
    .filter((call) => /^(delete|remove|del|upload|fileop)/.test(call.func))
    .map((call) =>
      call.func === "fileop" ? `fileop ${call.params.op}` : `${call.module}::${call.func}`,
    );

describe("destroy on a cPanel account", () => {
  it("removes only what OpsCrew made, in plan 6's order, after the final dump", async () => {
    const w = await world();
    await usersOwn(w.app.account, w.app.panel);
    const before = changes(w.app.account).length;
    const recorded = await readHostingRecord((await w.app.deps()).paths);
    const agentKey = recorded?.objects.find(
      (o) => o.kind === "cron" && o.value?.endsWith(agentCronCommand(w.app.folder)),
    )?.key;

    const { deps, handler, result, error } = await w.run();
    expect(error).toBeUndefined();

    // One hosting plan, approved by its hash with allowDestroy and the typed hostname; then the
    // signing key's removal from GitHub.
    expect(handler.requests.map((request) => request.kind)).toEqual([
      "hosting-apply",
      "github-secrets",
    ]);
    const [approval, secrets] = handler.requests;
    expect(approval).toMatchObject({ allowDestroy: true, confirmPhrase: HOSTNAME });
    const plan = HostingDestroyPlanSchema.parse(
      JSON.parse(
        await readFile(join(deps.paths.files.plansDir, "hosting-prod-destroy.json"), "utf8"),
      ),
    );
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "dump",
      "cron",
      "cron",
      "hostname",
      "certificate",
      "database",
      "folder",
      "deploy-key",
      "branch",
    ]);
    expect(plan.steps[1]).toMatchObject({ kind: "cron", key: agentKey, agent: true });
    expect(approval?.details).toContain(`Hosting plan hash: ${approval?.planHash}`);
    expect(secrets?.details).toContain("OPSCREW_RELEASE_SIGNING_KEY");

    // The panel's changes, in order: the dump's request, the cron lines (the agent's first), the
    // hostname, its certificate, the database and its user, the folder.
    const made = changes(w.app.account).slice(before);
    const at = (name: string) => made.indexOf(name);
    expect(at("Cron::remove_line")).toBeLessThan(at("SubDomain::delsubdomain"));
    expect(at("SubDomain::delsubdomain")).toBeLessThan(at("SSL::delete_cert"));
    expect(at("SSL::delete_cert")).toBeLessThan(at("Mysql::delete_database"));
    expect(at("Mysql::delete_database")).toBeLessThan(made.lastIndexOf("fileop unlink"));
    const removedCron = w.app.account.cpanel?.calls.find((call) => call.func === "remove_line");
    expect(removedCron?.params.linekey).toBe(agentKey);
    expect(w.agent.requests).toEqual([
      expect.objectContaining({ kind: "snapshot", hash: approval?.planHash }),
    ]);
    expect(w.events).toEqual([
      "deploy key 4001",
      "branch opscrew/release/prod",
      "secret:OPSCREW_RELEASE_SIGNING_KEY",
    ]);

    // What OpsCrew made is gone; the final dump stays; the user's own things are untouched.
    const account = w.app.account;
    expect(account.hostnames()).toEqual(["blog.example.com"]);
    expect(account.databases()).toEqual(["acct_wp"]);
    expect(account.cron()).toEqual(["php ~/public_html/wp-cron.php"]);
    expect(account.read("public_html/index.html")).toBe("<p>my site</p>");
    expect(account.paths().filter((path) => path.startsWith("opscrew/"))).toEqual([
      "opscrew/notes-prod/dumps/snapshot-20261011T120000Z.sql.gz",
    ]);
    expect(result?.remaining[0]).toBe(
      "The final dump of the database, ~/opscrew/notes-prod/dumps/snapshot-20261011T120000Z.sql.gz: download it in cPanel's File Manager. ~/opscrew/notes-prod/ and ~/opscrew/ stay because they hold it.",
    );

    // The record keeps only how to reach the panel; the plan says the app was removed.
    expect((await readHostingRecord(deps.paths))?.objects).toEqual([]);
    expect((await readArtifact("plan", deps.paths.files.plan)).deployment.destroyedAt).toBe(
      deps.clock.now().toISOString(),
    );
    const said = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}\n${JSON.stringify(handler.requests)}\n${JSON.stringify(plan)}`;
    expect(said).not.toContain(PANEL_TOKEN);
  });

  it("keeps the final snapshot's copy of the shared files with its dump", async () => {
    const id = "snapshot-20261011T120000Z";
    const w = await world({
      answer: (request) => {
        if (request.kind !== "snapshot") return undefined;
        w.app.account.write(`${w.app.folder}/dumps/${id}.sql.gz`, "final dump");
        w.app.account.write(`${w.app.folder}/dumps/${id}.shared.tar.gz`, "final copy");
        return `result=done\ndump=${id}.sql.gz\nshared=${id}.shared.tar.gz\n`;
      },
    });
    const { result, error } = await w.run();
    expect(error).toBeUndefined();
    expect(w.app.account.paths().filter((path) => path.startsWith("opscrew/"))).toEqual([
      `opscrew/notes-prod/dumps/${id}.sql.gz`,
      `opscrew/notes-prod/dumps/${id}.shared.tar.gz`,
    ]);
    expect(result?.remaining.slice(0, 2)).toEqual([
      `The final dump of the database, ~/opscrew/notes-prod/dumps/${id}.sql.gz: download it in cPanel's File Manager. ~/opscrew/notes-prod/ and ~/opscrew/ stay because they hold it.`,
      `The final copy of the app's shared files, ~/opscrew/notes-prod/dumps/${id}.shared.tar.gz: download it in cPanel's File Manager. ~/opscrew/notes-prod/ and ~/opscrew/ stay because they hold it.`,
    ]);
  });

  it("without the final dump removes the whole folder, then ~/opscrew when nothing else is in it", async () => {
    const w = await world({ database: true });
    const { handler, error } = await w.run({ snapshot: false });
    expect(error).toBeUndefined();
    expect(handler.requests[0]?.details).not.toContain("final dump");
    expect(w.agent.requests).toEqual([]);
    expect(w.app.account.paths().filter((path) => path.startsWith("opscrew"))).toEqual([]);
    expect(w.app.account.cpanel?.state.folders.has("opscrew")).toBe(false);
  });

  it("keeps ~/opscrew while another app's folder is in it", async () => {
    const w = await world();
    w.app.account.write("opscrew/blog-prod/agent.sh", "#!/bin/bash\n");
    const { error } = await w.run({ snapshot: false });
    expect(error).toBeUndefined();
    expect(w.app.account.paths().filter((path) => path.startsWith("opscrew/"))).toEqual([
      "opscrew/blog-prod/agent.sh",
    ]);
  });

  it("removes the Node.js app from CloudLinux's selector through the agent, first (T2717)", async () => {
    const note =
      "~/.cl.selector/htaccess_cache stays as it is: the app's section [/home/acct/opscrew/notes-prod/current] is in it more than once, so OpsCrew can't tell which is the app's";
    const w = await world({
      answer: (request) => (request.kind === "app" ? `result=done\nnote=${note}\n` : undefined),
    });
    await recordObject((await w.app.deps()).paths, { kind: "app", key: "nodejs", value: "22" });
    const { deps, handler, result, error } = await w.run({ snapshot: false });
    expect(error).toBeUndefined();
    const plan = HostingDestroyPlanSchema.parse(
      JSON.parse(
        await readFile(join(deps.paths.files.plansDir, "hosting-prod-destroy.json"), "utf8"),
      ),
    );
    // While the agent still runs: before its cron line goes.
    expect(plan.steps.slice(0, 2)).toEqual([
      { kind: "app", interpreter: "nodejs" },
      expect.objectContaining({ kind: "cron", agent: true }),
    ]);
    expect(handler.requests[0]?.details).toContain(
      "Remove the Node.js app from CloudLinux's selector, with its empty folder in ~/nodevenv/ and its section of ~/.cl.selector/htaccess_cache",
    );
    expect(w.agent.requests).toEqual([
      {
        kind: "app",
        hash: handler.requests[0]?.planHash,
        expires: expect.stringMatching(/^\d+$/),
        action: "destroy",
      },
    ]);
    expect(result?.remaining).toContain(`Of the app in CloudLinux's selector: ${note}.`);
    expect((await readHostingRecord(deps.paths))?.objects).toEqual([]);
  });

  it("stops before anything else when the selector can't remove the app (T2717)", async () => {
    const w = await world({
      answer: (request) =>
        request.kind === "app"
          ? "result=failed\nreason=CloudLinux's selector didn't remove the app: no such app\n"
          : undefined,
    });
    await recordObject((await w.app.deps()).paths, { kind: "app", key: "python", value: "3.12" });
    const { deps, error } = await w.run({ snapshot: false });
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain(
      "The agent didn't remove the app in CloudLinux's selector: CloudLinux's selector didn't remove the app: no such app. Nothing was removed before it.",
    );
    expect(w.app.account.hostnames()).toEqual([HOSTNAME]);
    const objects = (await readHostingRecord(deps.paths))?.objects ?? [];
    expect(objects).toContainEqual({ kind: "app", key: "python", value: "3.12" });
  });

  it("stops plainly, changing nothing, when the record names the app's interpreter wrongly (T2717)", async () => {
    const w = await world();
    await recordObject((await w.app.deps()).paths, { kind: "app", key: "ruby" });
    const { handler, error } = await w.run({ snapshot: false });
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      `.opscrew/hosting.json records the app in CloudLinux's selector as "ruby", which is neither nodejs nor python, so OpsCrew can't tell how to remove it. Nothing was changed.`,
    );
    expect(handler.requests).toEqual([]);
    expect(w.app.account.hostnames()).toEqual([HOSTNAME]);
  });

  it("names the app for the panel when no agent runs to remove it (T2717)", async () => {
    const w = await world();
    const paths = (await w.app.deps()).paths;
    await recordObject(paths, { kind: "app", key: "nodejs", value: "22" });
    // The agent's cron line is gone already.
    const line = agentCronCommand(w.app.folder);
    await updateHostingRecord(paths, (current) => ({
      ...current,
      objects: current.objects.filter((o) => !(o.kind === "cron" && o.value?.endsWith(line))),
    }));
    const { result, error } = await w.run({ snapshot: false });
    expect(error).toBeUndefined();
    expect(w.agent.requests).toEqual([]);
    expect(result?.remaining).toContain(
      "The Node.js app in CloudLinux's selector: no agent runs on the account to remove it, so remove it on the panel's Setup Node.js App page.",
    );
  });

  it("removes a database that came back once more at the end (R10), and keeps a certificate another site uses", async () => {
    const w = await world({ account: cpanelAccount({ reappearingDatabases: true }) });
    const fake = w.app.account.cpanel;
    const id = fake?.state.installed.get(HOSTNAME) as string;
    await w.app.panel.addHostname("shop.example.com", "public_html/shop");
    fake?.state.installed.set("shop.example.com", id);
    const { result, error } = await w.run({ snapshot: false });
    expect(error).toBeUndefined();
    expect(w.app.account.databases()).toEqual([]);
    const deletes = (fake?.calls ?? []).filter((call) => call.func === "delete_database");
    expect(deletes.length).toBeGreaterThan(1);
    expect(fake?.state.certificates.map((c) => c.id)).toContain(id);
    expect(result?.remaining).toContain(
      `A certificate the hostname had stays: The certificate is still installed for shop.example.com; nothing was removed.`,
    );
  });

  it("changes nothing when the hostname isn't typed, and refuses a plan that isn't the approved one", async () => {
    const w = await world();
    const refused = await w.run({ approve: () => false });
    expect(refused.error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect((refused.error as Error).message).toBe(
      "The teardown was not approved. Nothing was changed.",
    );
    expect(w.app.account.hostnames()).toEqual([HOSTNAME]);
    expect(w.agent.requests).toEqual([]);

    const deps = await w.app.deps();
    const plan = HostingDestroyPlanSchema.parse(
      JSON.parse(
        await readFile(join(deps.paths.files.plansDir, "hosting-prod-destroy.json"), "utf8"),
      ),
    );
    const approved = refused.handler.requests[0]?.planHash as string;
    const altered = { ...plan, steps: plan.steps.filter((step) => step.kind !== "dump") };
    await expect(
      applyHostingDestroy(altered, {
        panel: w.app.panel,
        files: w.app.files,
        github: {},
        made: async () => {},
        recorded: async () => [],
        forget: async () => {},
        dns: async () => {},
        sleep: async () => {},
        now: () => new Date(),
        approvedHash: approved,
      }),
    ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect(w.app.account.hostnames()).toEqual([HOSTNAME]);
  });

  it("stops at a failure with what is left recorded, and a run again goes on without a second dump", async () => {
    const w = await world();
    w.app.account.cpanel?.failNext("Mysql", "delete_user", "The server is busy.");
    const first = await w.run();
    expect(first.error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect((first.error as Error).message).toContain(
      "OpsCrew took 5 steps of the destroy plan before it; .opscrew/hosting.json lists what is left.",
    );
    const left = (await readHostingRecord(first.deps.paths))?.objects.map((o) => o.kind);
    expect(left).toEqual(["folder", "file", "database", "deploy-key", "signing-key", "file"]);

    const second = await w.run();
    expect(second.error).toBeUndefined();
    expect(w.agent.requests.filter((r) => r.kind === "snapshot")).toHaveLength(1);
    expect(w.app.account.paths().filter((path) => path.startsWith("opscrew/"))).toEqual([
      "opscrew/notes-prod/dumps/snapshot-20261011T120000Z.sql.gz",
    ]);
  });

  it("stops before anything is removed when the agent doesn't take the final dump", async () => {
    const w = await world({ answer: () => "result=failed\nreason=the dump failed\n" });
    const { error } = await w.run();
    expect((error as Error).message).toBe(
      "The agent didn't take the final dump of the database: the dump failed. Nothing was removed before it.",
    );
    expect(w.app.account.hostnames()).toEqual([HOSTNAME]);
    expect(w.app.account.databases()).toEqual(["acct_notes"]);
  });

  it("deletes the hostname's DNS record on Cloudflare through the IaC approval, after the account", async () => {
    const w = await world({ cloudflare: true, database: false });
    const deps = await w.app.deps();
    await mkdir(join(w.app.root, w.app.plan.infra.dir), { recursive: true });
    const state = tfstateFile(deps.paths);
    await mkdir(dirname(state), { recursive: true });
    await writeFile(
      state,
      plainState([{ mode: "managed", type: "cloudflare_dns_record", name: "a", instances: [{}] }]),
    );
    const engine = new ScriptedDestroyEngine(
      {
        resources: [
          {
            address: "module.dns.cloudflare_dns_record.a",
            type: "cloudflare_dns_record",
            name: "a",
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            action: "delete",
          },
        ],
      },
      w.events,
    );
    const { handler, result, error } = await w.run({
      services: { engine: async () => engine, cloudflare: fakeCloudflare() },
    });
    expect(error).toBeUndefined();
    expect(handler.requests.map((request) => [request.kind, request.confirmPhrase])).toEqual([
      ["hosting-apply", HOSTNAME],
      ["iac-apply", HOSTNAME],
      ["github-secrets", undefined],
    ]);
    expect(handler.requests[0]?.details).toContain(
      "Delete notes.example.com's DNS record on Cloudflare",
    );
    expect(result?.destroyed.map((change) => change.address)).toEqual([
      "module.dns.cloudflare_dns_record.a",
    ]);
    // The account first, then the record, then GitHub.
    expect(w.events.filter((event) => !event.startsWith("plan:"))).toEqual([
      "apply:destroy",
      "deploy key 4001",
      "branch opscrew/release/prod",
      "secret:OPSCREW_RELEASE_SIGNING_KEY",
    ]);
    expect(w.app.account.hostnames()).toEqual([]);
  });
});

describe("destroy on Plesk and DirectAdmin (SC-2705)", () => {
  it("removes the app on Plesk, its scheduled tasks steps for the user in the panel", async () => {
    const w = await world({ account: pleskAccount() });
    const { handler, result, error } = await w.run();
    expect(error).toBeUndefined();
    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain("You, in Plesk: Remove the scheduled task that runs this command");
    expect(details).toContain(agentCronCommand(w.app.folder));
    expect(w.app.account.hostnames()).toEqual([]);
    expect(w.app.account.databases()).toEqual([]);
    expect(w.app.account.paths()).toEqual([
      "opscrew/notes-prod/dumps/snapshot-20261011T120000Z.sql.gz",
    ]);
    expect(
      result?.remaining.some((line) =>
        line.startsWith("In Plesk, unless you did it already: Remove the scheduled task"),
      ),
    ).toBe(true);
    expect((await readHostingRecord((await w.app.deps()).paths))?.objects).toEqual([]);
  });

  it("removes the app on DirectAdmin, its link in the panel's own document root and its certificate", async () => {
    const w = await world({ account: directAdminAccount() });
    const fake = w.app.account.directadmin;
    const { error } = await w.run({ snapshot: false });
    expect(error).toBeUndefined();
    expect(w.app.account.hostnames()).toEqual([]);
    expect(w.app.account.databases()).toEqual([]);
    expect(w.app.account.cron()).toEqual([]);
    expect(fake?.files.has("domains/notes.example.com/public_html")).toBe(false);
    expect(fake?.certificates.get("example.com")?.map((cert) => cert.id) ?? []).toEqual([]);
    expect([...(fake?.files.keys() ?? [])].filter((path) => path.startsWith("opscrew"))).toEqual(
      [],
    );
  });
});

/** A panel and files that log each call in `calls`, with `overrides`, for the apply alone. */
function loggedAccount(
  calls: string[],
  overrides: { panel?: Partial<HostingPanel>; files?: Partial<HostingFiles> } = {},
) {
  const panel = {
    kind: "cpanel",
    operations: new Set(["removeDatabase", "removeCertificate", "remove"]),
    listDatabases: async () => {
      calls.push("listDatabases");
      return [];
    },
    removeDatabase: async ({ name }: { name: string }) => {
      calls.push(`removeDatabase ${name}`);
    },
    removeCertificate: async (id: string) => {
      calls.push(`removeCertificate ${id}`);
    },
    ...overrides.panel,
  } as unknown as HostingPanel;
  const files = {
    list: async () => ["agent.sh", "dumps"],
    remove: async (path: string) => {
      calls.push(`remove ${path}`);
    },
    ...overrides.files,
  } as unknown as HostingFiles;
  return { panel, files };
}

/** `steps` as an approved destroy plan, applied with `account`. */
function applyAlone(
  steps: DestroyStep[],
  account: ReturnType<typeof loggedAccount>,
  recorded: Awaited<ReturnType<Parameters<typeof applyHostingDestroy>[1]["recorded"]>> = [],
) {
  const plan = HostingDestroyPlanSchema.parse({
    plan: "destroy",
    panel: "cpanel",
    account: "acct at panel.example.com",
    environment: "prod",
    hostname: HOSTNAME,
    folder: "opscrew/notes-prod",
    steps,
  });
  return applyHostingDestroy(plan, {
    ...account,
    github: {},
    made: async () => {},
    recorded: async () => recorded,
    forget: async () => {},
    dns: async () => {},
    sleep: async () => {},
    now: () => new Date(),
    approvedHash: hostingDestroyHash(plan),
  });
}

describe("the destroy plan's apply alone", () => {
  it("removes nothing of the folder when the final dump it keeps isn't recorded", async () => {
    const calls: string[] = [];
    const error = await applyAlone(
      [{ kind: "folder", path: "opscrew/notes-prod", keepDump: true }],
      loggedAccount(calls),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect((error as Error).message).toContain(
      "the final dump isn't recorded; nothing in the folder was removed.",
    );
    expect(calls).toEqual([]);
  });

  it("keeps a certificate only on the connector's refusal for one still installed, and stops on any other", async () => {
    const calls: string[] = [];
    const kept = await applyAlone(
      [{ kind: "certificate", id: "c1" }],
      loggedAccount(calls, {
        panel: {
          removeCertificate: async () => {
            throw new OpsCrewError(
              "INVALID_INPUT",
              "The certificate is still installed for shop.example.com; nothing was removed.",
            );
          },
        },
      }),
    );
    expect(kept.kept).toEqual([
      "The certificate is still installed for shop.example.com; nothing was removed.",
    ]);
    await expect(
      applyAlone(
        [{ kind: "certificate", id: "c1" }],
        loggedAccount(calls, {
          panel: {
            removeCertificate: async () => {
              throw new OpsCrewError("INVALID_INPUT", '"c1" is not a certificate id.');
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("looks for a removed database again even when a later step fails, and removes it once more", async () => {
    const calls: string[] = [];
    // A panel whose removal doesn't check again itself: the database is listed again once.
    let back = true;
    const account = loggedAccount(calls, {
      panel: {
        listDatabases: async () => {
          calls.push("listDatabases");
          const listed = back ? ["acct_notes"] : [];
          back = false;
          return listed;
        },
      },
      files: {
        remove: async (path: string) => {
          calls.push(`remove ${path}`);
          throw new OpsCrewError("PROVIDER_ERROR", "cPanel refused to remove the folder.");
        },
      },
    });
    const error = await applyAlone(
      [
        { kind: "database", name: "acct_notes", user: "acct_notes" },
        { kind: "folder", path: "opscrew/notes-prod", keepDump: false },
      ],
      account,
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      "cPanel refused to remove the folder. OpsCrew took 1 step of the destroy plan before it; .opscrew/hosting.json lists what is left.",
    );
    expect(calls).toEqual([
      "removeDatabase acct_notes",
      "remove opscrew/notes-prod",
      "listDatabases",
      "removeDatabase acct_notes",
    ]);
  });
});

describe("the final dump's wait", () => {
  it("says how to remove the app without it when the agent doesn't answer", async () => {
    const w = await world();
    const { error } = await w.run({ services: { sleep: async () => {} } });
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect((error as OpsCrewError).hint).toContain(
      "Then run the command again, or `opscrew destroy --no-snapshot` to remove it without the final dump.",
    );
    expect(w.app.account.hostnames()).toEqual([HOSTNAME]);
  });
});
