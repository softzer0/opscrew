// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
// Feature 027 (T2714): the deploy workflow of an app on an SFTP-only host. The cases that switch
// a release need real symbolic links, which Git for Windows' `ln -s` doesn't make: they skip there.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NPM_SITE } from "../serverless/__fixtures__/plans";
import { inEnvironment, serverPlan } from "../workflow/__fixtures__/plans";
import { deploySecretNamesFor, renderWorkflow } from "../workflow/index";
import { CAN_LINK } from "./__fixtures__/account";
import {
  hostingKeptFolders,
  renderSftpPhpLines,
  renderSftpWorkflow,
  SFTP_DEPLOY_SECRETS,
  sftpUrl,
} from "./index";

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
    // Behind anything but LiteSpeed, a PHP app's switch counts once PHP's path cache is past.
    expect(script).toContain('if [ "$try" -ge 27 ]; then return 0; fi');
    expect(deployStep(doc(STATIC)).run).not.toContain('if [ "$try" -ge 27 ]');
    expect(deployStep(doc(STATIC)).run).toContain(
      "RewriteRule ^(vendor|storage|composer\\.json|composer\\.lock)(/|$) - [F]",
    );
  });

  it("is valid bash", () => {
    const parsed = spawnSync("bash", ["-n"], { input: deployStep(doc(PHP)).run, encoding: "utf8" });
    if (parsed.error === undefined) expect(parsed.stderr).toBe("");
  });

  /**
   * The served folder's `.htaccess` and `.user.ini` (undefined when there is none) the deploy step
   * composes for a release of `files` (its step 2 run alone), with the host's `shared/` files
   * `shared` (`env.htaccess`, `env.user.ini`) fetched.
   */
  function composed(
    target: Record<string, unknown>,
    files: Record<string, string>,
    shared: Record<string, string> = {},
  ): { htaccess: string; userIni: string | undefined } {
    const script = deployStep(doc(target)).run ?? "";
    const step = script.slice(script.indexOf("# 2. "), script.indexOf("# 3. "));
    const work = mkdtempSync(join(tmpdir(), "opscrew-sftp-")).replaceAll("\\", "/");
    try {
      const served = `${work}/release/${target.webRoot}`;
      mkdirSync(served, { recursive: true });
      for (const [name, text] of Object.entries(files)) writeFileSync(`${served}/${name}`, text);
      for (const [name, text] of Object.entries(shared)) writeFileSync(`${work}/${name}`, text);
      const ran = spawnSync("bash", ["-c", `curl() { return 1; }\nset -euo pipefail\n${step}`], {
        encoding: "utf8",
        env: { ...process.env, work, release: "7-1" },
      });
      expect(ran.stderr).toBe("");
      const userIni = files[".user.ini"] !== undefined || "env.user.ini" in shared;
      return {
        htaccess: readFileSync(`${served}/.htaccess`, "utf8"),
        userIni: userIni ? readFileSync(`${served}/.user.ini`, "utf8") : undefined,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  it("sends a path that is no file to index.php where the app's .htaccess has no rewrite rules", () => {
    const fallback =
      "RewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^ index.php [L]\n# END OpsCrew\n";
    /** OpsCrew's block the deploy step composes for a release of `files`. */
    function block(target: Record<string, unknown>, files: Record<string, string>): string {
      const { htaccess } = composed(target, files);
      return htaccess.slice(0, htaccess.indexOf("# END OpsCrew\n") + "# END OpsCrew\n".length);
    }
    const php = { "index.php": "<?php echo 'notes';\n" };
    expect(block(PHP, php).endsWith(`X-OpsCrew-Release "7-1"\n${fallback}`)).toBe(true);
    expect(
      block(PHP, { ...php, ".htaccess": "# RewriteRule ^old$ /new\nOptions -MultiViews\n" }),
    ).toContain(fallback);
    // An app that rewrites keeps its own routing; a static site gets none.
    expect(block(PHP, { ...php, ".htaccess": "  rewriterule ^ index.php [L]\n" })).not.toContain(
      "index.php",
    );
    expect(block(STATIC, { "index.html": "<h1>Site</h1>\n" })).not.toContain("index.php");
  });

  it("puts the host's PHP lines, opcache.revalidate_path among them, into a PHP release's blocks", () => {
    const lines = renderSftpPhpLines("/home/web/opscrew/shared/env.php");
    const shared = { "env.htaccess": lines.htaccess, "env.user.ini": lines.userIni };
    const php = { "index.php": "<?php echo 'notes';\n" };
    const plain = composed(PHP, php, shared);
    expect(plain.htaccess).toContain(
      `X-OpsCrew-Release "7-1"\n${lines.htaccess}RewriteCond %{REQUEST_FILENAME} !-f\n`,
    );
    expect(plain.userIni).toBe(lines.userIni);
    // The app's own .user.ini follows OpsCrew's block.
    expect(composed(PHP, { ...php, ".user.ini": "memory_limit = 256M\n" }, shared).userIni).toBe(
      `${lines.userIni}; BEGIN OpsCrew: app\nmemory_limit = 256M\n; END OpsCrew: app\n`,
    );
    // Provision writes no PHP lines for a static site, which gets none.
    const site = composed(STATIC, { "index.html": "<h1>Site</h1>\n" });
    expect(site.htaccess).not.toContain("opcache");
    expect(site.userIni).toBeUndefined();
  });

  /**
   * The deploy step's check (its step 4 up to the switch back) of release 7-1 against a hostname
   * that answers `code` with release 7-1 from `server`: whether it passed, and the seconds it slept
   * first.
   */
  function checked(target: Record<string, unknown>, server: string, code = 200): string {
    const script = deployStep(doc(target)).run ?? "";
    const start = script.indexOf("one_line() {");
    const oneLine = script.slice(start, script.indexOf("\n}\n", start) + 3);
    const check = script.slice(script.indexOf("# 4. "), script.indexOf("if ! check; then"));
    const ran = spawnSync("bash", ["-s"], {
      input: [
        `curl() { printf 'HTTP/1.1 ${code} Answer\\r\\nServer: ${server}\\r\\nX-OpsCrew-Release: 7-1\\r\\n\\r\\n'; }`,
        "slept=0",
        "sleep() { slept=$((slept + $1)); }",
        "release=7-1",
        "https=no",
        oneLine,
        check,
        'if check; then printf "passed %s" "$slept"; else printf "failed %s: %s" "$slept" "$CHECK_SAID"; fi',
      ].join("\n"),
      encoding: "utf8",
    });
    expect(ran.stderr).toBe("");
    return ran.stdout;
  }

  it("counts a PHP app's answer behind anything but LiteSpeed only from try 27, 130 seconds after the switch", () => {
    expect(checked(PHP, "Apache")).toBe("passed 130");
    expect(checked(PHP, "LiteSpeed")).toBe("passed 0");
    expect(checked(STATIC, "Apache")).toBe("passed 0");
    expect(checked(PHP, "Apache", 500)).toBe("failed 135: it answered 500 with release 7-1");
  });

  it("keeps the plan's kept folders in shared/ and links them into the release before the switch", () => {
    const kept = { ...planFor(PHP), storage: { files: { dir: "./storage/" } } };
    expect(hostingKeptFolders(kept)).toEqual(["storage"]);
    expect(
      hostingKeptFolders({ storage: { files: { dir: "uploads" }, sqlite: { dir: "var/db" } } }),
    ).toEqual(["uploads", "var/db"]);
    const script = deployStep(parse(renderSftpWorkflow(kept).content) as Workflow).run ?? "";
    expect(script).toContain("kept=('storage')");
    const upload = script.indexOf("@put -r");
    expect(script.indexOf('for dir in "${kept[@]}"; do')).toBeLessThan(upload);
    expect(script.indexOf("if ! link_kept; then")).toBeGreaterThan(upload);
    expect(script.indexOf("if ! link_kept; then")).toBeLessThan(
      script.indexOf('if ! switch_to "releases/$release"; then'),
    );
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).stderr ?? "").toBe("");
    // Without one, nothing of it.
    expect(deployStep(doc(PHP)).run).not.toContain("shared/$dir");
  });

  /**
   * Steps 1 to 3 of the deploy step (up to the check) for `plan`, run by bash with `sftp` played
   * by a function that runs each batch line on `host` (OpenSSH's posix-rename as `mv -T`), and
   * `curl` failing; the release is `files`. Returns the batch lines it ran.
   */
  function deployTo(plan: DeployPlan, host: string, run: number, files: Record<string, string>) {
    const script = deployStep(parse(renderSftpWorkflow(plan).content) as Workflow).run ?? "";
    const temp = mkdtempSync(join(tmpdir(), "opscrew-sftp-run-")).replaceAll("\\", "/");
    try {
      const src = `${temp}/src`;
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(src, name, ".."), { recursive: true });
        writeFileSync(join(src, name), text);
      }
      mkdirSync(src, { recursive: true });
      spawnSync("tar", ["-cf", `${temp}/release.tar`, "-C", src, "."]);
      const stub = `curl() { return 1; }
sftp() {
  (
    set +e
    cd "$HOST" || exit 1
    while IFS= read -r line; do
      ignore=no
      if [[ $line == -* ]]; then ignore=yes; line=\${line#-}; fi
      line=\${line#@}
      printf '%s\\n' "$line" >> "$LOG"
      eval "set -- $line"
      cmd=$1
      shift
      case $cmd in
        get) cp "$1" "$2" ;;
        put) cp -R "$2" "$3" ;;
        ls) [ -e "$2" ] ;;
        mkdir) mkdir "$1" ;;
        rename) mv -T "$1" "$2" ;;
        ln) ln -s "$2" "$3" ;;
        rm) rm "$1" ;;
        rmdir) rmdir "$1" ;;
        chmod) chmod "$1" "$2" ;;
        *) false ;;
      esac 2> /dev/null
      if [ $? -ne 0 ] && [ $ignore = no ]; then echo "sftp: $line failed" >&2; exit 1; fi
    done
  )
}
`;
      const ran = spawnSync("bash", ["-s"], {
        input: `${stub}${script.slice(0, script.indexOf("# 4. "))}`,
        encoding: "utf8",
        env: {
          ...process.env,
          HOST: host,
          LOG: `${temp}/batch.log`,
          GITHUB_RUN_ID: String(run),
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_TEMP: temp,
          SFTP_URL: sftpUrl({ host: "sftp.example.net", port: 22, user: "web" }, "opscrew/notes"),
          SFTP_KEY: "key",
          KNOWN_HOSTS: "known",
        },
      });
      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
      return readFileSync(`${temp}/batch.log`, "utf8").split("\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /** A host with the app's folder as provision leaves it. */
  function sftpHost(): { host: string; app: string; remove: () => void } {
    const host = mkdtempSync(join(tmpdir(), "opscrew-sftp-host-")).replaceAll("\\", "/");
    const app = `${host}/opscrew/notes`;
    for (const dir of ["releases/0-0", "shared", "state"]) {
      mkdirSync(`${app}/${dir}`, { recursive: true });
    }
    symlinkSync("releases/0-0", `${app}/current`);
    return { host, app, remove: () => rmSync(host, { recursive: true, force: true }) };
  }

  it.skipIf(!CAN_LINK)(
    "moves the release's kept folder into shared/ on the first deploy, and a second release sees what the app wrote there",
    () => {
      const { host, app, remove } = sftpHost();
      try {
        const plan = { ...planFor(PHP), storage: { files: { dir: "storage" } } };
        const release = (marker: string) => ({
          "public/index.php": `<?php echo '${marker}';\n`,
          "storage/.htaccess": "Require all denied\n",
        });
        const first = deployTo(plan, host, 101, release("one"));
        expect(first).toContain(
          'rename "opscrew/notes/releases/101-1/storage" "opscrew/notes/shared/storage"',
        );
        expect(readlinkSync(`${app}/current`)).toBe("releases/101-1");
        expect(readlinkSync(`${app}/releases/101-1/storage`)).toBe("../../shared/storage");
        expect(readFileSync(`${app}/shared/storage/.htaccess`, "utf8")).toBe(
          "Require all denied\n",
        );
        // The app writes into its kept folder.
        writeFileSync(`${app}/current/storage/note.txt`, "kept\n");

        const second = deployTo(plan, host, 102, release("two"));
        expect(second.some((line) => line.startsWith("rename") && line.includes("shared"))).toBe(
          false,
        );
        expect(readlinkSync(`${app}/current`)).toBe("releases/102-1");
        expect(readlinkSync(`${app}/releases/102-1/storage`)).toBe("../../shared/storage");
        expect(readFileSync(`${app}/current/storage/note.txt`, "utf8")).toBe("kept\n");
        expect(readdirSync(`${app}/shared/storage`).sort()).toEqual([".htaccess", "note.txt"]);
        // A rollback's release keeps its link.
        expect(readFileSync(`${app}/releases/101-1/storage/note.txt`, "utf8")).toBe("kept\n");
      } finally {
        remove();
      }
    },
  );

  it.skipIf(!CAN_LINK)(
    "makes an empty kept folder the release has none of, with its parents, linked one ../ more per /",
    () => {
      const { host, app, remove } = sftpHost();
      try {
        const plan = { ...planFor(PHP), storage: { files: { dir: "storage/app" } } };
        const index = { "public/index.php": "<?php echo 'notes';\n" };
        deployTo(plan, host, 101, index);
        expect(readdirSync(`${app}/shared/storage/app`)).toEqual([]);
        expect(readlinkSync(`${app}/releases/101-1/storage/app`)).toBe(
          "../../../shared/storage/app",
        );
        writeFileSync(`${app}/current/storage/app/upload.txt`, "kept\n");
        deployTo(plan, host, 102, index);
        expect(readFileSync(`${app}/current/storage/app/upload.txt`, "utf8")).toBe("kept\n");
      } finally {
        remove();
      }
    },
  );

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
  it("turns opcache.revalidate_path on and loads env.php, in each module's way in .htaccess, and in .user.ini", () => {
    const lines = renderSftpPhpLines("/home/u1/opscrew/notes-prod/shared/env.php");
    expect(lines.htaccess).toBe(
      ["LiteSpeed", "lsapi_module", "php_module"]
        .flatMap((module) => [
          `<IfModule ${module}>`,
          "php_flag opcache.revalidate_path on",
          'php_value auto_prepend_file "/home/u1/opscrew/notes-prod/shared/env.php"',
          "</IfModule>",
        ])
        .concat("")
        .join("\n"),
    );
    expect(lines.userIni).toBe(
      '; BEGIN OpsCrew\nopcache.revalidate_path = 1\nauto_prepend_file = "/home/u1/opscrew/notes-prod/shared/env.php"\n; END OpsCrew\n',
    );
  });

  it("refuses a relative path, a quote or a line break", () => {
    for (const path of ["shared/env.php", '/a"b/env.php', "/a\nb/env.php"]) {
      expect(() => renderSftpPhpLines(path)).toThrow("must be absolute");
    }
  });
});
