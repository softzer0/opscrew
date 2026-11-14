import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, makeRequirements, ScriptedRunner } from "../testing";
import { type InitCheck, runInitChecks } from "./index";

const TOKEN = fakeSecret("generic-password", "init-hosting-token");
const GITHUB = fakeSecret("github-token", "init-hosting");

const PANEL = {
  OPSCREW_HOSTING_URL: "https://panel.example.com:2083",
  OPSCREW_HOSTING_USER: "acct",
  OPSCREW_HOSTING_TOKEN: TOKEN,
};

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function repoRunner(): ScriptedRunner {
  return new ScriptedRunner((command, args) => {
    if (args.includes("rev-parse")) return ok("true\n");
    if (args.includes("remote")) return ok("git@github.com:acme/notes.git\n");
    if (command.endsWith("tofu")) return ok(JSON.stringify({ terraform_version: "1.10.6" }));
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command}` };
  });
}

/** Records the hosts called; GitHub answers like a working token, nothing else answers. */
function fakeNet(): { fetch: FetchLike; hosts: string[] } {
  const hosts: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    if (url.hostname === "api.github.com") {
      return new Response(
        JSON.stringify({ default_branch: "main", private: true, permissions: { push: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, hosts };
}

/** A plan for notes.example.com on a hosting account reached through `panel`. */
function hostingPlan(panel: "cpanel" | "plesk" | "sftp"): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-11-12T12:00:00.000Z",
    updatedAt: "2026-11-12T12:00:00.000Z",
    app: { name: "notes", port: 3000, env: [] },
    target: {
      provider: "hosting",
      panel,
      app: "static",
      webRoot: ".",
      site: { tool: "none", outputDir: "site" },
      cron: [],
    },
    processes: { workers: [], cron: [] },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-12T00:00:00.000Z",
    },
    codeChanges: [],
    dns: { provider: "none", domain: "notes.example.com", proxied: false, www: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: { wafCustomRules: false },
  });
}

interface Setup {
  env?: Record<string, string>;
  /** The plan's panel; without one, only the interview's answers (a hosting account). */
  plan?: "cpanel" | "plesk" | "sftp";
  /** Neither a plan nor answers: the target is not chosen yet. */
  unchosen?: boolean;
  tools?: string[];
  /** Looking up the optional scanners fails with this message. */
  scannerError?: string;
}

async function checks(o: Setup = {}): Promise<{ checks: InitCheck[]; hosts: string[] }> {
  const { fetch, hosts } = fakeNet();
  const deps = await createTestPhaseDeps({
    env: { GITHUB_TOKEN: GITHUB, ...(o.env ?? PANEL) },
    runner: repoRunner(),
    fetch,
  });
  await writeFile(join(deps.paths.root, ".gitignore"), ".opscrew/\n.terraform/\n");
  if (o.unchosen !== true) {
    await writeArtifact(
      "requirements",
      deps.paths.files.requirements,
      makeRequirements({
        provider: "hosting",
        region: undefined,
        domain: "notes.example.com",
        dnsProvider: "other",
      }),
    );
  }
  if (o.plan !== undefined) {
    await writeArtifact("plan", deps.paths.files.plan, hostingPlan(o.plan));
  }
  const tools = o.tools ?? ["git", "tofu", "ssh", "ssh-keyscan", "sftp"];
  const result = await runInitChecks(deps, {
    services: {
      which: (name) => {
        if (o.scannerError !== undefined && name === "gitleaks") throw new Error(o.scannerError);
        return tools.includes(name) ? `/usr/bin/${name}` : undefined;
      },
      nodeVersion: "22.12.0",
    },
  });
  return { checks: result, hosts };
}

function find(list: InitCheck[], id: InitCheck["id"]): InitCheck {
  const found = list.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe("opscrew init for an app on a hosting account", () => {
  it("checks the panel's variables, and calls no cloud provider or panel", async () => {
    for (const plan of [undefined, "cpanel"] as const) {
      const { checks: list, hosts } = await checks(plan === undefined ? {} : { plan });
      const provider = find(list, "provider");
      expect(provider.title).toBe("Your hosting account");
      expect(provider.status).toBe("pass");
      expect(provider.message).toContain("OPSCREW_HOSTING_TOKEN are set");
      expect(hosts).toEqual(["api.github.com"]);
      expect(JSON.stringify(list)).not.toContain(TOKEN);
    }
  });

  it("needs no SSH tools for cPanel, whose API writes the account's files", async () => {
    const { checks: list } = await checks({ plan: "cpanel", tools: ["git", "tofu"] });
    expect(find(list, "ssh")).toMatchObject({
      status: "skip",
      message:
        "Not needed: OpsCrew changes your hosting account through its panel's API and never connects over SSH.",
    });
  });

  it("needs sftp and ssh-keyscan for Plesk, whose files go over SFTP", async () => {
    const { checks: list } = await checks({ plan: "plesk" });
    expect(find(list, "ssh")).toMatchObject({
      status: "pass",
      message: "sftp and ssh-keyscan found.",
    });
    const { checks: noTools } = await checks({ plan: "plesk", tools: ["git", "tofu", "sftp"] });
    expect(find(noTools, "ssh")).toMatchObject({
      status: "fail",
      message:
        "ssh-keyscan is not installed, and OpsCrew writes a Plesk account's files over SFTP, which needs it.",
    });
    expect(find(noTools, "ssh").fix).toContain("OpenSSH Client");
  });

  it("before design, only warns of missing SSH tools, as only a Plesk account needs them", async () => {
    const { checks: found } = await checks();
    expect(find(found, "ssh")).toMatchObject({ status: "pass" });
    const { checks: list } = await checks({ tools: ["git", "tofu"] });
    expect(find(list, "ssh")).toMatchObject({
      status: "warn",
      message:
        "sftp and ssh-keyscan are not installed. A Plesk account needs them, as OpsCrew writes its files over SFTP; cPanel and DirectAdmin don't.",
    });
  });

  it("fails naming each missing panel variable, and an address that isn't https://", async () => {
    const { checks: missing } = await checks({
      plan: "cpanel",
      env: { OPSCREW_HOSTING_URL: PANEL.OPSCREW_HOSTING_URL },
    });
    const provider = find(missing, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain(
      "The plan deploys to a hosting account with a panel, but OPSCREW_HOSTING_USER and OPSCREW_HOSTING_TOKEN aren't set.",
    );
    expect(provider.fix).toContain("Manage API Tokens");

    const { checks: plain } = await checks({
      plan: "cpanel",
      env: { ...PANEL, OPSCREW_HOSTING_URL: "http://panel.example.com:2083" },
    });
    expect(find(plain, "provider")).toMatchObject({
      status: "fail",
      message: "OPSCREW_HOSTING_URL isn't a panel's address.",
    });
  });

  it("fails before design when neither the panel's nor the SFTP variables are set", async () => {
    const { checks: list } = await checks({ env: {} });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toBe(
      "Your interview answers deploy to a hosting account, but its variables aren't set.",
    );
    expect(provider.fix).toContain("OPSCREW_SFTP_HOST");
  });

  it("checks an SFTP host's variables, its key file, and the sftp and ssh-keyscan binaries", async () => {
    const deps = await createTestPhaseDeps({});
    const key = join(deps.paths.root, "id_ed25519");
    await writeFile(key, "not a real key\n");
    const env = {
      OPSCREW_SFTP_HOST: "sftp.example.com",
      OPSCREW_SFTP_USER: "acct",
      OPSCREW_SFTP_KEY: key,
    };
    const { checks: list } = await checks({ plan: "sftp", env });
    expect(find(list, "provider")).toMatchObject({ status: "pass" });
    expect(find(list, "ssh")).toMatchObject({
      title: "sftp and ssh-keyscan",
      status: "pass",
      message: "sftp and ssh-keyscan found.",
    });

    const { checks: noTools } = await checks({ plan: "sftp", env, tools: ["git", "tofu"] });
    const tools = find(noTools, "ssh");
    expect(tools.status).toBe("fail");
    expect(tools.message).toContain("sftp and ssh-keyscan are not installed");
    expect(tools.fix).toContain("OpenSSH Client");

    const { checks: noKey } = await checks({
      plan: "sftp",
      env: { ...env, OPSCREW_SFTP_KEY: join(deps.paths.root, "missing") },
    });
    expect(find(noKey, "provider").status).toBe("fail");
    expect(find(noKey, "provider").message).toContain("is not on this computer");

    const { checks: noUser } = await checks({
      plan: "sftp",
      env: { OPSCREW_SFTP_HOST: env.OPSCREW_SFTP_HOST, OPSCREW_SFTP_KEY: key },
    });
    expect(find(noUser, "provider").message).toContain("OPSCREW_SFTP_USER isn't set");
  });

  it("masks the panel's token in every check, even one whose error carries it", async () => {
    const { checks: list } = await checks({
      plan: "cpanel",
      scannerError: `lookup failed near ${TOKEN}`,
    });
    expect(find(list, "scanners").message).toContain("[REDACTED:OPSCREW_HOSTING_TOKEN]");
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  it("before a target is chosen, takes the hosting account whose variables are set", async () => {
    const { checks: list } = await checks({ unchosen: true });
    expect(find(list, "provider")).toMatchObject({ title: "Your hosting account", status: "pass" });
  });
});
