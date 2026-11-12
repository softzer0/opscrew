// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
// Feature 027 (T2714): the deploy workflow of an app on an SFTP-only host.
import { spawnSync } from "node:child_process";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NPM_SITE } from "../serverless/__fixtures__/plans";
import { inEnvironment, serverPlan } from "../workflow/__fixtures__/plans";
import { deploySecretNamesFor, renderWorkflow } from "../workflow/index";
import { renderSftpPhpLines, renderSftpWorkflow, SFTP_DEPLOY_SECRETS, sftpUrl } from "./index";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = {
  needs?: string;
  if?: string;
  environment?: string;
  permissions: Record<string, string>;
  steps: Step[];
};
type Workflow = { name: string; on: Record<string, unknown>; jobs: Record<string, Job> };

const PHP = { app: "php", webRoot: "public", php: { version: "8.3", via: "account" } };
const STATIC = { app: "static", webRoot: ".", site: NPM_SITE };

/** The test plan with `target` on an SFTP-only host, as staging's plan. */
function planFor(target: Record<string, unknown>, panel = "sftp"): DeployPlan {
  const base = serverPlan();
  const plan = DeployPlanSchema.parse({
    ...base,
    target: { provider: "hosting", panel, ...target },
    services: [],
    externalServices: [],
    dns: { provider: "none", domain: "shop.example.com", proxied: false, www: false },
    security: { ...base.security, httpAllowedFrom: "any" },
  });
  return inEnvironment(plan, { name: "staging", secrets: "environment" });
}

const doc = (target: Record<string, unknown>) =>
  parse(renderSftpWorkflow(planFor(target)).content) as Workflow;

function deployStep(flow: Workflow): Step {
  const found = flow.jobs.deploy?.steps.find(
    (s) => s.name === "Upload, switch and check the release",
  );
  if (found === undefined) throw new Error("no deploy step");
  return found;
}

describe("renderSftpWorkflow", () => {
  it("renders the environment's deploy workflow for a PHP app and a static site", () => {
    const php = renderSftpWorkflow(planFor(PHP));
    expect(php.path).toBe(".github/workflows/opscrew-deploy-staging.yml");
    expect(php.kind).toBe("workflow");
    expect(php.content).toMatchSnapshot("php");
    expect(renderSftpWorkflow(planFor(STATIC)).content).toMatchSnapshot("static");
    // renderWorkflow sends an SFTP host's plan here.
    expect(renderWorkflow(planFor(PHP), {} as never).content).toBe(php.content);
  });

  it("builds as a panel account does, then deploys unless paused, in the deploy environment", () => {
    const flow = doc(PHP);
    expect(Object.keys(flow.jobs)).toEqual(["paused", "build", "deploy"]);
    expect(Object.keys(flow.on)).toEqual(["push", "workflow_dispatch"]);
    const { build, deploy } = flow.jobs;
    expect(build?.permissions).toEqual({ contents: "read" });
    expect(deploy?.needs).toBe("build");
    expect(deploy?.permissions).toEqual({});
    expect(deploy?.environment).toBe("staging");
    expect(deploy?.if).toBe("${{ !contains(vars.OPSCREW_DEPLOY_PAUSED, '\"shop/staging\"') }}");
    expect(build?.steps.map((s) => s.name ?? s.uses?.split("@")[0])).toContain(
      "Install the app's PHP packages with Composer in PHP 8.3",
    );
  });

  it("gives the SFTP key and the host's reach to the deploy step only", () => {
    const flow = doc(PHP);
    expect(deployStep(flow).env).toEqual({
      SFTP_URL: "${{ secrets.OPSCREW_STAGING_SFTP_URL }}",
      SFTP_KEY: "${{ secrets.OPSCREW_STAGING_SFTP_PRIVATE_KEY }}",
      KNOWN_HOSTS: "${{ secrets.OPSCREW_STAGING_SFTP_KNOWN_HOSTS }}",
    });
    for (const id of ["paused", "build"]) {
      expect(JSON.stringify(flow.jobs[id])).not.toContain("SFTP_");
    }
    expect(deploySecretNamesFor(planFor(PHP))).toEqual(Object.values(SFTP_DEPLOY_SECRETS));
    expect(
      deploySecretNamesFor(planFor({ ...PHP, php: { version: "8.3", via: "multiphp" } }, "cpanel")),
    ).toEqual(["OPSCREW_RELEASE_SIGNING_KEY"]);
  });

  it("uploads to its own folder, switches with ln -s and rename, checks, keeps 3 and writes the status", () => {
    const script = deployStep(doc(PHP)).run ?? "";
    expect(script).toContain(
      'sftp -b - -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=\\"$work/known_hosts\\"" -o IdentitiesOnly=yes -i "$work/key" "$login"',
    );
    expect(script).toContain(
      '@put -r %s %s\\n\' "$(q "$work/release")" "$(q "$FOLDER/releases/$release")"',
    );
    expect(script).toContain("printf -- '-@rm %s\\n@ln -s %s %s\\n@rename %s %s\\n'");
    expect(script).toContain(
      "curl -sS -o /dev/null -D - --max-time 30 \"$scheme://\"'staging-shop.example.com/api/health'",
    );
    // The release is recorded as deployed before the old ones go; one that won't go is a warning.
    const deployed = script.indexOf('write_status "$release" "$release" deployed ""');
    expect(deployed).toBeGreaterThan(script.indexOf("if ! check; then"));
    expect(deployed).toBeLessThan(script.indexOf('[ "$kept" -gt 3 ] || continue'));
    expect(script).toContain(
      "::warning::OpsCrew couldn't remove release $id from the host; remove $FOLDER/releases/$id there yourself.",
    );
    // A re-run of an older run is refused before anything is uploaded.
    expect(
      script.indexOf('if [ -n "$running" ] && ! newer "$release" "$running"; then'),
    ).toBeLessThan(script.indexOf("@put -r"));
    expect(script).toContain('failed "it is older than release $running, which runs" refused');
    expect(script).toContain("Header always set X-OpsCrew-Release");
    expect(script).toContain(
      "RewriteCond %{HTTP_HOST} !^staging-shop\\.example\\.com(:[0-9]+)?$ [NC]",
    );
    // Behind anything but LiteSpeed, a PHP app's switch counts once PHP's realpath cache is past.
    expect(script).toContain('if [ "$try" -ge 25 ]; then return 0; fi');
    expect(deployStep(doc(STATIC)).run).not.toContain('if [ "$try" -ge 25 ]');
    expect(deployStep(doc(STATIC)).run).toContain(
      "RewriteRule ^(vendor|storage|composer\\.json|composer\\.lock)(/|$) - [F]",
    );
  });

  it("is valid bash", () => {
    const parsed = spawnSync("bash", ["-n"], { input: deployStep(doc(PHP)).run, encoding: "utf8" });
    if (parsed.error === undefined) expect(parsed.stderr).toBe("");
  });

  it("reads the login and the folder back from the app's URL, and hides the host in the log", () => {
    const script = deployStep(doc(PHP)).run ?? "";
    const start = script.indexOf("rest=${SFTP_URL#sftp://}");
    const end = script.indexOf("\n", script.indexOf("FOLDER=$("));
    const parse = `${script.slice(start, end)}\nprintf '%s|%s\\n' "$login" "$FOLDER"`;
    const cases = [
      [{ host: "sftp.example.net", port: 22, user: "web" }, "opscrew"],
      [{ host: "2001:db8::1", port: 2222, user: "u@1" }, "/home/u 1/sites/100% done"],
    ] as const;
    expect(sftpUrl(cases[0][0], cases[0][1])).toBe("sftp://web@sftp.example.net:22/opscrew");
    expect(sftpUrl(cases[1][0], cases[1][1])).toBe(
      "sftp://u%401@[2001:db8::1]:2222//home/u%201/sites/100%25%20done",
    );
    // On standard input: Windows' command line would rewrite the script's backslashes.
    const read = (url: string) =>
      spawnSync("bash", ["-s"], {
        input: parse,
        env: { ...process.env, SFTP_URL: url },
        encoding: "utf8",
      });
    if (read("").error !== undefined) return;
    expect(read(sftpUrl(cases[0][0], cases[0][1])).stdout).toBe(
      "::add-mask::sftp.example.net\nsftp://web@sftp.example.net:22|opscrew\n",
    );
    expect(read(sftpUrl(cases[1][0], cases[1][1])).stdout).toBe(
      "::add-mask::[2001:db8::1]\nsftp://u%401@[2001:db8::1]:2222|/home/u 1/sites/100% done\n",
    );
    const missing = read("");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain(
      "::error::The deploy environment has no SFTP URL (OPSCREW_STAGING_SFTP_URL)",
    );
  });

  it("refuses a panel account, a Node.js app, a promoted environment and any other target", () => {
    expect(() =>
      renderSftpWorkflow(planFor({ ...PHP, php: { version: "8.3", via: "multiphp" } }, "cpanel")),
    ).toThrow("only applies to a static site or a PHP app on an SFTP-only host");
    expect(() => renderSftpWorkflow(serverPlan())).toThrow(
      "only applies to a static site or a PHP app",
    );
    expect(() =>
      renderSftpWorkflow(
        inEnvironment(planFor(PHP), {
          name: "prod2",
          deploySource: { from: "promote", source: "staging" },
        }),
      ),
    ).toThrow("cannot be promoted");
  });
});

describe("renderSftpPhpLines", () => {
  it("loads env.php in each module's way in .htaccess, and in .user.ini", () => {
    const lines = renderSftpPhpLines("/home/u1/opscrew/notes-prod/shared/env.php");
    expect(lines.htaccess).toBe(
      [
        "<IfModule LiteSpeed>",
        'php_value auto_prepend_file "/home/u1/opscrew/notes-prod/shared/env.php"',
        "</IfModule>",
        "<IfModule lsapi_module>",
        'php_value auto_prepend_file "/home/u1/opscrew/notes-prod/shared/env.php"',
        "</IfModule>",
        "<IfModule php_module>",
        'php_value auto_prepend_file "/home/u1/opscrew/notes-prod/shared/env.php"',
        "</IfModule>",
        "",
      ].join("\n"),
    );
    expect(lines.userIni).toBe(
      '; BEGIN OpsCrew\nauto_prepend_file = "/home/u1/opscrew/notes-prod/shared/env.php"\n; END OpsCrew\n',
    );
  });

  it("refuses a relative path, a quote or a line break", () => {
    for (const path of ["shared/env.php", '/a"b/env.php', "/a\nb/env.php"]) {
      expect(() => renderSftpPhpLines(path)).toThrow("must be absolute");
    }
  });
});
