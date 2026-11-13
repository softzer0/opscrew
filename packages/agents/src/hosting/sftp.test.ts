// Feature 027 (T2714): an app on an SFTP-only host, through the fake SFTP host: provision, status,
// rollback and destroy, and Plesk's files over SFTP.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeSftpHost, SftpFiles } from "@opscrew/connector-sftp";
import type { ApprovalRequest, Clock, CommandRunner, FetchLike } from "@opscrew/contracts";
import { NodeCommandRunner, type OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import { DEPLOY_PAUSED_VARIABLE, SFTP_DEPLOY_SECRETS } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type HostingDeployTarget,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design/run";
import { runDestroy } from "../destroy/run";
import { runProvision } from "../provision/run";
import { rollback } from "../rollback/index";
import {
  generateEd25519KeyPair,
  hostKeyFingerprint,
  requireGitRepo,
  writeKnownHost,
} from "../shared";
import { componentStatusReport } from "../status/run";
import {
  createTestPhaseDeps,
  FakeDestroyGitHub,
  makeRequirements,
  projectRunner,
  ScriptedApprovalHandler,
} from "../testing";
import { LoggedGitHub, PAGES_REPO } from "../testing/pages";
import { hostingGitHub, hostingTestPlan, pleskAccount, REPOSITORY } from "./__fixtures__/account";
import { hostingDrift } from "./drift";
import { hostingLogs } from "./logs";
import { hostingFiles, panelConnector } from "./panels";
import { provisionHosting } from "./provision";
import {
  type HostingRecord,
  readHostingRecord,
  type SftpRecord,
  updateHostingRecord,
} from "./record";
import { sftpFilesFromEnv } from "./sftp";
import { applySftpDestroy, type SftpDestroyPlan, sftpDestroyHash } from "./sftp-destroy";
import {
  applySftpPlan,
  type SftpPlan,
  SftpPlanSchema,
  sftpPlanFile,
  sftpPlanHash,
} from "./sftp-plan";

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const HOSTNAME = "notes.example.com";
const HOST = "sftp.example.net";
const GITHUB_TOKEN = fakeSecret("github-token", "sftp-provision");
const APP_SECRET = fakeSecret("generic-password", "sftp-app-value");
/** The host's key, as the interview pinned it (made here, public). */
const HOST_KEY = generateEd25519KeyPair("host").publicKeyOpenSsh.split(" ")[1] as string;
/** The user's own key in the host's authorized_keys. */
const USERS_KEY = generateEd25519KeyPair("me@laptop").publicKeyOpenSsh;

const SFTP: SftpRecord = {
  host: HOST,
  port: 22,
  user: "web",
  hostKey: hostKeyFingerprint(HOST_KEY),
  folder: "opscrew",
  phpPath: "/home/web/opscrew",
};

/** sftp on the fake host; everything else as the other tests run it. */
function runnerOn(host: FakeSftpHost): CommandRunner {
  const rest = projectRunner();
  return {
    run: (command, args, options) =>
      command === "sftp" ? host.run(command, args, options) : rest.run(command, args, options),
  };
}

/** The SFTP login in the environment. */
const sftpEnv = (root: string): Record<string, string | undefined> => ({
  OPSCREW_HOME: join(root, ".home-opscrew"),
  OPSCREW_SFTP_HOST: HOST,
  OPSCREW_SFTP_USER: "web",
  OPSCREW_SFTP_KEY: "/home/me/.ssh/id_ed25519",
});

/** A plain PHP app's plan on the SFTP host, as provision leaves it. */
function sftpPlan(): DeployPlan {
  const plan = hostingTestPlan({ database: false });
  return DeployPlanSchema.parse({
    ...plan,
    target: {
      provider: "hosting",
      panel: "sftp",
      app: "php",
      webRoot: "public",
      php: { version: "8.3", via: "account" },
      cron: [],
    },
  });
}

/** Every approval asked, by kind. */
const kinds = (requests: readonly ApprovalRequest[]) => requests.map((request) => request.kind);

/**
 * An app provisioned on the fake SFTP host: releases 812-1 (running), 790-1 and 777-2, the state
 * the deploy workflow writes, GitHub Actions' key in authorized_keys beside the user's, each
 * recorded as provision records it; the host key pinned in OpsCrew's known_hosts.
 */
async function deployedApp() {
  const host = new FakeSftpHost();
  const root = await mkdtemp(join(tmpdir(), "opscrew-sftp-app-"));
  const git = new NodeCommandRunner();
  await git.run("git", ["-C", root, "init", "-q", "-b", "main"]);
  await git.run("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    `https://github.com/${REPOSITORY.owner}/${REPOSITORY.repo}.git`,
  ]);
  const plan = sftpPlan();
  const deps = (
    handler = new ScriptedApprovalHandler(),
    more: { fetch?: FetchLike; clock?: Clock } = {},
  ) =>
    createTestPhaseDeps({
      root,
      env: sftpEnv(root),
      runner: runnerOn(host),
      approvalHandler: handler,
      ...more,
    });
  const setup = await deps();
  await writeArtifact("plan", setup.paths.files.plan, plan);
  const ours = `restrict ${generateEd25519KeyPair("opscrew-notes-prod").publicKeyOpenSsh}`;
  await updateHostingRecord(setup.paths, () => ({
    schemaVersion: 1,
    sftp: SFTP,
    objects: [
      { kind: "folder", key: "opscrew" },
      { kind: "file", key: "opscrew/shared/.env", value: "0".repeat(64) },
      { kind: "file", key: ".ssh/authorized_keys", value: ours },
    ],
  }));
  await writeKnownHost(setup.paths.files.knownHosts, HOST, [
    { type: "ssh-ed25519", key: HOST_KEY },
  ]);
  for (const release of ["812-1", "790-1", "777-2"]) {
    host.write(`opscrew/releases/${release}/public/index.php`, `<?php echo ${release};\n`);
  }
  host.nodes.set("opscrew/current", { type: "link", target: "releases/812-1" });
  host.write("opscrew/shared/.env", `NOTES_API_KEY=${APP_SECRET}\n`, 0o600);
  host.write(
    "opscrew/state/status",
    "running=812-1\nprevious=790-1\nkept=790-1,777-2\nattempt=812-1\nresult=deployed\nreason=\nat=2026-11-12T10:30:40Z\n",
    0o600,
  );
  host.write(".ssh/authorized_keys", `${USERS_KEY}\n${ours}\n`, 0o600);
  return { host, root, plan, deps, ours };
}

describe("status on an SFTP-only host", () => {
  it("shows the running release, those kept and the last attempt, read over SFTP", async () => {
    const w = await deployedApp();
    const deps = await w.deps();
    const { lines } = await componentStatusReport(deps, w.plan);
    expect(lines).toEqual([
      `SFTP host: web at ${HOST}; the app is in opscrew/ and answers on https://${HOSTNAME}.`,
      "Release: 812-1 runs. Kept for a rollback: 790-1 (the default), 777-2.",
      "Last attempt: release 812-1 deployed at 2026-11-12 10:30 UTC.",
      `${HOSTNAME}, its document root /home/web/opscrew/current/public and its certificate are yours to manage in your host's panel.`,
    ]);
    // Read-only: one listing-free read of state/status.
    expect(w.host.runs.flatMap((run) => run.lines)).toEqual([
      expect.stringMatching(/^@get "opscrew\/state\/status" ".*download"$/),
    ]);
  });

  it("before the first release, without the SFTP login, and with another host key pinned", async () => {
    const w = await deployedApp();
    w.host.nodes.delete("opscrew/state/status");
    const deps = await w.deps();
    expect((await componentStatusReport(deps, w.plan)).lines[1]).toBe(
      "Release: none runs yet; the deploy workflow uploads the first one.",
    );
    const without = await createTestPhaseDeps({
      root: w.root,
      env: { OPSCREW_HOME: join(w.root, ".home-opscrew") },
    });
    expect((await componentStatusReport(without, w.plan)).lines).toEqual([
      expect.stringMatching(
        /^OpsCrew could not read the SFTP host\. OPSCREW_SFTP_HOST, OPSCREW_SFTP_USER and OPSCREW_SFTP_KEY aren't set/,
      ),
    ]);
    const other = generateEd25519KeyPair("other").publicKeyOpenSsh.split(" ")[1] as string;
    await writeKnownHost(deps.paths.files.knownHosts, HOST, [{ type: "ssh-ed25519", key: other }]);
    const runs = w.host.runs.length;
    expect((await componentStatusReport(deps, w.plan)).lines[0]).toContain(
      "OpsCrew's known_hosts file on this computer doesn't hold the key you confirmed",
    );
    expect(w.host.runs).toHaveLength(runs);
  });
});

/**
 * The hostname as `server` serves the fake host's app: each answer `status`, naming the release
 * `current` points at; the URLs asked. The clock moves only with the waits.
 */
function webServer(host: FakeSftpHost, server: string, status = 200) {
  const asked: string[] = [];
  let now = Date.parse("2026-11-13T10:00:00Z");
  let waited = 0;
  const fetch: FetchLike = async (url) => {
    asked.push(String(url));
    const release = host.readlink("opscrew/current")?.replace(/^releases\//, "") ?? "";
    return new Response(null, { status, headers: { server, "x-opscrew-release": release } });
  };
  return {
    fetch,
    clock: { now: () => new Date(now) } satisfies Clock,
    sleep: async (ms: number) => {
      now += ms;
      waited += ms;
    },
    asked,
    /** The seconds the rollback waited. */
    waited: () => waited / 1000,
  };
}

describe("rollback on an SFTP-only host", () => {
  it("switches current to the previous release over SFTP in one rename, waits for PHP's path cache and checks, then pauses the deploys", async () => {
    const w = await deployedApp();
    const github = hostingGitHub(w.plan);
    const handler = new ScriptedApprovalHandler(() => true);
    const web = webServer(w.host, "Apache");
    const deps = await w.deps(handler, { fetch: web.fetch, clock: web.clock });
    const result = await rollback(deps, { services: { github, sleep: web.sleep } });
    expect(result).toMatchObject({
      kind: "rolled-back",
      how: "release",
      paused: true,
      target: { version: "790-1" },
      from: { version: "812-1" },
    });
    expect(kinds(handler.requests)).toEqual(["promote"]);
    expect(handler.requests[0]?.details).toContain(
      "Switch: OpsCrew points the app's folder current at release 790-1 over SFTP with one rename",
    );
    expect(handler.requests[0]?.details).toContain(`on the SFTP host web at ${HOST}`);
    expect(w.host.readlink("opscrew/current")).toBe("releases/790-1");
    // A new link beside current, renamed over it: never a moment without one.
    const switched = w.host.runs.find((run) => run.lines.some((line) => line.startsWith("@ln -s")));
    expect(switched?.lines).toEqual([
      expect.stringMatching(/^@ln -s "releases\/790-1" "opscrew\/\.opscrew-[0-9a-f]{16}\.link"$/),
      expect.stringMatching(/^@rename "opscrew\/\.opscrew-[0-9a-f]{16}\.link" "opscrew\/current"$/),
    ]);
    expect(w.host.text("opscrew/state/status")).toBe(
      "running=790-1\nprevious=777-2\nkept=812-1,777-2\nattempt=812-1\nresult=deployed\nreason=\nat=2026-11-12T10:30:40Z\n",
    );
    expect(JSON.parse(github.variables.get(DEPLOY_PAUSED_VARIABLE) ?? "{}")).toMatchObject({
      "notes/prod": { reason: "rollback", image: "790-1" },
    });
    expect(deps.audit.entries.map((entry) => entry.action)).toContain(
      "switch to release 790-1 over SFTP",
    );
    // The health path asked as the deploy workflow asks it: an answer with the release counts on
    // Apache only from 130 seconds after the switch, the 27th try.
    expect(handler.requests[0]?.details).toContain(
      "Then it checks that the app answers with it: on Apache with PHP-FPM, PHP may run the release before for about 2 minutes, and the check waits that long.",
    );
    expect(deps.reporter.text()).toContain(`Checking that ${HOSTNAME}/ answers with release 790-1`);
    expect(deps.reporter.text()).toContain(
      "Waiting for PHP's path cache: PHP may still run the release before for about 2 minutes after the switch, so an answer counts only after that, or at once behind LiteSpeed.",
    );
    expect(web.waited()).toBe(130);
    // Whether the certificate verifies, then the health path 27 times.
    expect(web.asked).toEqual(Array.from({ length: 28 }, () => `https://${HOSTNAME}/`));
  });

  it("counts the first answer with the release behind LiteSpeed", async () => {
    const w = await deployedApp();
    const web = webServer(w.host, "LiteSpeed");
    const deps = await w.deps(new ScriptedApprovalHandler(() => true), {
      fetch: web.fetch,
      clock: web.clock,
    });
    const result = await rollback(deps, {
      services: { github: hostingGitHub(w.plan), sleep: web.sleep },
    });
    expect(result).toMatchObject({ kind: "rolled-back", paused: true });
    expect(web.waited()).toBe(0);
  });

  it("says so in the deploy workflow's terms when the app doesn't answer with the release, and leaves the deploys unpaused", async () => {
    const w = await deployedApp();
    const github = hostingGitHub(w.plan);
    const web = webServer(w.host, "Apache", 500);
    const deps = await w.deps(new ScriptedApprovalHandler(() => true), {
      fetch: web.fetch,
      clock: web.clock,
    });
    const error = await rollback(deps, { services: { github, sleep: web.sleep } }).catch(
      (thrown: unknown) => thrown as OpsCrewError,
    );
    expect(error).toMatchObject({
      code: "COMMAND_FAILED",
      message: `OpsCrew switched prod to release 790-1 over SFTP, but ${HOSTNAME}/ didn't answer 2xx or 3xx with it (it answered 500 with release 790-1). prod's deploys aren't paused.`,
      hint: "`opscrew status --env prod` shows the release that runs now. Then roll back to another release (`opscrew rollback --env prod --list` lists them) or deploy a fix forward.",
    });
    expect(web.waited()).toBe(135);
    expect(w.host.readlink("opscrew/current")).toBe("releases/790-1");
    expect(github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();
  });

  it("asks over HTTP while the hostname's certificate doesn't verify", async () => {
    const w = await deployedApp();
    const web = webServer(w.host, "LiteSpeed");
    const fetch: FetchLike = async (url, init) => {
      if (String(url).startsWith("https:")) throw new Error("fetch failed");
      return web.fetch(url, init);
    };
    const deps = await w.deps(new ScriptedApprovalHandler(() => true), {
      fetch,
      clock: web.clock,
    });
    await rollback(deps, { services: { github: hostingGitHub(w.plan), sleep: web.sleep } });
    expect(web.asked).toEqual([`http://${HOSTNAME}/`]);
  });

  it("doesn't wait or ask for a static site", async () => {
    const w = await deployedApp();
    const site = DeployPlanSchema.parse({
      ...w.plan,
      target: { provider: "hosting", panel: "sftp", app: "static", webRoot: ".", cron: [] },
    });
    const setup = await w.deps();
    await writeArtifact("plan", setup.paths.files.plan, site);
    const handler = new ScriptedApprovalHandler(() => true);
    const web = webServer(w.host, "Apache");
    const deps = await w.deps(handler, { fetch: web.fetch, clock: web.clock });
    const result = await rollback(deps, {
      services: { github: hostingGitHub(site), sleep: web.sleep },
    });
    expect(result).toMatchObject({ kind: "rolled-back", target: { version: "790-1" } });
    expect(handler.requests[0]?.details).not.toContain("checks that the app answers");
    expect(deps.reporter.text()).not.toContain("Waiting for PHP's path cache");
    expect(web.asked).toEqual([]);
    expect(web.waited()).toBe(0);
  });

  it("changes nothing when the approval is refused", async () => {
    const w = await deployedApp();
    const deps = await w.deps(new ScriptedApprovalHandler(() => false));
    await expect(rollback(deps, { services: { github: hostingGitHub(w.plan) } })).rejects.toThrow();
    expect(w.host.readlink("opscrew/current")).toBe("releases/812-1");
  });
});

describe("destroy on an SFTP-only host", () => {
  it("removes GitHub Actions' key and the app's folder, approved with the typed hostname", async () => {
    const w = await deployedApp();
    w.host.write("public_html/index.html", "<p>my site</p>");
    const events: string[] = [];
    const github = new FakeDestroyGitHub(events);
    const handler = new ScriptedApprovalHandler(() => ({ approved: true, confirmation: HOSTNAME }));
    const deps = await w.deps(handler);
    const result = await runDestroy(deps, { services: { github } });
    const approval = handler.requests[0];
    expect(approval).toMatchObject({
      kind: "hosting-apply",
      allowDestroy: true,
      confirmPhrase: HOSTNAME,
    });
    expect(approval?.details).toContain(
      `Remove GitHub Actions' key from ~/.ssh/authorized_keys: ${w.ours}`,
    );
    expect(approval?.details).toContain("Remove opscrew/ with everything in it");
    expect(w.host.paths()).toEqual([
      ".ssh",
      ".ssh/authorized_keys",
      "public_html",
      "public_html/index.html",
    ]);
    expect(w.host.text(".ssh/authorized_keys")).toBe(`${USERS_KEY}\n`);
    expect((await readHostingRecord(deps.paths))?.objects).toEqual([]);
    expect(github.deleted).toEqual(expect.arrayContaining(Object.values(SFTP_DEPLOY_SECRETS)));
    expect(result.remaining).toEqual(
      expect.arrayContaining([
        `${HOSTNAME}, its document root and its certificate in your host's panel: point the hostname elsewhere or remove it there.`,
      ]),
    );
  });

  it("removes nothing when the hostname isn't typed", async () => {
    const w = await deployedApp();
    const deps = await w.deps(new ScriptedApprovalHandler(() => false));
    await expect(
      runDestroy(deps, { services: { github: new FakeDestroyGitHub([]) } }),
    ).rejects.toThrow("The teardown was not approved");
    expect(w.host.readlink("opscrew/current")).toBe("releases/812-1");
    expect(w.host.text(".ssh/authorized_keys")).toBe(`${USERS_KEY}\n${w.ours}\n`);
  });
});

describe("the safety gate on an SFTP-only host", () => {
  const login = {
    host: HOST,
    port: 22,
    user: "web",
    keyFile: "/home/me/.ssh/id_ed25519",
    knownHostsFile: "/home/me/.opscrew/known_hosts",
  };
  const plan: SftpPlan = {
    plan: "sftp",
    account: `web at ${HOST}`,
    environment: "prod",
    hostname: HOSTNAME,
    folder: "opscrew",
    documentRoot: "/home/web/opscrew/current/public",
    steps: [{ kind: "folder", parent: false, placeholder: "releases/0-0/public" }],
  };
  const context = (host: FakeSftpHost) => ({
    files: new SftpFiles(login, { runner: host }),
    contents: new Map<string, string>(),
    redactor: new Redactor(),
    made: async () => {},
    storeKey: async () => {},
    keyComment: "opscrew-notes-prod",
  });

  it("applies no plan but the approved one, and sends nothing", async () => {
    const host = new FakeSftpHost();
    for (const approvedHash of ["0".repeat(64), "not a hash"]) {
      await expect(applySftpPlan(plan, { ...context(host), approvedHash })).rejects.toMatchObject({
        code: "PLAN_HASH_MISMATCH",
      });
    }
    // The approved plan's hash doesn't apply a changed plan.
    const changed: SftpPlan = { ...plan, folder: "elsewhere" };
    await expect(
      applySftpPlan(changed, { ...context(host), approvedHash: sftpPlanHash(plan) }),
    ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect(host.runs).toEqual([]);
  });

  it("removes nothing but what the approved destroy plan lists, and sends nothing", async () => {
    const host = new FakeSftpHost();
    host.write("opscrew/releases/812-1/public/index.php", "<?php");
    const destroy: SftpDestroyPlan = {
      plan: "sftp-destroy",
      account: `web at ${HOST}`,
      environment: "prod",
      hostname: HOSTNAME,
      steps: [{ kind: "folder", path: "opscrew" }],
    };
    const approved = sftpDestroyHash(destroy);
    for (const [candidate, approvedHash] of [
      [destroy, "0".repeat(64)],
      [{ ...destroy, steps: [{ kind: "folder", path: "public_html" }] }, approved],
    ] as const) {
      await expect(
        applySftpDestroy(candidate as SftpDestroyPlan, {
          files: new SftpFiles(login, { runner: host }),
          forget: async () => {},
          taken: [],
          approvedHash,
        }),
      ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    }
    expect(host.runs).toEqual([]);
    expect(host.paths("opscrew")).toContain("opscrew/releases/812-1/public/index.php");
  });

  it("never takes over a folder that appears between the plan and its apply", async () => {
    const host = new FakeSftpHost();
    host.write("opscrew/index.html", "mine");
    const error = await applySftpPlan(plan, {
      ...context(host),
      approvedHash: sftpPlanHash(plan),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((error as OpsCrewError).message).toContain(
      "Your SFTP host already has the folder opscrew, and OpsCrew's record (.opscrew/hosting.json) doesn't list it as OpsCrew's.",
    );
    expect(host.paths()).toEqual(["opscrew", "opscrew/index.html"]);
    expect(host.runs.flatMap((run) => run.lines)).toEqual([`@ls -lan "opscrew"`]);
  });

  it("refuses an app with a release command before anything is sent", async () => {
    const w = await deployedApp();
    const handler = new ScriptedApprovalHandler(() => true);
    const deps = await w.deps(handler);
    const plan = { ...w.plan, app: { ...w.plan.app, releaseCommand: "php bin/migrate.php" } };
    await expect(
      provisionHosting(
        deps,
        {},
        { plan, requirements: undefined, git: await requireGitRepo(deps) },
      ),
    ).rejects.toThrow(
      "An SFTP-only host runs no release command, so OpsCrew can't deploy an app that needs one there. Nothing was changed.",
    );
    expect(w.host.runs).toEqual([]);
    expect(handler.requests).toEqual([]);
  });
});

describe("logs on an SFTP-only host", () => {
  it("says plainly there's no agent log, and where each deploy's lines are", async () => {
    const w = await deployedApp();
    const deps = await w.deps();
    const error = await hostingLogs(deps, w.plan, { tail: 50 }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "An SFTP-only host runs no OpsCrew agent, so there is no agent log for `opscrew logs` to show there: GitHub Actions uploads and switches each release.",
    });
    expect((error as OpsCrewError).hint).toContain(
      `Open the runs of the deploy workflow (${w.plan.cicd.workflowPath}) in GitHub Actions`,
    );
    expect(w.host.runs).toEqual([]);
  });
});

describe("the checks after provision on an SFTP-only host", () => {
  it("read the host's files over SFTP when OPSCREW_SFTP_* are set", async () => {
    const w = await deployedApp();
    const deps = await w.deps();
    expect((await hostingDrift(deps, w.plan, { github: null })).clean).toBe(true);
    expect(w.host.runs.flatMap((run) => run.lines)).toContainEqual(
      expect.stringMatching(/^@get "opscrew\/agent\.sh" /),
    );
    const without = await createTestPhaseDeps({
      root: w.root,
      env: { OPSCREW_HOME: join(w.root, ".home-opscrew") },
    });
    await expect(hostingDrift(without, w.plan, { github: null })).rejects.toThrow(
      "OpsCrew can't reach the SFTP host's files from this computer",
    );
  });
});

describe("Plesk's files over SFTP", () => {
  it("are the SFTP connector's when OPSCREW_SFTP_* are set, the panel's own calls otherwise", async () => {
    const account = pleskAccount();
    const deps = await createTestPhaseDeps({
      env: sftpEnv(await mkdtemp(join(tmpdir(), "opscrew-sftp-"))),
    });
    const panel = panelConnector("plesk", account.access, deps);
    expect(hostingFiles(panel, sftpFilesFromEnv(deps))).toBeInstanceOf(SftpFiles);
    const bare = await createTestPhaseDeps({});
    expect(hostingFiles(panel, sftpFilesFromEnv(bare))).toBeUndefined();
  });
});

/**
 * `examples/php-plain-mysql` as a git project with a GitHub `origin` (pushes go to a bare
 * repository), interviewed for the fake SFTP host and designed; `run` provisions it once.
 */
async function project(host: FakeSftpHost) {
  const runner = new NodeCommandRunner();
  const root = await mkdtemp(join(tmpdir(), "opscrew-sftp-provision-"));
  const bare = await mkdtemp(join(tmpdir(), "opscrew-sftp-remote-"));
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runner.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await materializeFixture(join(EXAMPLES, "php-plain-mysql"), root);
  await writeFile(join(root, ".gitignore"), ".opscrew/\n.env\nproduction.env\n");
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpsCrew Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(
    root,
    "remote",
    "add",
    "origin",
    `https://github.com/${PAGES_REPO.owner}/${PAGES_REPO.repo}.git`,
  );
  await git(root, "remote", "set-url", "--push", "origin", bare);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "init");
  await git(root, "push", "-q", "origin", "main");
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...sftpEnv(root),
    GITHUB_TOKEN,
    GH_TOKEN: undefined,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  await writeFile(
    join(root, "production.env"),
    `NOTES_API_KEY='Notes ${APP_SECRET}'\nDB_HOST=localhost\nDB_PORT=3306\nDB_DATABASE=notes\nDB_USERNAME=notes\nDB_PASSWORD=${APP_SECRET}\n`,
  );
  const fetch: FetchLike = async () => new Response("{}", { status: 404 });
  const deps = await createTestPhaseDeps({ root, env, fetch, runner: runnerOn(host) });
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-11-12T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: { ...(await detectProject(root)), name: "notes" },
    summary: "An app.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({
      provider: "hosting",
      region: undefined,
      domain: HOSTNAME,
      dnsProvider: "other",
    }),
  );
  await updateHostingRecord(deps.paths, () => ({ schemaVersion: 1, objects: [], sftp: SFTP }));
  await writeKnownHost(deps.paths.files.knownHosts, HOST, [{ type: "ssh-ed25519", key: HOST_KEY }]);
  await runDesign(deps);
  const designed = await readArtifact("plan", deps.paths.files.plan);
  await writeArtifact("plan", deps.paths.files.plan, {
    ...designed,
    app: {
      ...designed.app,
      env: [...designed.app.env, { name: "NOTES_API_KEY", secret: true, source: "user" }],
    },
  });
  const run = async (
    answer: (request: ApprovalRequest) => boolean = () => true,
    options: { planOnly?: boolean } = {},
  ) => {
    const handler = new ScriptedApprovalHandler(answer);
    const runDeps = await createTestPhaseDeps({
      root,
      env,
      fetch,
      runner: runnerOn(host),
      approvalHandler: handler,
    });
    const log: string[] = [];
    const github = new LoggedGitHub(log);
    const outcome = await runProvision(runDeps, { services: { github }, ...options }).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { deps: runDeps, handler, log, github, ...outcome };
  };
  /** GitHub merges the provision pull request, and this clone pulls main. */
  const merge = async () => {
    const branch = await git(root, "branch", "--show-current");
    if (branch === "main") return;
    await git(bare, "update-ref", "refs/heads/main", await git(root, "rev-parse", "HEAD"));
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--ff-only", branch);
  };
  return { root, run, merge };
}

describe("provision on an SFTP-only host", () => {
  it("makes the app's folder, its settings and GitHub Actions' key, then opens the pull request", async () => {
    const host = new FakeSftpHost();
    host.write(".ssh/authorized_keys", `${USERS_KEY}\n`, 0o600);
    const p = await project(host);
    const { deps, handler, error, result, github } = await p.run();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ applied: true, outputs: { url: `https://${HOSTNAME}` } });
    expect(kinds(handler.requests)).toEqual([
      "hosting-apply",
      "github-secrets",
      "repo-write",
      "git-push",
      "pull-request",
    ]);

    // The plan: what OpsCrew makes, and what stays the user's.
    const plan = SftpPlanSchema.parse(
      JSON.parse(await readFile(sftpPlanFile(deps.paths, "prod"), "utf8")),
    );
    expect(plan).toMatchObject({
      account: `web at ${HOST}`,
      hostname: HOSTNAME,
      folder: "opscrew",
      documentRoot: "/home/web/opscrew/current/public",
    });
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "folder",
      "file",
      "file",
      "file",
      "values",
      "ci-key",
    ]);
    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain(
      `Yours to set in your host's panel, as OpsCrew can't over SFTP: ${HOSTNAME} pointed at /home/web/opscrew/current/public, its certificate, and a database if the app needs one`,
    );
    expect(details).toContain(
      `The key can read, change and remove every file the SFTP user web at ${HOST} can`,
    );

    // The app's folder: the placeholder release, current, the settings outside the web root.
    expect(host.readlink("opscrew/current")).toBe("releases/0-0");
    expect(host.nodes.get("opscrew/releases/0-0/public")).toMatchObject({ type: "dir" });
    expect(host.modeOf("opscrew/state")).toBe(0o700);
    expect(host.modeOf("opscrew/shared")).toBe(0o711);
    expect(host.modeOf("opscrew/shared/.env")).toBe(0o600);
    expect(host.text("opscrew/shared/.env")).toContain(`NOTES_API_KEY='Notes ${APP_SECRET}'`);
    expect(host.text("opscrew/shared/env.php")).toContain("'NOTES_API_KEY' => true,");
    // The PHP lines each release gets: the app's settings, and PHP following each switch (R16).
    expect(host.text("opscrew/shared/env.htaccess")).toContain(
      'php_flag opcache.revalidate_path on\nphp_value auto_prepend_file "/home/web/opscrew/shared/env.php"',
    );
    expect(host.text("opscrew/shared/env.user.ini")).toContain(
      'opcache.revalidate_path = 1\nauto_prepend_file = "/home/web/opscrew/shared/env.php"',
    );

    // GitHub Actions' key: restricted in authorized_keys beside the user's, its private half and
    // the host's reach only in GitHub.
    const keys = host.text(".ssh/authorized_keys") ?? "";
    expect(keys.split("\n")).toEqual([
      USERS_KEY,
      expect.stringMatching(/^restrict ssh-ed25519 [A-Za-z0-9+/=]+ opscrew-notes-prod$/),
      "",
    ]);
    expect(github.secrets.get(SFTP_DEPLOY_SECRETS.url)).toBe(`sftp://web@${HOST}:22/opscrew`);
    expect(github.secrets.get(SFTP_DEPLOY_SECRETS.knownHosts)).toBe(
      `${HOST} ssh-ed25519 ${HOST_KEY}\n`,
    );
    const privateKey = github.secrets.get(SFTP_DEPLOY_SECRETS.privateKey) ?? "";
    expect(privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    const said = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}\n${JSON.stringify(handler.requests)}`;
    expect(said).not.toContain(privateKey.split("\n")[1]);
    expect(said).not.toContain(APP_SECRET);
    expect((await readHostingRecord(deps.paths))?.objects).toEqual([
      { kind: "folder", key: "opscrew" },
      {
        kind: "file",
        key: "opscrew/shared/.env",
        value: plan.steps.find((s) => s.kind === "values")?.digest,
      },
      { kind: "file", key: ".ssh/authorized_keys", value: keys.split("\n")[1] },
    ] satisfies HostingRecord["objects"]);

    // The plan's PHP, the workflow and the pull request.
    const saved = await readArtifact("plan", deps.paths.files.plan);
    expect((saved.target as HostingDeployTarget).php).toEqual({ version: "8.5", via: "account" });
    expect(deps.reporter.text()).toContain(
      "releases are built with PHP 8.5, the newest the app allows",
    );
    const workflow = await readFile(join(p.root, saved.cicd.workflowPath), "utf8");
    expect(workflow).toContain("Upload, switch and check the release");
    expect(workflow).not.toContain("RELEASE_SIGNING_KEY");
    const body = github.pulls[0]?.body ?? "";
    expect(body).toContain("which your SFTP host serves");
    expect(body).not.toContain("agent.sh");
    expect(body).not.toContain(HOST);

    // Once it is merged, a run again changes nothing on the host.
    await p.merge();
    const again = await p.run();
    expect(again.error).toBeUndefined();
    expect(again.deps.reporter.text()).toContain("The hosting plan has nothing to change");
    expect(kinds(again.handler.requests)).not.toContain("hosting-apply");
  });

  it("with --plan-only gives the plan's hash to approve, as a panel account's, and changes nothing", async () => {
    const host = new FakeSftpHost();
    const p = await project(host);
    const { deps, handler, error, result } = await p.run(undefined, { planOnly: true });
    expect(error).toBeUndefined();
    const plan = SftpPlanSchema.parse(
      JSON.parse(await readFile(sftpPlanFile(deps.paths, "prod"), "utf8")),
    );
    expect(result).toMatchObject({ applied: false, hostingPlanHashes: [sftpPlanHash(plan)] });
    expect(kinds(handler.requests)).not.toContain("hosting-apply");
    expect(host.nodes.get("opscrew")).toBeUndefined();
  });

  it("says plainly that the hosting plan wasn't approved, and changes nothing", async () => {
    const host = new FakeSftpHost();
    const p = await project(host);
    const { error } = await p.run(() => false);
    expect(String(error)).toContain("The hosting plan was not approved");
    expect(String(error)).not.toContain("The The");
    expect(host.nodes.get("opscrew")).toBeUndefined();
  });

  it("lists GitHub Actions' key for the host's panel where it doesn't show authorized_keys, then continues", async () => {
    const host = new FakeSftpHost();
    const p = await project(host);
    const first = await p.run();
    expect(first.error).toBeUndefined();
    expect(kinds(first.handler.requests)).toEqual(["hosting-apply", "github-secrets"]);
    expect(first.handler.requests[0]?.details).toContain(
      "its public half for you to add to the SFTP user's keys in your host's panel",
    );
    const said = first.deps.reporter.text();
    expect(said).toContain("Your host doesn't show ~/.ssh/authorized_keys over SFTP");
    expect(said).toMatch(/ {2}restrict ssh-ed25519 \S+ opscrew-notes-prod\n/);
    expect(host.nodes.has(".ssh")).toBe(false);
    // The host is set up: status reads it from here on.
    const set = await readArtifact("plan", first.deps.paths.files.plan);
    expect(set.deployment.lastApplyAt).toBeDefined();
    const second = await p.run();
    expect(second.error).toBeUndefined();
    expect(kinds(second.handler.requests)).toEqual(["repo-write", "git-push", "pull-request"]);
  });

  it("never takes over a folder it didn't make, and changes nothing", async () => {
    const host = new FakeSftpHost();
    host.write("opscrew/index.html", "mine");
    const p = await project(host);
    const { error, handler } = await p.run();
    expect(String(error)).toContain(
      "Your SFTP host already has the folder opscrew, and OpsCrew's record (.opscrew/hosting.json) doesn't list it as OpsCrew's.",
    );
    expect(handler.requests).toEqual([]);
    expect(host.paths()).toEqual(["opscrew", "opscrew/index.html"]);
  });
});
