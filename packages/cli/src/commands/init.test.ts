import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { withDeployServices } from "../ui/deploy-services";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Real git; `tofu version -json` answers 1.13.1; anything else is "not found". */
class InitRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });
  async run(command: string, args: readonly string[], options?: CommandOptions) {
    const name = path.basename(command).replace(/\.exe$/i, "");
    if (name === "git") return this.#node.run(command, args, options);
    if (name === "tofu" && args[0] === "version") {
      return { exitCode: 0, stdout: '{"terraform_version":"1.13.1"}', stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: `${name}: not found` } satisfies CommandResult;
  }
}

const HCLOUD = fakeSecret("hcloud-token");
const GITHUB = fakeSecret("github-token");

async function setup(
  options: { tools?: string[]; gitignore?: string; approvals?: ApprovalHandler } = {},
) {
  project = await tempProject();
  const { root, env } = project;
  await git(env, root, "init", "-q", "-b", "main");
  await git(env, root, "remote", "add", "origin", "https://github.com/acme/shop.git");
  if (options.gitignore !== undefined) {
    await writeFile(path.join(root, ".gitignore"), options.gitignore);
  }
  const tools = new Set(options.tools ?? ["git", "ssh", "ssh-keyscan", "tofu"]);
  env.HCLOUD_TOKEN = HCLOUD;
  env.GITHUB_TOKEN = GITHUB;
  const ctx = projectContext(project, {
    ...(options.approvals === undefined ? {} : { interactive: true }),
    services: {
      runner: new InitRunner(),
      ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
    },
  });
  withDeployServices(ctx, {
    init: {
      which: (name) =>
        tools.has(name) ? (name === "git" ? (GIT as string) : `/usr/bin/${name}`) : undefined,
      nodeVersion: "22.12.0",
    },
  });
  return { ctx, root };
}

describe.skipIf(!GIT)("opscrew init", () => {
  it("prints a passing checklist and the next steps when everything is ready", async () => {
    const { ctx } = await setup({ gitignore: "node_modules/\n.opscrew/\n" });
    expect(await run(ctx, "init", "--offline")).toBe(0);
    expect(ctx.output).toContain("OpsCrew preflight");
    expect(ctx.output).toMatch(/✓ .*OpenTofu 1\.13\.1/);
    expect(ctx.output).toContain("only checked that it is set");
    expect(ctx.output).toContain("`opscrew scan`");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(HCLOUD);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(GITHUB);
  });

  it("exits 1 with install instructions when no engine is installed", async () => {
    const { ctx } = await setup({ tools: ["git", "ssh", "ssh-keyscan"], gitignore: ".opscrew/\n" });
    expect(await run(ctx, "init", "--offline")).toBe(1);
    expect(ctx.output).toMatch(/✗ .*Neither OpenTofu nor Terraform/);
    expect(ctx.output).toContain("https://opentofu.org/docs/intro/install/");
    expect(ctx.output).toContain("fix the items marked ✗");
  });

  it("adds .opscrew/ to .gitignore with --fix and keeps what was there", async () => {
    const { ctx, root } = await setup({ gitignore: "node_modules/\n" });
    expect(await run(ctx, "init", "--offline", "--fix")).toBe(0);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.opscrew/\n",
    );
    expect(ctx.output).toContain("added .opscrew/ to .gitignore");
  });

  it("asks about .gitignore only after printing the checklist", async () => {
    const seen: string[] = [];
    let output = () => "";
    const approvals: ApprovalHandler = {
      async request(request: ApprovalRequest): Promise<ApprovalDecision> {
        seen.push(`${request.kind} after: ${output()}`);
        return { approved: true, approver: "test", decidedAt: "2026-10-12T12:00:00.000Z" };
      },
    };
    const { ctx, root } = await setup({ gitignore: "node_modules/\n", approvals });
    output = () => ctx.output;
    expect(await run(ctx, "init", "--offline")).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^repo-write after: [\s\S]*OpsCrew preflight[\s\S]*! .*\.gitignore/);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.opscrew/\n",
    );
  });

  it("leaves .gitignore alone without --fix in a non-interactive run", async () => {
    const { ctx, root } = await setup({ gitignore: "node_modules/\n" });
    expect(await run(ctx, "init", "--offline")).toBe(0);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(ctx.output).toMatch(/! .*\.gitignore/);
  });
});
