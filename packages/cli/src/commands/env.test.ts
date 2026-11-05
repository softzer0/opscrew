import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeRequirements, nextPostgresFacts, TOKEN, testPlan } from "@opscrew/agents/testing";
import type { CommandRunner, FetchLike } from "@opscrew/contracts";
import { exists } from "@opscrew/core";
import { type Requirements, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { inEnvironment, planFile, withEnvironments } from "../ui/__fixtures__/environments";
import {
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import type { UiChoice, UiPrompts } from "../ui/prompts";

/** Prompts that take every question's default, recording what was asked. */
class DefaultPrompts implements UiPrompts {
  readonly messages: string[] = [];
  async select(options: { message: string; options: UiChoice[]; initialValue?: string }) {
    this.messages.push(options.message);
    return options.initialValue ?? options.options[0]?.value ?? "";
  }
  async multiselect(options: { message: string; initialValues?: string[] }) {
    this.messages.push(options.message);
    return options.initialValues ?? [];
  }
  async text(options: { message: string; initialValue?: string }) {
    this.messages.push(options.message);
    return options.initialValue ?? "";
  }
  async confirm(options: { message: string; initialValue?: boolean }) {
    this.messages.push(options.message);
    return options.initialValue ?? false;
  }
  async password(options: { message: string }): Promise<string> {
    throw new Error(`No secret is asked here: ${options.message}`);
  }
  isCancel(_value: unknown): _value is symbol {
    return false;
  }
}

const PREVIEW_DOMAIN_QUESTION = "Which domain should previews use?";

/** The defaults, and example.net for the preview domain, which has none. */
class PreviewDomainPrompts extends DefaultPrompts {
  override async text(options: { message: string; initialValue?: string }) {
    const answer = await super.text(options);
    return options.message.startsWith(PREVIEW_DOMAIN_QUESTION) ? "example.net" : answer;
  }
}

/**
 * git whose GitHub `origin` has `branches`: `ls-remote` lists a ref when it is one of them, and
 * every other command succeeds with no output.
 */
function remoteWith(branches: readonly string[]): CommandRunner {
  return {
    async run(_command, args) {
      if (args.includes("get-url")) {
        return { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" };
      }
      const ref = args.at(-1) ?? "";
      const listed = args.includes("ls-remote") && branches.some((b) => ref === `refs/heads/${b}`);
      return { exitCode: 0, stdout: listed ? `${"a".repeat(40)}\t${ref}\n` : "", stderr: "" };
    },
  };
}

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

describe("opscrew env list", () => {
  it("shows each environment: where it runs, how it gets new versions, its runner, deployed or not", async () => {
    const prod = testPlan();
    project = await withEnvironments({
      staging: inEnvironment(prod, "staging", {
        deploySource: { from: "promote", source: "prod" },
      }),
    });
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "list"), ctx.errors).toBe(0);
    const lines = ctx.output.trim().split("\n");
    expect(lines[0]).toMatch(/^Environment\s+Runs on\s+New versions\s+Deploy job\s+Deployed$/);
    expect(lines[1]).toMatch(/^prod\s+hetzner\s+each push to main\s+GitHub's machines\s+yes$/);
    expect(lines[2]).toMatch(/^staging\s+hetzner\s+promoted from prod\s+GitHub's machines\s+no$/);
  });
});

describe("opscrew env set", () => {
  it("changes the deploy source in the environment's plan and names its provision", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "set", "staging", "--from", "prod"), ctx.errors).toBe(0);
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.environment?.deploySource).toEqual({ from: "promote", source: "prod" });
    expect(ctx.output).toContain("is deployed only by `opscrew promote --to staging`");
    expect(ctx.output).toContain("run `opscrew provision --env staging`");
  });

  it("checks the runner before the source, so a refused runner saves nothing", async () => {
    project = await withEnvironments({
      staging: inEnvironment(testPlan(), "staging", {
        deploySource: { from: "promote", source: "prod" },
      }),
    });
    const before = await readFile(planFile(project.root, "staging"), "utf8");
    const ctx = projectContext(project);
    const args = ["--from", "main", "--runner", "server", "--build", "runner"];
    expect(await run(ctx, "env", "set", "staging", ...args)).not.toBe(0);
    expect(ctx.errors).toContain("The server's runner never builds");
    expect(await readFile(planFile(project.root, "staging"), "utf8")).toBe(before);
  });

  it("refuses the environment itself as its source, and changes nothing", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const before = await readFile(planFile(project.root, "staging"), "utf8");
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "set", "staging", "--from", "staging")).not.toBe(0);
    expect(ctx.errors).toContain("cannot be promoted from itself");
    expect(await readFile(planFile(project.root, "staging"), "utf8")).toBe(before);
  });

  it("sets the branch the environment follows with --branch", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const ctx = projectContext(project, { services: { runner: remoteWith(["main", "staging"]) } });
    expect(await run(ctx, "env", "set", "staging", "--branch", "staging"), ctx.errors).toBe(0);
    expect((await readArtifact("plan", planFile(project.root, "staging"))).cicd.branch).toBe(
      "staging",
    );
    expect(ctx.output).toContain(
      "The staging environment is built and deployed on each push to staging.",
    );
    expect(ctx.output).toContain("run `opscrew provision --env staging`");
  });

  it("refuses with --branch a branch the repository does not have, or another environment follows, and saves nothing of the source", async () => {
    const dev = inEnvironment(testPlan(), "dev");
    project = await withEnvironments({
      dev: { ...dev, cicd: { ...dev.cicd, branch: "develop" } },
      staging: inEnvironment(testPlan(), "staging", {
        deploySource: { from: "promote", source: "prod" },
      }),
    });
    const before = await readFile(planFile(project.root, "staging"), "utf8");
    const unknown = projectContext(project, { services: { runner: remoteWith(["main"]) } });
    expect(
      await run(unknown, "env", "set", "staging", "--from", "main", "--branch", "staging"),
    ).not.toBe(0);
    expect(unknown.errors).toContain(
      "The repository on GitHub has no branch staging, so no push to it could deploy the staging environment.",
    );
    const remote = remoteWith(["main", "develop"]);
    const taken = projectContext(project, { services: { runner: remote } });
    expect(await run(taken, "env", "set", "staging", "--branch", "develop")).not.toBe(0);
    expect(taken.errors).toContain(
      "The dev environment already follows develop, so the staging environment cannot follow it too",
    );
    expect(await readFile(planFile(project.root, "staging"), "utf8")).toBe(before);
  });

  it("says a promoted environment follows its --branch once it is built from main again", async () => {
    project = await withEnvironments({
      staging: inEnvironment(testPlan(), "staging", {
        deploySource: { from: "promote", source: "prod" },
      }),
    });
    const ctx = projectContext(project, { services: { runner: remoteWith(["main", "staging"]) } });
    expect(await run(ctx, "env", "set", "staging", "--branch", "staging"), ctx.errors).toBe(0);
    expect(ctx.output).toContain(
      "The staging environment follows staging once it is built from main again (`opscrew env set staging --from main`); until then only `opscrew promote --to staging` deploys it.",
    );
    const both = projectContext(project, { services: { runner: remoteWith(["main", "staging"]) } });
    expect(await run(both, "env", "set", "staging", "--from", "main", "--branch", "staging")).toBe(
      0,
    );
    expect(both.output).toContain(
      "The staging environment is built and deployed on each push to staging.",
    );
  });
});

describe("opscrew env remove", () => {
  it("in a script, removes an environment that is not deployed only with --confirm <name>", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const bare = projectContext(project);
    expect(await run(bare, "env", "remove", "staging")).not.toBe(0);
    expect(bare.errors).toContain("`opscrew env remove staging --confirm staging`");
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
    const wrong = projectContext(project);
    expect(await run(wrong, "env", "remove", "staging", "--confirm", "prod")).not.toBe(0);
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "remove", "staging", "--confirm", "staging"), ctx.errors).toBe(0);
    expect(await exists(planFile(project.root, "staging"))).toBe(false);
    expect(ctx.output).toContain("Removed the staging environment's files");
  });

  it("in a terminal, removes it only once its name is typed back", async () => {
    project = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    const typo = projectContext(project, {
      interactive: true,
      services: { prompts: new ScriptedPrompts(["stagin"]) },
    });
    expect(await run(typo, "env", "remove", "staging")).not.toBe(0);
    expect(typo.output).toContain("its deploy key, state passphrase and generated secrets");
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
    const ctx = projectContext(project, {
      interactive: true,
      services: { prompts: new ScriptedPrompts(["staging"]) },
    });
    expect(await run(ctx, "env", "remove", "staging"), ctx.errors).toBe(0);
    expect(await exists(planFile(project.root, "staging"))).toBe(false);
  });

  it("refuses while it is deployed, with destroy --env first", async () => {
    project = await withEnvironments({
      staging: inEnvironment(testPlan({ deployed: true }), "staging"),
    });
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "remove", "staging", "--confirm", "staging")).not.toBe(0);
    expect(ctx.errors).toContain("`opscrew destroy --env staging`");
    expect(await exists(planFile(project.root, "staging"))).toBe(true);
  });
});

describe("opscrew env add", () => {
  /** A designed prod app: its facts, its answers (`requirements`) and its plan. */
  async function prodApp(requirements: Requirements = makeRequirements()): Promise<TempProject> {
    const created = await tempProject();
    await writeArtifact("architecture", path.join(created.root, "opscrew", "architecture.json"), {
      schemaVersion: 1,
      generatedAt: "2026-10-11T10:00:00.000Z",
      generator: { tool: "opscrew", version: "0.0.0-test" },
      facts: nextPostgresFacts({ name: "shop" }),
      summary: "A shop.",
      risks: [],
      aiEnriched: false,
    });
    await writeArtifact(
      "requirements",
      path.join(created.root, "opscrew", "requirements.yaml"),
      requirements,
    );
    const ctx = projectContext(created);
    expect(await run(ctx, "design"), ctx.errors).toBe(0);
    return created;
  }

  it("in a script, takes its flags and the defaults, designs it and names its provision", async () => {
    project = await prodApp();
    const ctx = projectContext(project);
    expect(await run(ctx, "env", "add", "staging", "--from", "prod"), ctx.errors).toBe(0);
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.app.name).toBe("shop-staging");
    expect(plan.environment).toMatchObject({
      name: "staging",
      deploySource: { from: "promote", source: "prod" },
      runner: "github",
    });
    expect(ctx.output).toContain("opscrew provision --env staging");
  });

  it("takes its hostname from --hostname", async () => {
    project = await prodApp();
    const ctx = projectContext(project);
    const args = ["staging", "--from", "prod", "--hostname", "staging.example.org"];
    expect(await run(ctx, "env", "add", ...args), ctx.errors).toBe(0);
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.dns.domain).toBe("staging.example.org");
  });

  it("takes the runner machine and the build from its flags", async () => {
    project = await prodApp();
    const unknown = projectContext(project);
    const machine = ["--runner", "host", "--runner-host", "home"];
    expect(await run(unknown, "env", "add", "staging", ...machine)).not.toBe(0);
    expect(unknown.errors).toContain("This computer has no runner machine named home");
    const github = projectContext(project);
    expect(await run(github, "env", "add", "staging", "--build", "runner")).not.toBe(0);
    expect(github.errors).toContain("its deploy job runs on GitHub's machines");
    expect(await exists(planFile(project.root, "staging"))).toBe(false);
  });

  it("in a terminal, asks only what its flags leave open", async () => {
    project = await prodApp();
    const prompts = new DefaultPrompts();
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    expect(await run(ctx, "env", "add", "staging", "--runner", "server"), ctx.errors).toBe(0);
    const asked = prompts.messages.join("\n");
    expect(asked).toContain("Where should the staging environment run?");
    expect(asked).toContain("How should the staging environment get new versions?");
    expect(asked).not.toContain("deploy job run?");
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.environment?.runner).toBe("server");
  });

  it("in a terminal, proposes the setup first when the repository has a branch named like it, promotion preselected", async () => {
    project = await prodApp();
    const prompts = new DefaultPrompts();
    const ctx = projectContext(project, {
      interactive: true,
      services: { prompts, runner: remoteWith(["trunk", "develop"]) },
    });
    expect(await run(ctx, "env", "add", "dev", "--target", "hetzner"), ctx.errors).toBe(0);
    expect(prompts.messages[0]).toBe(
      "Your repository has branches named like environments (trunk and develop). How should your environments get new versions?",
    );
    // Promotion first: dev follows the trunk prod follows, and nothing else changed.
    const plan = await readArtifact("plan", planFile(project.root, "dev"));
    expect(plan.environment?.deploySource).toEqual({ from: "main" });
    expect(plan.cicd.branch).toBe("trunk");
  });

  it("in a terminal, lets --branch decide instead of the setup", async () => {
    project = await prodApp();
    const prompts = new DefaultPrompts();
    const ctx = projectContext(project, {
      interactive: true,
      services: { prompts, runner: remoteWith(["trunk", "develop"]) },
    });
    const args = ["env", "add", "dev", "--target", "hetzner", "--branch", "develop"];
    expect(await run(ctx, ...args), ctx.errors).toBe(0);
    expect(prompts.messages.join("\n")).not.toContain("named like environments");
    expect((await readArtifact("plan", planFile(project.root, "dev"))).cicd.branch).toBe("develop");
  });

  it("in a script, takes --branch, and without it guesses nothing but names the branches", async () => {
    project = await prodApp();
    const runner = remoteWith(["trunk", "develop", "staging"]);
    const flagged = projectContext(project, { services: { runner } });
    const args = ["env", "add", "staging", "--branch", "staging"];
    expect(await run(flagged, ...args), flagged.errors).toBe(0);
    expect((await readArtifact("plan", planFile(project.root, "staging"))).cicd.branch).toBe(
      "staging",
    );
    const bare = projectContext(project, { services: { runner } });
    expect(await run(bare, "env", "add", "dev", "--target", "hetzner"), bare.errors).toBe(0);
    expect((await readArtifact("plan", planFile(project.root, "dev"))).cicd.branch).toBe("trunk");
    expect(`${bare.output}${bare.errors}`).toContain(
      "In a script OpsCrew guesses nothing, so the flags decide: the dev environment is built and deployed on each push to trunk. To have it follow develop, add --branch develop.",
    );
  });

  it("refuses --branch with a branch the repository does not have, and writes nothing", async () => {
    project = await prodApp();
    const ctx = projectContext(project, { services: { runner: remoteWith(["trunk"]) } });
    expect(await run(ctx, "env", "add", "staging", "--branch", "staging")).not.toBe(0);
    expect(ctx.errors).toContain("The repository on GitHub has no branch staging");
    expect(await exists(planFile(project.root, "staging"))).toBe(false);
  });

  describe("--previews", () => {
    const API = "https://api.cloudflare.com/client/v4";

    /** Cloudflare's API with the app's zone example.com and the preview zone example.net, empty. */
    const ZONES: Record<string, string> = { "example.com": "z1", "example.net": "z2" };
    const cloudflare: FetchLike = async (input) => {
      const url = new URL(String(input));
      const ok = (result: unknown) =>
        new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
          headers: { "content-type": "application/json" },
        });
      if (url.href.startsWith(`${API}/zones?`)) {
        const name = url.searchParams.get("name") ?? "";
        const id = ZONES[name];
        return ok(id === undefined ? [] : [{ id, name, status: "active", name_servers: [] }]);
      }
      if (/^\/client\/v4\/zones\/z[12]\/dns_records$/.test(url.pathname)) return ok([]);
      return new Response("unavailable in tests", { status: 503 });
    };

    /** prod on shop.example.com in Cloudflare, and a context with a Cloudflare token. */
    async function previewsApp(options: { interactive?: boolean; prompts?: UiPrompts } = {}) {
      project = await prodApp(
        makeRequirements({ domain: "shop.example.com", dnsProvider: "cloudflare" }),
      );
      project.env.CLOUDFLARE_API_TOKEN = TOKEN;
      return projectContext(project, {
        interactive: options.interactive ?? false,
        services: {
          fetch: cloudflare,
          ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
        },
      });
    }

    it("in a script, designs the preview environment from its flags, named preview by default", async () => {
      const ctx = await previewsApp();
      const args = ["--previews", "--cap", "2", "--lifetime", "5", "--seed", "npm run db:seed"];
      expect(await run(ctx, "env", "add", ...args)).toBe(2);
      expect(ctx.errors).toContain("Previews need a domain of their own on Cloudflare");
      expect(ctx.errors).toContain("opscrew domain buy");
      expect(await exists(planFile(ctx.cwd, "preview"))).toBe(false);
      expect(await run(ctx, "env", "add", ...args, "--domain", "example.net"), ctx.errors).toBe(0);
      const plan = await readArtifact("plan", planFile(ctx.cwd, "preview"));
      expect(plan.environment?.previews).toEqual({
        cap: 2,
        lifetimeDays: 5,
        domain: "example.net",
        seed: "npm run db:seed",
      });
      expect(ctx.output).toContain("opscrew provision --env preview");
      expect(ctx.output + ctx.errors).not.toContain(TOKEN);
    });

    it("refuses the app's own domain for previews", async () => {
      const ctx = await previewsApp();
      expect(await run(ctx, "env", "add", "--previews", "--domain", "previews.example.com")).toBe(
        2,
      );
      expect(ctx.errors).toContain("is in your app's own domain example.com");
      expect(await exists(planFile(ctx.cwd, "preview"))).toBe(false);
    });

    it("takes --domain, --no-seed and --size, whose memory gives the cap", async () => {
      const ctx = await previewsApp();
      const args = ["--previews", "--domain", "example.net", "--no-seed"];
      expect(await run(ctx, "env", "add", "review", ...args, "--size", "cx43"), ctx.errors).toBe(0);
      const plan = await readArtifact("plan", planFile(ctx.cwd, "review"));
      expect(plan.environment?.previews).toMatchObject({
        domain: "example.net",
        seed: null,
      });
      expect(plan.target).toMatchObject({ serverType: "cx43" });
    });

    it("refuses flags that don't go together before anything is written", async () => {
      const ctx = await previewsApp();
      const refusals: [string[], string][] = [
        [["--previews", "--cap", "2", "--size", "cx33"], "--cap and --size don't go together"],
        [["--previews", "--runner", "server"], "--runner server is not available with --previews"],
        [["--previews", "--build", "runner"], "--build runner is not available with --previews"],
        [["--previews", "--hostname", "x.example.net"], "--hostname doesn't go with --previews"],
        [["staging", "--cap", "2", "--no-seed"], "--cap and --no-seed go only with --previews"],
        [[], "Name the environment to add."],
      ];
      for (const [args, message] of refusals) {
        const before = ctx.errors.length;
        expect(await run(ctx, "env", "add", ...args), args.join(" ")).toBe(2);
        expect(ctx.errors.slice(before)).toContain(message);
      }
      expect(await exists(planFile(ctx.cwd, "preview"))).toBe(false);
      expect(await exists(planFile(ctx.cwd, "staging"))).toBe(false);
    });

    it("in a terminal, asks only what previews need and its flags leave open", async () => {
      const prompts = new PreviewDomainPrompts();
      const ctx = await previewsApp({ interactive: true, prompts });
      const args = ["env", "add", "--previews", "--size", "cx43", "--no-seed"];
      expect(await run(ctx, ...args), ctx.errors).toBe(0);
      const asked = prompts.messages.join("\n");
      expect(asked).toContain("Where should the preview environment's previews run?");
      expect(asked).toContain(PREVIEW_DOMAIN_QUESTION);
      const plan = await readArtifact("plan", planFile(ctx.cwd, "preview"));
      expect(plan.environment?.previews?.domain).toBe("example.net");
      expect(asked).not.toContain("How many previews may run at once?");
      expect(asked).not.toContain("fill a new preview's database");
      expect(asked).not.toContain("get new versions");
    });

    it("in a terminal, refuses a runner of yours before asking anything", async () => {
      const prompts = new DefaultPrompts();
      const ctx = await previewsApp({ interactive: true, prompts });
      expect(await run(ctx, "env", "add", "--previews", "--runner", "server")).toBe(2);
      expect(ctx.errors).toContain("--runner server is not available with --previews");
      expect(prompts.messages).toEqual([]);
    });
  });
});
