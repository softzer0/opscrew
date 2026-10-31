import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { FAILED_DEPLOY_DIR } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import { recordOwnServer, recordServerAddress } from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  freshFacts,
  OWN_IPV4,
  ownPlan,
  ownRunner,
  portainerPlan,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import type { LogLine, LogRead } from "./lines";
import { readLogs } from "./read";

/** A digest generated for the test, never a real registry's. */
const DIGEST = `sha256:${createHash("sha256").update("failed copy").digest("hex")}`;
const IMAGE = `ghcr.io/example-org/shop@${DIGEST}`;
const SHORT = DIGEST.slice(0, 19);
const KEPT = `/srv/apps/shop/${FAILED_DEPLOY_DIR}`;

function about(failed: string): string {
  return `image=${IMAGE}\ntime=2026-10-31T09:15:00Z\nfailed=${failed}\n`;
}

/** Docker's `--timestamps` lines, both streams in one file as `keep_failed` writes them. */
const APP_LOG = [
  "2026-10-31T09:14:58.000000001Z listening on 3000",
  "2026-10-31T09:14:59.000000002Z Error: cannot connect to the database",
  "",
].join("\n");

/** Every line of `read`, until it ends. */
async function collect(read: LogRead): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  for await (const line of read) lines.push(line);
  return lines;
}

/** The fixed read of a kept file, as `logs --failed` sends it (without sudo). */
function readKept(name: string): string {
  return `test -e ${KEPT} || exit 3; test -x ${KEPT} || exit 4; test -e ${KEPT}/${name} || exit 3; cat ${KEPT}/${name}`;
}

/**
 * A server's shell that answers the fixed reads of a kept file (the `test`s, then `cat`), with or
 * without `sudo -n sh -c`, and the own server's connection check (`true`); it records each
 * command. With `enterable` false, the login cannot enter the kept folder (0700, another user's).
 */
class FakeKeptFiles {
  readonly commands: string[] = [];
  enterable = true;
  constructor(readonly files: Record<string, string> = {}) {}

  remote(host = "server"): RemoteExec {
    return {
      host,
      run: async (command: string) => {
        this.commands.push(command);
        if (command === "true") return { exitCode: 0, stdout: "", stderr: "" };
        const match =
          /^(?:sudo -n sh -c ')?test -e (\S+) \|\| exit 3; test -x \1 \|\| exit 4; test -e (\S+) \|\| exit 3; cat \2'?$/.exec(
            command,
          );
        if (match === null) throw new Error(`unexpected command: ${command}`);
        const dir = `${match[1]}/`;
        if (!Object.keys(this.files).some((file) => file.startsWith(dir))) {
          return { exitCode: 3, stdout: "", stderr: "" };
        }
        if (!this.enterable) return { exitCode: 4, stdout: "", stderr: "" };
        const text = this.files[match[2] as string];
        return text === undefined
          ? { exitCode: 3, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: text, stderr: "" };
      },
    };
  }
}

/** A Hetzner plan with a worker, deployed. */
function workerPlan(): DeployPlan {
  const base = testPlan({ deployed: true });
  return DeployPlanSchema.parse({
    ...base,
    processes: {
      workers: [{ name: "worker", command: "node worker.js", source: "procfile" }],
    },
  });
}

/** A server OpsCrew created at {@link SERVER_IPV4}, whose shell is `files`. */
async function cloudServer(files: FakeKeptFiles) {
  const deps = await createTestPhaseDeps();
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  return { deps, services: { remote: (host: string) => files.remote(host) } };
}

const READ_ABOUT = readKept("about");
const READ_APP = readKept("app.log");

describe("readLogs --failed on a server OpsCrew created", () => {
  it("shows the failed copy's kept lines, first saying which copy failed what, and when", async () => {
    const files = new FakeKeptFiles({
      [`${KEPT}/about`]: about("health"),
      [`${KEPT}/app.log`]: APP_LOG,
    });
    const { deps, services } = await cloudServer(files);

    const read = await readLogs(deps, workerPlan(), { services, failed: true });

    expect(read.first).toBe(
      `Lines of the copy of ${SHORT} that failed its health check at 2026-10-31 09:15 UTC; OpsCrew removed it. \`opscrew logs\` shows the version running now.`,
    );
    expect(await collect(read)).toEqual([
      {
        time: "2026-10-31T09:14:58.000000001Z",
        service: "app",
        stream: "stdout",
        text: "listening on 3000",
      },
      {
        time: "2026-10-31T09:14:59.000000002Z",
        service: "app",
        stream: "stdout",
        text: "Error: cannot connect to the database",
      },
    ]);
    expect(files.commands).toEqual([READ_ABOUT, READ_APP]);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        action: "read the failed deploy's lines (read-only)",
        target: "server",
      }),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(SERVER_IPV4);
    expect(read.first).not.toContain(SERVER_IPV4);
  });

  it("without --service, shows the process that failed; --service picks another part", async () => {
    const files = new FakeKeptFiles({
      [`${KEPT}/about`]: about("process worker"),
      [`${KEPT}/worker.log`]: "2026-10-31T09:14:58.000000001Z worker crashed\n",
    });
    const { deps, services } = await cloudServer(files);

    const read = await readLogs(deps, workerPlan(), { services, failed: true });
    expect(read.first).toContain(
      `the copy of ${SHORT} that failed its process check (worker did not keep running)`,
    );
    expect(await collect(read)).toEqual([
      expect.objectContaining({ service: "worker", text: "worker crashed" }),
    ]);
    expect(files.commands.at(-1)).toBe(readKept("worker.log"));

    const app = await readLogs(deps, workerPlan(), { services, failed: true, service: "app" });
    expect(app.first).toContain("It kept no lines of the web process (app).");
    expect(await collect(app)).toEqual([]);
  });

  it("says plainly when the process that failed is no longer in the plan", async () => {
    const files = new FakeKeptFiles({
      [`${KEPT}/about`]: about("process mailer"),
      [`${KEPT}/mailer.log`]: "2026-10-31T09:14:58.000000001Z mailer crashed\n",
    });
    const { deps, services } = await cloudServer(files);

    const read = await readLogs(deps, workerPlan(), { services, failed: true });

    expect(read.first).toContain(
      "It failed on mailer, which the plan no longer has. --service takes app, worker, db and edge.",
    );
    expect(await collect(read)).toEqual([]);
  });

  it("names the check from outside, and --tail keeps the latest kept lines", async () => {
    const files = new FakeKeptFiles({
      [`${KEPT}/about`]: about("check"),
      [`${KEPT}/app.log`]: APP_LOG,
    });
    const { deps, services } = await cloudServer(files);
    const read = await readLogs(deps, workerPlan(), { services, failed: true, tail: 1 });
    expect(read.first).toContain("that failed the check from outside at");
    expect((await collect(read)).map((line) => line.text)).toEqual([
      "Error: cannot connect to the database",
    ]);
  });

  it("says so when no failed deploy's lines are kept (no folder)", async () => {
    const files = new FakeKeptFiles();
    const { deps, services } = await cloudServer(files);
    const read = await readLogs(deps, workerPlan(), { services, failed: true });
    expect(read.first).toBe(
      "No failed deploy's lines are kept on the server: they are kept when a new version fails its checks. `opscrew logs` shows the version running now.",
    );
    expect(await collect(read)).toEqual([]);
    expect(files.commands).toEqual([READ_ABOUT]);
  });

  it("masks a registered secret value and a token-shaped value in the kept lines", async () => {
    const session = "session-value-not-shaped-like-a-token-0002";
    const token = fakeSecret("github-token", "failed-logs");
    const files = new FakeKeptFiles({
      [`${KEPT}/about`]: about("health"),
      [`${KEPT}/app.log`]: [
        `2026-10-31T09:14:58.000000001Z session ${session} started`,
        `2026-10-31T09:14:59.000000002Z token ${token} used`,
        "",
      ].join("\n"),
    });
    const { deps, services } = await cloudServer(files);
    const file = generatedValuesFile(deps);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ env: { SESSION_SECRET: session } })}\n`);

    const read = await readLogs(deps, workerPlan(), { services, failed: true });
    const lines = await collect(read);

    const text = JSON.stringify([read.first, lines, deps.audit.entries]);
    expect(text).not.toContain(session);
    expect(text).not.toContain(token);
    expect(lines.map((line) => line.text)).toEqual([
      expect.stringMatching(/^session \[REDACTED[^\]]*\] started$/),
      expect.stringMatching(/^token \[REDACTED[^\]]*\] used$/),
    ]);
  });

  it("refuses --follow and --since, and an unknown --service, before connecting", async () => {
    const files = new FakeKeptFiles();
    const { deps, services } = await cloudServer(files);
    for (const options of [{ follow: true }, { since: "15m" }]) {
      const error = await readLogs(deps, workerPlan(), {
        services,
        failed: true,
        ...options,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
      expect((error as OpsCrewError).message).toContain("--failed");
    }
    await expect(
      readLogs(deps, workerPlan(), { services, failed: true, service: "payments" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(files.commands).toEqual([]);
  });
});

describe("readLogs --failed on a server the user owns", () => {
  async function ownServer(files: FakeKeptFiles, privilege: "root" | "sudo" | "docker") {
    const deps = await createTestPhaseDeps({ runner: ownRunner(), interactive: false });
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: privilege === "root" ? "root" : "alice",
      agent: true,
      reachable: true,
    });
    const host = new FakeHostServer(
      freshFacts(privilege === "root" ? {} : { user: "alice", privilege }),
    );
    return { deps, services: { own: { host, remote: () => files.remote(OWN_IPV4) } } };
  }

  it("refuses plainly when the login cannot enter the kept folder (Docker access only)", async () => {
    const files = new FakeKeptFiles({ [`${KEPT}/about`]: about("health") });
    files.enterable = false;
    const { deps, services } = await ownServer(files, "docker");

    const error = await readLogs(deps, ownPlan({ deployed: true }), {
      services,
      hostKey: ED25519_FINGERPRINT,
      failed: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("COMMAND_FAILED");
    expect((error as OpsCrewError).message).toBe(
      "The login cannot read the deploy user's folder on your server, where the failed deploy's lines are kept.",
    );
    expect((error as OpsCrewError).hint).toContain("passwordless sudo");
    expect(files.commands).toEqual(["true", READ_ABOUT]);
  });

  it("reads the kept files as root through sudo for a sudo login", async () => {
    const files = new FakeKeptFiles({
      [`${KEPT}/about`]: about("health"),
      [`${KEPT}/app.log`]: APP_LOG,
    });
    const { deps, services } = await ownServer(files, "sudo");

    const read = await readLogs(deps, ownPlan({ deployed: true }), {
      services,
      hostKey: ED25519_FINGERPRINT,
      failed: true,
    });

    expect(await collect(read)).toHaveLength(2);
    expect(files.commands).toEqual([
      "true",
      `sudo -n sh -c '${READ_ABOUT}'`,
      `sudo -n sh -c '${READ_APP}'`,
    ]);
    expect(deps.audit.entries.map((entry) => [entry.action, entry.target])).toEqual([
      ["inspect host (read-only)", "own server"],
      ["read the failed deploy's lines (read-only)", "own server"],
    ]);
    expect(JSON.stringify([read.first, deps.audit.entries])).not.toContain(OWN_IPV4);
  });

  it("reads them as the root login itself, without sudo", async () => {
    const files = new FakeKeptFiles({ [`${KEPT}/about`]: about("health") });
    const { deps, services } = await ownServer(files, "root");
    const read = await readLogs(deps, ownPlan({ deployed: true }), {
      services,
      hostKey: ED25519_FINGERPRINT,
      failed: true,
    });
    expect(read.first).toContain("It kept no lines of the web process (app).");
    expect(files.commands.slice(1)).toEqual([READ_ABOUT, READ_APP]);
  });
});

describe("readLogs --failed on this computer", () => {
  it("reads the kept files in the app's folder here", async () => {
    const deps = await createTestPhaseDeps();
    const plan = localPlan();
    const dir = join(appFolder(deps.paths, plan), FAILED_DEPLOY_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "about"), about("health"));
    await writeFile(join(dir, "app.log"), APP_LOG);

    const read = await readLogs(deps, plan, { failed: true });

    expect(read.first).toContain(`Lines of the copy of ${SHORT} that failed its health check`);
    expect((await collect(read)).map((line) => line.text)).toEqual([
      "listening on 3000",
      "Error: cannot connect to the database",
    ]);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({ kind: "remote-exec", target: "this computer" }),
    ]);
  });

  it("says so when the app's folder keeps none", async () => {
    const deps = await createTestPhaseDeps();
    const read = await readLogs(deps, localPlan(), { failed: true });
    expect(read.first).toContain("No failed deploy's lines are kept on this computer");
    expect(await collect(read)).toEqual([]);
  });
});

describe("readLogs --failed where nothing is kept", () => {
  it.each([
    [
      "Portainer",
      portainerPlan({ deployed: true }),
      "Your Portainer keeps no failed deploy's lines",
    ],
    ["GitHub Pages", pagesTestPlan(), "GitHub Pages keeps no failed deploy's lines"],
    ["Cloudflare", sitePlan(), "Cloudflare keeps no failed deploy's lines"],
  ])("on %s, says the target keeps none, without connecting", async (_name, plan, text) => {
    const deps = await createTestPhaseDeps();
    const read = await readLogs(deps, plan, { failed: true });
    expect(read.first).toContain(text);
    expect(await collect(read)).toEqual([]);
    expect(deps.audit.entries).toEqual([]);
  });
});
