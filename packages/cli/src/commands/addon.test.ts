import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { recordServerAddress } from "@opscrew/agents";
import { FakeAddonServer, SERVER_IPV4, testPlan } from "@opscrew/agents/testing";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import {
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything (typing any phrase asked for) and records the requests: the user. */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return {
      approved: true,
      approver: "test",
      decidedAt: "2026-10-11T12:00:00.000Z",
      ...(request.confirmPhrase === undefined ? {} : { confirmation: request.confirmPhrase }),
    };
  }
}

/** `ssh` runs until its signal aborts, as the tunnel does; every call is recorded. */
class TunnelRunner implements CommandRunner {
  readonly calls: string[][] = [];
  async run(command: string, args: readonly string[], options?: CommandOptions) {
    this.calls.push([command, ...args]);
    const signal = options?.signal;
    await new Promise<void>((resolve) => {
      if (signal?.aborted === true) resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { exitCode: 130, stdout: "", stderr: "" } satisfies CommandResult;
  }
}

const GRAFANA = {
  metricsUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/push",
  metricsUser: "1234567",
  logsUrl: "https://logs-prod-012.grafana.net/loki/api/v1/push",
  logsUser: "7654321",
};

/** A deployed Hetzner app `shop` whose server is a {@link FakeAddonServer}. */
async function setup() {
  project = await tempProject();
  const paths = resolveProjectPaths(project.root, { env: project.env });
  await writeArtifact("plan", paths.files.plan, testPlan({ deployed: true, userSecret: false }));
  await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  const host = new FakeAddonServer();
  const p = project;
  const context = (
    options: {
      approvals?: ApprovalHandler;
      prompts?: ScriptedPrompts;
      runner?: CommandRunner;
    } = {},
  ) => {
    const ctx = projectContext(p, {
      interactive: options.approvals !== undefined,
      services: {
        ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
        ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
        ...(options.runner === undefined ? {} : { runner: options.runner }),
      },
    });
    return withServices(ctx, { addon: { deployRemote: host.shell, applyHost: host.apply } });
  };
  return { context, host, paths, plan: () => readArtifact("plan", paths.files.plan) };
}

function printedHash(output: string): string {
  const hash = /Plan hash \(SHA-256\):\s+([0-9a-f]{64})\s/.exec(output)?.[1];
  if (hash === undefined) throw new Error(`No plan hash in:\n${output}`);
  return hash;
}

describe("opscrew addon", () => {
  it("enable --plan-only prints the host plan's hash; --approve <hash> applies exactly it", async () => {
    const s = await setup();
    const first = s.context();
    expect(
      await run(first, "addon", "enable", "beszel", "--plan-only", "--yes"),
      first.errors,
    ).toBe(0);
    expect(s.host.applies).toEqual([]);
    expect(first.output).toContain("Memory limits of Beszel's containers");
    const hash = printedHash(first.output);
    expect(first.output).toContain(`    opscrew addon enable beszel --approve ${hash} --yes\n`);

    const second = s.context();
    const code = await run(second, "addon", "enable", "beszel", "--approve", hash, "--yes");
    expect(code, second.errors).toBe(0);
    expect(s.host.applies).toHaveLength(1);
    expect(s.host.applies[0]?.options.approvedHash).toBe(hash);
    expect((await s.plan()).observability?.beszel?.enabled).toBe(true);
    expect(second.output).toContain("opscrew addon open beszel");
    expect(second.output).toContain("`opscrew addon status`");
  });

  it("never applies a host plan through --yes alone", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "addon", "enable", "beszel", "--yes")).toBe(1);
    expect(s.host.applies).toEqual([]);
    expect(ctx.errors).toContain("--approve");
  });

  it("repeats the add-on's options in the --approve command, quoting what needs it", async () => {
    const s = await setup();
    const ctx = s.context();
    const hubKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`;
    const env = ctx.env as Record<string, string>;
    env.OPSCREW_BESZEL_TOKEN = randomBytes(24).toString("hex");
    const args = [
      "addon",
      "enable",
      "beszel",
      "--mode",
      "agent",
      "--hub-url",
      "https://beszel.example.com",
      "--hub-key",
      hubKey,
    ];
    expect(await run(ctx, ...args, "--plan-only"), ctx.errors).toBe(0);
    const hash = printedHash(ctx.output);
    expect(ctx.output).toContain(
      `    opscrew addon enable beszel --mode agent --hub-url https://beszel.example.com --hub-key '${hubKey}' --approve ${hash}\n`,
    );
    expect(ctx.output).not.toContain(env.OPSCREW_BESZEL_TOKEN);
  });

  it("disable: deleting Beszel's history needs --confirm <app> with the hash; --keep-data does not", async () => {
    const s = await setup();
    const on = s.context({ approvals: new ApproveAll() });
    expect(await run(on, "addon", "enable", "beszel"), on.errors).toBe(0);

    const planned = s.context();
    expect(await run(planned, "addon", "disable", "beszel", "--plan-only")).toBe(0);
    const hash = printedHash(planned.output);
    expect(planned.output).toContain(`    opscrew addon disable beszel --approve ${hash}\n`);
    expect(planned.output).toContain("add --confirm shop to the command in a script");

    const unnamed = s.context();
    expect(await run(unnamed, "addon", "disable", "beszel", "--approve", hash)).toBe(1);
    expect(unnamed.errors).toContain("--confirm");
    expect(s.host.applies).toHaveLength(1);

    const wrong = s.context();
    expect(
      await run(wrong, "addon", "disable", "beszel", "--approve", hash, "--confirm", "x"),
    ).toBe(1);
    expect(wrong.errors).toContain("--confirm x does not match the app's name");

    const named = s.context();
    const code = await run(
      named,
      "addon",
      "disable",
      "beszel",
      "--approve",
      hash,
      "--confirm",
      "shop",
    );
    expect(code, named.errors).toBe(0);
    expect(s.host.applies.at(-1)?.plan.deleteData).toBe(true);
    expect((await s.plan()).observability?.beszel).toBeUndefined();
  });

  it("disable --keep-data keeps Beszel's history and needs no name", async () => {
    const s = await setup();
    const on = s.context({ approvals: new ApproveAll() });
    expect(await run(on, "addon", "enable", "beszel"), on.errors).toBe(0);
    const planned = s.context();
    expect(await run(planned, "addon", "disable", "beszel", "--keep-data", "--plan-only")).toBe(0);
    const hash = printedHash(planned.output);
    expect(planned.output).toContain(
      `    opscrew addon disable beszel --keep-data --approve ${hash}\n`,
    );
    expect(planned.output).not.toContain("--confirm");
    const off = s.context();
    const code = await run(off, "addon", "disable", "beszel", "--keep-data", "--approve", hash);
    expect(code, off.errors).toBe(0);
    expect(s.host.applies.at(-1)?.plan.deleteData).not.toBe(true);
  });

  it("Grafana Cloud in a terminal: asks for the stack's values, and for the token with hidden input", async () => {
    const s = await setup();
    const token = `glc_${randomBytes(32).toString("hex")}`;
    const prompts = new ScriptedPrompts([
      GRAFANA.metricsUrl,
      GRAFANA.metricsUser,
      GRAFANA.logsUrl,
      GRAFANA.logsUser,
      token,
    ]);
    const approvals = new ApproveAll();
    const ctx = s.context({ approvals, prompts });
    expect(await run(ctx, "addon", "enable", "grafana-cloud"), ctx.errors).toBe(0);
    expect(prompts.calls.map((call) => call.kind)).toEqual([
      "text",
      "text",
      "text",
      "text",
      "password",
    ]);
    expect(prompts.calls.at(-1)?.message).toContain("metrics:write and logs:write only");
    expect(s.host.applies[0]?.options.secrets?.grafanaCloudToken).toBe(token);
    expect(approvals.requests.map((request) => request.kind)).toContain("host-apply");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(token);
    expect(ctx.output).toContain("free tier");
  });

  it("takes Grafana Cloud's flags, and refuses Beszel's options for it", async () => {
    const s = await setup();
    const flags = [
      "--metrics-url",
      GRAFANA.metricsUrl,
      "--metrics-user",
      GRAFANA.metricsUser,
      "--logs-url",
      GRAFANA.logsUrl,
      "--logs-user",
      GRAFANA.logsUser,
      "--log-sampling",
      "50",
    ];
    const ctx = s.context();
    (ctx.env as Record<string, string>).OPSCREW_GRAFANA_CLOUD_TOKEN =
      `glc_${randomBytes(32).toString("hex")}`;
    expect(
      await run(ctx, "addon", "enable", "grafana-cloud", ...flags, "--plan-only"),
      ctx.errors,
    ).toBe(0);
    const hash = printedHash(ctx.output);
    expect(ctx.output).toContain(
      `    opscrew addon enable grafana-cloud ${flags.join(" ")} --approve ${hash}\n`,
    );
    const beszel = s.context();
    expect(await run(beszel, "addon", "enable", "grafana-cloud", "--mode", "hub")).toBe(2);
    expect(beszel.errors).toContain("are Beszel's options");
  });

  it("status shows each add-on's state, and --json the data", async () => {
    const s = await setup();
    const on = s.context({ approvals: new ApproveAll() });
    expect(await run(on, "addon", "enable", "beszel"), on.errors).toBe(0);
    const ctx = s.context();
    expect(await run(ctx, "addon", "status"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("opscrew-beszel-agent-1: running, memory 6.5MiB / 64MiB");
    expect(ctx.output).toContain("Grafana Cloud is off.");
    const json = s.context();
    expect(await run(json, "addon", "status", "--json"), json.errors).toBe(0);
    expect(JSON.parse(json.output).addons[0]).toMatchObject({ kind: "beszel", enabled: true });
  });

  it("open beszel runs the SSH tunnel until Ctrl-C", async () => {
    const s = await setup();
    const on = s.context({ approvals: new ApproveAll() });
    expect(await run(on, "addon", "enable", "beszel"), on.errors).toBe(0);
    const runner = new TunnelRunner();
    const ctx = s.context({ runner });
    let stop: (() => void) | undefined;
    withServices(ctx, {
      onStop: (fn) => {
        stop = fn;
        return () => {};
      },
    });
    const running = run(ctx, "addon", "open", "beszel");
    while (runner.calls.length === 0) await delay(5);
    expect(runner.calls[0]).toEqual(expect.arrayContaining(["-N", "-L", "8090:127.0.0.1:8090"]));
    expect(ctx.output).toContain("http://localhost:8090");
    stop?.();
    expect(await running, ctx.errors).toBe(0);
  });

  it("refuses an unknown add-on, and shows each command's options", async () => {
    const s = await setup();
    const unknown = s.context();
    expect(await run(unknown, "addon", "enable", "prometheus")).toBe(2);
    expect(unknown.errors).toContain("beszel, grafana-cloud");
    const options: Record<string, string[]> = {
      enable: [
        "--mode <mode>",
        "--hub-url <url>",
        "--hub-key <key>",
        "--access <access>",
        "--hostname <fqdn>",
        "--allow-email <email>",
        "--metrics-url <url>",
        "--metrics-user <id>",
        "--logs-url <url>",
        "--logs-user <id>",
        "--log-sampling <percent>",
        "--plan-only",
        "--approve <hash>",
        "--app <key>",
        "--env <name>",
      ],
      disable: [
        "--keep-data",
        "--confirm <name>",
        "--plan-only",
        "--approve <hash>",
        "--env <name>",
      ],
      status: ["--json", "--app <key>", "--env <name>"],
      open: ["--app <key>", "--env <name>"],
    };
    for (const [command, flags] of Object.entries(options)) {
      const ctx = s.context();
      expect(await run(ctx, "addon", command, "--help")).toBe(0);
      for (const flag of flags) expect(ctx.output, `${command} ${flag}`).toContain(flag);
    }
  });
});
