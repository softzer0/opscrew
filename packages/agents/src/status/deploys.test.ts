import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ED25519_FINGERPRINT } from "../drift/__fixtures__/own-project";
import { localPlan } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import { commitOf, digestOf, FakePromoteGitHub } from "../promote/__fixtures__/world";
import { ghcrDenied } from "../rollback/__fixtures__/versions";
import { recordOwnServer, recordServerAddress } from "../shared";
import {
  createTestPhaseDeps,
  FakeGitHub,
  OWN_IPV4,
  ownPlan,
  ownRunner,
  portainerPlan,
  ScriptedApprovalHandler,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { deployStateReport, deploysCommand } from "./deploys";
import { componentStatusReport } from "./run";

const NOW = new Date("2026-10-31T12:00:00.000Z");
/** When the server's `.env` was written: 2026-10-31 10:04:00 UTC. */
const SWITCHED = Date.UTC(2026, 9, 31, 10, 4) / 1000;

/** What runs (built from "Add invoices page") and what ran before ("Fix checkout total"). */
const RUNNING = digestOf("running");
const RUNNING_COMMIT = commitOf("running");
const BEFORE = digestOf("before");
const BEFORE_COMMIT = commitOf("before");

/** `plan`, deployed and seen running. */
function deployed(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    deployment: { ...plan.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
  });
}

/** GHCR and GitHub of acme/shop with both images built by prod's workflow from main. */
function registry(): FakePromoteGitHub {
  const github = new FakePromoteGitHub();
  github.build(RUNNING, {
    runId: 902,
    commit: RUNNING_COMMIT,
    environment: "prod",
    run: {
      createdAt: "2026-10-31T09:58:00Z",
      headCommit: { message: "Add invoices page\n\nThe body.", timestamp: "2026-10-31T09:57:00Z" },
    },
  });
  github.build(BEFORE, {
    runId: 901,
    commit: BEFORE_COMMIT,
    environment: "prod",
    run: {
      createdAt: "2026-10-30T15:00:00Z",
      headCommit: { message: "Fix checkout total", timestamp: "2026-10-30T14:59:00Z" },
    },
  });
  return github;
}

/** A rollback's entry in `OPSCREW_DEPLOY_PAUSED` for shop/prod, pinned to `image`. */
function pauseRollback(github: FakePromoteGitHub, image = RUNNING, commit = RUNNING_COMMIT) {
  github.variables.set(
    DEPLOY_PAUSED_VARIABLE,
    JSON.stringify({
      "shop/prod": {
        reason: "rollback",
        since: "2026-10-31T10:02:11.000Z",
        image,
        commit,
        from: commitOf("bad"),
      },
      "blog/prod": { reason: "move", since: "2026-10-31T09:00:00.000Z" },
    }),
  );
}

/** A git runner whose `origin` is github.com/acme/shop; `other` answers anything else. */
function gitRunner(other?: ScriptedRunner): ScriptedRunner {
  return new ScriptedRunner((command, args, options) =>
    command === "git" && args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
      : (other?.run(command, args, options) ?? { exitCode: 0, stdout: "", stderr: "" }),
  );
}

/** What the server's read prints: its `.env` and `.env.previous` images and `.env`'s time. */
function serverOutput(files: { running?: string; previous?: string; since?: number }): string {
  return [
    "==opscrew-deploys:running",
    files.running ?? "",
    "==opscrew-deploys:previous",
    files.previous ?? "",
    "==opscrew-deploys:since",
    files.since === undefined ? "" : String(files.since),
    "",
  ].join("\n");
}

/** A deploy user's shell answering every command with `stdout`, recording the commands. */
function shell(stdout: string, exitCode = 0) {
  const commands: string[] = [];
  const hosts: string[] = [];
  const remote = (host: string): RemoteExec => {
    hosts.push(host);
    return {
      host,
      run: async (command): Promise<CommandResult> => {
        commands.push(command);
        return { exitCode, stdout, stderr: "" };
      },
    };
  };
  return { remote, commands, hosts };
}

/** Prod of shop on a server OpsCrew created, at {@link SERVER_IPV4}, with the deploy key. */
async function serverWorld() {
  const deps = await createTestPhaseDeps({ runner: gitRunner(), clock: { now: () => NOW } });
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  return { deps, plan: deployed(testPlan({ deployed: true })), github: registry() };
}

const BOTH = {
  running: `ghcr.io/acme/shop@${RUNNING}`,
  previous: `ghcr.io/acme/shop@${BEFORE}`,
  since: SWITCHED,
};

describe("the deploys on a server OpsCrew created", () => {
  it("names the version running since the switch, the one before, and that deploys are on", async () => {
    const { deps, plan, github } = await serverWorld();
    const server = shell(serverOutput(BOTH));

    const report = await deployStateReport(deps, plan, {
      services: { remote: server.remote, deploys: github },
    });

    expect(report.lines).toEqual([
      "Deploys (read from the server and GitHub now):",
      `  Running: ${RUNNING_COMMIT.slice(0, 7)} "Add invoices page" (${RUNNING.slice(0, 19)}), since 2026-10-31 10:04 UTC`,
      `  Before it: ${BEFORE_COMMIT.slice(0, 7)} "Fix checkout total" (${BEFORE.slice(0, 19)})`,
      "  Deploys: on (each push to main deploys)",
    ]);
    expect(report.lines).toMatchSnapshot();
    expect(report.deploys).toEqual({
      running: {
        digest: RUNNING,
        commit: RUNNING_COMMIT,
        message: "Add invoices page",
        builtAt: "2026-10-31T09:58:00Z",
      },
      previous: {
        digest: BEFORE,
        commit: BEFORE_COMMIT,
        message: "Fix checkout total",
        builtAt: "2026-10-30T15:00:00Z",
      },
    });
    // One fixed read as the deploy user, audited without the address.
    expect(server.hosts).toEqual([SERVER_IPV4]);
    expect(server.commands).toEqual([deploysCommand(plan)]);
    expect(deploysCommand(plan)).toBe(
      "cd /srv/apps/shop 2> /dev/null || exit 3; echo '==opscrew-deploys:running'; sed -n 's/^APP_IMAGE=//p' .env 2> /dev/null; echo '==opscrew-deploys:previous'; sed -n 's/^APP_IMAGE=//p' .env.previous 2> /dev/null; echo '==opscrew-deploys:since'; stat -c %Y .env 2> /dev/null; true",
    );
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        action: "read the deployed versions (read-only)",
        target: "server",
      }),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(SERVER_IPV4);
    expect(report.lines.join("\n")).not.toContain(SERVER_IPV4);
  });

  it("paused by a rollback: since when, the pin and the resume command, and a run not finished yet", async () => {
    const { deps, plan, github } = await serverWorld();
    pauseRollback(github);
    const services = { remote: shell(serverOutput(BOTH)).remote, deploys: github };

    const pinned = await deployStateReport(deps, plan, { services });

    expect(pinned.lines.slice(3)).toEqual([
      `  Paused since 2026-10-31 10:02 UTC: \`opscrew rollback\` pinned it to ${RUNNING_COMMIT.slice(0, 7)} (${RUNNING.slice(0, 19)}). Run \`opscrew rollback --resume\` when the fix is pushed (add --deploy to deploy main's latest commit now).`,
    ]);
    expect(pinned.deploys?.paused).toEqual({
      reason: "rollback",
      since: "2026-10-31T10:02:11.000Z",
      image: RUNNING,
      commit: RUNNING_COMMIT,
      from: commitOf("bad"),
    });

    // The rollback's run still deploys BEFORE: the server runs another image than the pinned one.
    pauseRollback(github, BEFORE, BEFORE_COMMIT);
    const waiting = await deployStateReport(deps, plan, { services });
    expect(waiting.lines.at(-1)).toBe(
      `  It runs ${RUNNING.slice(0, 19)}, not the pinned ${BEFORE.slice(0, 19)}: the rollback's run hasn't finished.`,
    );
  });

  it("paused for a move's window", async () => {
    const { deps, plan, github } = await serverWorld();
    github.variables.set(
      DEPLOY_PAUSED_VARIABLE,
      JSON.stringify({ "shop/prod": { reason: "move", since: "2026-10-31T09:00:00.000Z" } }),
    );
    const report = await deployStateReport(deps, plan, {
      services: { remote: shell(serverOutput(BOTH)).remote, deploys: github },
    });
    expect(report.lines.at(-1)).toBe(
      "  Paused since 2026-10-31 09:00 UTC for a move's window: `opscrew provision` ends it.",
    );
    expect(report.deploys?.paused).toEqual({
      reason: "move",
      since: "2026-10-31T09:00:00.000Z",
    });
  });

  it("without GitHub: the short digests, why, and the last rollback on this computer, never as the pause", async () => {
    const { deps, plan } = await serverWorld();
    await mkdir(deps.paths.stateDir, { recursive: true });
    await writeFile(
      join(deps.paths.stateDir, "rollback.json"),
      JSON.stringify({
        digest: RUNNING,
        commit: RUNNING_COMMIT,
        from: { digest: digestOf("bad"), commit: commitOf("bad") },
        runUrl: "https://github.com/acme/shop/actions/runs/950",
        at: "2026-10-31T10:05:00.000Z",
        hash: "f".repeat(64),
      }),
    );

    const report = await deployStateReport(deps, plan, {
      services: { remote: shell(serverOutput(BOTH)).remote, deploys: null },
    });

    const why = "No GitHub token is available (set GITHUB_TOKEN or run `gh auth login`).";
    expect(report.lines).toEqual([
      "Deploys (read from the server and GitHub now):",
      `  Running: ${RUNNING.slice(0, 19)}, since 2026-10-31 10:04 UTC`,
      `  Before it: ${BEFORE.slice(0, 19)}`,
      `  OpsCrew could not read their commits or whether deploys are paused from GitHub. ${why}`,
      `  The last rollback on this computer: ${RUNNING_COMMIT.slice(0, 7)} at 2026-10-31 10:05 UTC.`,
    ]);
    expect(report.deploys).toEqual({
      running: { digest: RUNNING },
      previous: { digest: BEFORE },
    });
  });

  it("without GitHub and without a record: says it can't tell whether deploys are paused", async () => {
    const { deps, plan } = await serverWorld();
    const report = await deployStateReport(deps, plan, {
      services: { remote: shell(serverOutput(BOTH)).remote, deploys: null },
    });
    expect(report.lines.at(-1)).toBe(
      "  OpsCrew could not read their commits or whether deploys are paused from GitHub. No GitHub token is available (set GITHUB_TOKEN or run `gh auth login`).",
    );
    expect(report.deploys?.paused).toBeUndefined();
  });

  it("a token without Variables: Read: says the pause is unknown, never that deploys are on", async () => {
    const { deps, plan, github } = await serverWorld();
    pauseRollback(github);
    github.getRepoVariable = async () => {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        "GitHub refused to read the repository variable OPSCREW_DEPLOY_PAUSED.",
      );
    };
    const report = await deployStateReport(deps, plan, {
      services: { remote: shell(serverOutput(BOTH)).remote, deploys: github },
    });
    expect(report.lines.at(-1)).toBe(
      "  Deploys: OpsCrew can't tell whether they're paused: the GitHub token can't read repository variables (Variables: Read).",
    );
    expect(report.lines.join("\n")).not.toContain("Deploys: on");
    expect(report.deploys?.paused).toBeUndefined();
    expect(report.deploys?.running?.commit).toBe(RUNNING_COMMIT);
  });

  it("GHCR refuses the token: the short digests, and why", async () => {
    const { deps, plan, github } = await serverWorld();
    github.imageFacts = async () => {
      throw ghcrDenied("read the image");
    };
    const report = await deployStateReport(deps, plan, {
      services: { remote: shell(serverOutput(BOTH)).remote, deploys: github },
    });
    expect(report.lines.slice(1)).toEqual([
      `  Running: ${RUNNING.slice(0, 19)}, since 2026-10-31 10:04 UTC`,
      `  Before it: ${BEFORE.slice(0, 19)}`,
      "  OpsCrew could not read their commits. GHCR refused to read the image. GitHub's container registry needs a classic token with read:packages, since it may not accept fine-grained tokens. Set OPSCREW_GHCR_READ_TOKEN to one, then run the command again.",
      "  Deploys: on (each push to main deploys)",
    ]);
  });

  it("an image GHCR doesn't have, or that was built elsewhere, is named by its digest", async () => {
    const { deps, plan, github } = await serverWorld();
    github.provenance.delete(BEFORE);
    const report = await deployStateReport(deps, plan, {
      services: { remote: shell(serverOutput(BOTH)).remote, deploys: github },
    });
    expect(report.lines[2]).toBe(`  Before it: ${BEFORE.slice(0, 19)}`);
    expect(report.deploys?.previous).toEqual({ digest: BEFORE });
  });

  it("only one version: none kept before it", async () => {
    const { deps, plan, github } = await serverWorld();
    const report = await deployStateReport(deps, plan, {
      services: {
        remote: shell(serverOutput({ running: BOTH.running, since: SWITCHED })).remote,
        deploys: github,
      },
    });
    expect(report.lines[2]).toBe("  Before it: none kept");
    expect(report.deploys?.previous).toBeUndefined();
  });

  it("a server it cannot read: says why, and still reads the pause", async () => {
    const { deps, plan, github } = await serverWorld();
    pauseRollback(github);
    const report = await deployStateReport(deps, plan, {
      services: { remote: shell("", 255).remote, deploys: github },
    });
    expect(report.lines[1]).toBe(
      "  OpsCrew could not read the versions. OpsCrew could not read the versions on the server over SSH (exit code 255). Check that the server is on and that this computer reaches it over SSH, then try again.",
    );
    expect(report.lines[2]).toMatch(/^ {2}Paused since 2026-10-31 10:02 UTC: /);
    expect(report.deploys).toEqual({ paused: expect.objectContaining({ reason: "rollback" }) });

    const gone = await deployStateReport(deps, plan, {
      services: { remote: shell("", 3).remote, deploys: github },
    });
    expect(gone.lines[1]).toContain(
      "The app's folder /srv/apps/shop is not on the server, so no version of it runs there.",
    );
  });

  it("a stop of the components' check stops every read", async () => {
    const { deps, plan, github } = await serverWorld();
    const server = shell(serverOutput(BOTH));
    const report = await deployStateReport(deps, plan, {
      services: { remote: server.remote, deploys: github },
      check: async () => {
        throw new OpsCrewError("PHASE_PRECONDITION", "Confirm the host key first.");
      },
    });
    expect(report.lines).toEqual([
      "Deploys (read from the server and GitHub now):",
      "  OpsCrew did not read them, for the same reason as the components.",
    ]);
    expect(server.commands).toEqual([]);
    expect((deps.runner as ScriptedRunner).calls).toEqual([]);
  });

  it("never shows a secret in a commit message, the GHCR token or the server's address", async () => {
    const { deps, plan, github } = await serverWorld();
    const secret = fakeSecret("github-token", "deploys-message");
    deps.redactor.addLiteral(secret, "a secret");
    const ghcrToken = fakeSecret("github-pat", "deploys-ghcr");
    deps.env.OPSCREW_GHCR_READ_TOKEN = ghcrToken;
    const run = github.runs.get(902);
    if (run === undefined) throw new Error("no run");
    github.runs.set(902, {
      ...run,
      headCommit: { message: `Use ${secret}`, timestamp: "2026-10-31T09:57:00Z" },
    });
    const report = await deployStateReport(deps, plan, {
      services: { remote: shell(serverOutput(BOTH)).remote, deploys: github },
    });
    const text = JSON.stringify(report) + JSON.stringify(deps.audit.entries);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(ghcrToken);
    expect(text).not.toContain(SERVER_IPV4);
    // GHCR was read with OPSCREW_GHCR_READ_TOKEN.
    expect(github.credentials.at(-1)).toEqual({ username: "acme", token: ghcrToken });
  });
});

describe("the deploys on every target", () => {
  it("a server the user owns: through the pinned admin login, as root where it can", async () => {
    const own = ownRunner();
    const deps = await createTestPhaseDeps({ runner: gitRunner(own), clock: { now: () => NOW } });
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "alice",
      agent: true,
      reachable: true,
    });
    const admin = shell(serverOutput(BOTH));
    const report = await deployStateReport(deps, deployed(ownPlan({ deployed: true })), {
      hostKey: ED25519_FINGERPRINT,
      services: {
        own: { remote: (connection) => admin.remote(connection.host) },
        deploys: registry(),
      },
    });
    expect(report.lines).toMatchSnapshot();
    expect(admin.commands.at(-1)).toContain("sudo -n sh -c");
    expect(deps.audit.entries.at(-1)).toMatchObject({ target: "own server" });
    expect(JSON.stringify([report, deps.audit.entries])).not.toContain(OWN_IPV4);
  });

  it("Portainer: from GHCR's labels opscrew-<env> and opscrew-<env>-previous", async () => {
    const deps = await createTestPhaseDeps({ runner: gitRunner(), clock: { now: () => NOW } });
    const github = registry();
    github.tags.set("opscrew-prod", RUNNING);
    github.tags.set("opscrew-prod-previous", BEFORE);
    const report = await deployStateReport(deps, deployed(portainerPlan({ deployed: true })), {
      services: { deploys: github },
    });
    expect(report.lines).toMatchSnapshot();
    expect(report.lines[0]).toBe("Deploys (read from GitHub now):");
    expect(report.deploys?.running?.commit).toBe(RUNNING_COMMIT);
    expect(report.deploys?.previous?.commit).toBe(BEFORE_COMMIT);
  });

  it("this computer: from the app's folder; the pause only with the local runner", async () => {
    const deps = await createTestPhaseDeps({ runner: gitRunner(), clock: { now: () => NOW } });
    const plan = deployed(localPlan({ image: "registry" }));
    const folder = appFolder(deps.paths, plan);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, ".env"), `APP_IMAGE=ghcr.io/acme/shop@${RUNNING}\n`);
    await writeFile(join(folder, ".env.previous"), `APP_IMAGE=ghcr.io/acme/shop@${BEFORE}\n`);
    await utimes(join(folder, ".env"), SWITCHED, SWITCHED);
    const github = registry();
    pauseRollback(github);

    const alone = await deployStateReport(deps, plan, { services: { deploys: github } });
    expect(alone.lines).toMatchSnapshot();
    expect(alone.lines.join("\n")).not.toContain("Paused");

    const runner = DeployPlanSchema.parse({ ...plan, environment: { runner: "local" } });
    const withRunner = await deployStateReport(deps, runner, { services: { deploys: github } });
    expect(withRunner.lines).toMatchSnapshot();
    expect(withRunner.deploys?.paused?.reason).toBe("rollback");
  });

  it("this computer's own build: named by its reference", async () => {
    const deps = await createTestPhaseDeps({ runner: gitRunner(), clock: { now: () => NOW } });
    const plan = deployed(localPlan());
    const folder = appFolder(deps.paths, plan);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, ".env"), "APP_IMAGE=opscrew-local/shop:build-1\n");
    await utimes(join(folder, ".env"), SWITCHED, SWITCHED);
    const report = await deployStateReport(deps, plan, { services: { deploys: registry() } });
    expect(report.lines).toEqual([
      "Deploys (read from this computer and GitHub now):",
      "  Running: opscrew-local/shop:build-1, since 2026-10-31 10:04 UTC",
      "  Before it: none kept",
    ]);
    expect(report.deploys).toEqual({});
  });
});

describe("componentStatusReport with the deploys", () => {
  it("follows the components, before the scheduled check, and returns them", async () => {
    const { deps, github } = await serverWorld();
    const plan = DeployPlanSchema.parse({
      ...deployed(testPlan({ deployed: true })),
      observability: { check: { enabled: true } },
    });
    const commands: string[] = [];
    const remote = (host: string): RemoteExec => ({
      host,
      run: async (command): Promise<CommandResult> => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: command.startsWith("cd /srv/apps/shop")
            ? serverOutput(BOTH)
            : "shop-app-1|running\nshop-db-1|running\n",
          stderr: "",
        };
      },
    });
    const check = new FakeGitHub();
    check.workflowStates.set("opscrew-check.yml", "active");

    const report = await componentStatusReport(deps, plan, {
      services: { remote, deploys: github, github: check },
    });

    const at = report.lines.indexOf("Deploys (read from the server and GitHub now):");
    expect(at).toBeGreaterThan(0);
    expect(report.lines[at - 1]).toBe("");
    // The snapshots follow the deploys (024), then the scheduled check.
    expect(report.lines.slice(at + 4, at + 8)).toEqual([
      "",
      "Snapshots: none yet; `opscrew snapshot` takes one.",
      "",
      "Scheduled check (.github/workflows/opscrew-check.yml, read from GitHub now):",
    ]);
    expect(report.deploys?.running?.commit).toBe(RUNNING_COMMIT);
  });

  it("a server whose components could not be read is not read again; the pause still is", async () => {
    const { deps, plan, github } = await serverWorld();
    pauseRollback(github);
    const server = shell("", 255);

    const report = await componentStatusReport(deps, plan, {
      services: { remote: server.remote, deploys: github },
    });

    // Only the components' docker ps: no second command on the server.
    expect(server.commands).toHaveLength(1);
    const at = report.lines.indexOf("Deploys (read from the server and GitHub now):");
    expect(report.lines.slice(at + 1)).toEqual([
      "  OpsCrew did not read the versions, for the same reason as the components.",
      expect.stringMatching(/^ {2}Paused since 2026-10-31 10:02 UTC: /),
    ]);
    expect(report.deploys).toEqual({ paused: expect.objectContaining({ reason: "rollback" }) });
  });

  it("a refused host key is asked once: the server is not read again; the pause still is", async () => {
    const handler = new ScriptedApprovalHandler([false]);
    const deps = await createTestPhaseDeps({
      runner: gitRunner(ownRunner()),
      approvalHandler: handler,
      interactive: true,
      clock: { now: () => NOW },
    });
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "alice",
      agent: true,
      reachable: true,
    });
    const admin = shell(serverOutput(BOTH));
    const github = registry();
    pauseRollback(github);

    const report = await componentStatusReport(deps, deployed(ownPlan({ deployed: true })), {
      services: { own: { remote: (connection) => admin.remote(connection.host) }, deploys: github },
    });

    expect(handler.requests).toHaveLength(1);
    expect(admin.commands).toEqual([]);
    expect(report.lines).toContain(
      "  OpsCrew did not read the versions, for the same reason as the components.",
    );
    expect(report.deploys?.paused?.reason).toBe("rollback");
  });

  it("provisioned, never verified, rolled back: the version running from GHCR's labels, and the pause", async () => {
    const { deps, github } = await serverWorld();
    pauseRollback(github);
    github.tags.set("opscrew-prod", RUNNING);
    github.tags.set("opscrew-prod-previous", BEFORE);
    const server = shell(serverOutput(BOTH));

    // Provision ran (`lastApplyAt`); `verify` never did (no `firstDeployAt`).
    const report = await componentStatusReport(deps, testPlan({ deployed: true }), {
      services: { remote: server.remote, deploys: github },
    });

    const at = report.lines.indexOf("Deploys (read from GitHub now):");
    expect(at).toBeGreaterThan(0);
    expect(report.lines.slice(at + 1)).toEqual([
      `  Running: ${RUNNING_COMMIT.slice(0, 7)} "Add invoices page" (${RUNNING.slice(0, 19)})`,
      `  Before it: ${BEFORE_COMMIT.slice(0, 7)} "Fix checkout total" (${BEFORE.slice(0, 19)})`,
      `  Paused since 2026-10-31 10:02 UTC: \`opscrew rollback\` pinned it to ${RUNNING_COMMIT.slice(0, 7)} (${RUNNING.slice(0, 19)}). Run \`opscrew rollback --resume\` when the fix is pushed (add --deploy to deploy main's latest commit now).`,
    ]);
    expect(report.deploys).toMatchObject({
      running: { digest: RUNNING, commit: RUNNING_COMMIT },
      paused: { reason: "rollback", image: RUNNING },
    });
    // The server is read once its components are, after `verify` saw a deploy.
    expect(server.commands).toEqual([]);
  });

  it("provisioned, nothing deployed yet: no deployed version, deploys on", async () => {
    const { deps, github } = await serverWorld();
    const report = await componentStatusReport(deps, testPlan({ deployed: true }), {
      services: { remote: shell("").remote, deploys: github },
    });
    const at = report.lines.indexOf("Deploys (read from GitHub now):");
    expect(report.lines.slice(at + 1)).toEqual([
      "  Running: OpsCrew found no deployed version.",
      "  Deploys: on (each push to main deploys)",
    ]);
  });

  it("before provision ran, reads nothing", async () => {
    const { deps, github } = await serverWorld();
    const server = shell(serverOutput(BOTH));
    const report = await componentStatusReport(deps, testPlan(), {
      services: { remote: server.remote, deploys: github },
    });
    expect(report.deploys).toBeUndefined();
    expect(report.lines.join("\n")).not.toContain("Deploys");
    expect(server.commands).toEqual([]);
  });
});
