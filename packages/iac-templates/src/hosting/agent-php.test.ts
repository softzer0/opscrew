// Feature 027 (T2754, research R16): on Apache with PHP-FPM, OPcache keeps the old release after a
// switch unless opcache.revalidate_path is on, and then until PHP's path cache (120 s) expires. The
// agent's functions run alone in bash here, so these cases run under Git for Windows too.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentSkipReason } from "./__fixtures__/account";
import { AGENT_SH } from "./agent";

const reason = agentSkipReason();
if (reason !== undefined)
  console.warn(`[iac-templates] skipping the agent's PHP blocks: ${reason}`);

const DIR = "/home/u1/opscrew/notes-prod";
const ENV_PHP = `${DIR}/shared/env.php`;
const MODULES = ["LiteSpeed", "lsapi_module", "php_module"];

/** The agent's bash function `name`, as AGENT_SH defines it. */
function fn(name: string): string {
  const start = AGENT_SH.indexOf(`\n${name}() {\n`);
  const end = AGENT_SH.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`AGENT_SH has no function ${name}`);
  return AGENT_SH.slice(start + 1, end + 3);
}

/**
 * Runs `script` (after the agent's functions `functions`) by bash in a new app folder with
 * releases/7-1/public, and shared/env.php when `envPhp`; the files `read` afterwards.
 */
function inAppFolder(
  functions: string[],
  script: string,
  env: Record<string, string>,
  options: { envPhp?: boolean; read: string[] },
): { stdout: string; files: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "opscrew-agent-php-")).replaceAll("\\", "/");
  try {
    mkdirSync(`${dir}/shared`);
    mkdirSync(`${dir}/releases/7-1/public`, { recursive: true });
    if (options.envPhp) writeFileSync(`${dir}/shared/env.php`, "<?php\n");
    const ran = spawnSync("bash", ["-s"], {
      input: [...functions.map(fn), script].join("\n"),
      cwd: dir,
      env: {
        ...process.env,
        DIR,
        HOST_NAME: "notes.example.com",
        WEB_ROOT: "public",
        HEALTH_PATH: "/",
        PHP_HANDLER: "",
        ...env,
      },
      encoding: "utf8",
    });
    expect(ran.stderr).toBe("");
    const files: Record<string, string> = {};
    for (const name of options.read) files[name] = readFileSync(`${dir}/${name}`, "utf8");
    return { stdout: ran.stdout, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** OpsCrew's .htaccess and .user.ini blocks of release 7-1 for an app of `appKind`. */
function blocks(appKind: string, envPhp: boolean): { htaccess: string; userIni: string } {
  const { files } = inAppFolder(
    ["fallback_needed", "htaccess_block", "user_ini_block"],
    "htaccess_block 7-1 > htaccess\nuser_ini_block 7-1 > user.ini",
    { APP_KIND: appKind },
    { envPhp, read: ["htaccess", "user.ini"] },
  );
  return { htaccess: files.htaccess ?? "", userIni: files["user.ini"] ?? "" };
}

describe.skipIf(reason !== undefined)("the agent's PHP blocks", () => {
  it("turn opcache.revalidate_path on for every PHP release, and load env.php where it is", () => {
    const withValues = blocks("php", true);
    for (const module of MODULES) {
      expect(withValues.htaccess).toContain(
        `<IfModule ${module}>\nphp_flag opcache.revalidate_path on\nphp_value auto_prepend_file "${ENV_PHP}"\n</IfModule>\n`,
      );
    }
    expect(withValues.userIni).toBe(
      `; BEGIN OpsCrew\nopcache.revalidate_path = 1\nauto_prepend_file = "${ENV_PHP}"\n; END OpsCrew\n`,
    );

    const without = blocks("php", false);
    for (const module of MODULES) {
      expect(without.htaccess).toContain(
        `<IfModule ${module}>\nphp_flag opcache.revalidate_path on\n</IfModule>\n`,
      );
    }
    expect(without.htaccess).not.toContain("auto_prepend_file");
    expect(without.userIni).toBe("; BEGIN OpsCrew\nopcache.revalidate_path = 1\n; END OpsCrew\n");
  });

  it("give a static site neither", () => {
    const site = blocks("static", false);
    expect(site.htaccess).not.toContain("opcache");
    expect(site.htaccess).not.toContain("<IfModule");
    expect(site.userIni).toBe("");
  });
});

/**
 * The agent's health_check of release 7-1 against a hostname that answers `code` with release
 * 7-1 from `server`: whether it passed, and the seconds it slept first.
 */
function healthCheck(appKind: string, server: string, code = 200): string {
  return inAppFolder(
    ["line_of", "site_url", "fetch", "header_of", "health_check"],
    [
      `curl() { printf 'HTTP/1.1 ${code} Answer\\r\\nServer: ${server}\\r\\nX-OpsCrew-Release: 7-1\\r\\n\\r\\n'; }`,
      "slept=0",
      "sleep() { slept=$((slept + $1)); }",
      'if health_check 7-1; then printf "passed %s" "$slept"; else printf "failed %s: %s" "$slept" "$CHECK_SAID"; fi',
    ].join("\n"),
    { APP_KIND: appKind },
    { read: [] },
  ).stdout;
}

describe.skipIf(reason !== undefined)("the agent's health_check", () => {
  it("counts a PHP app's answer on Apache only from try 27, 130 seconds after the switch", () => {
    expect(healthCheck("php", "Apache")).toBe("passed 130");
  });

  it("counts the first answer behind LiteSpeed, and a static site's anywhere", () => {
    expect(healthCheck("php", "LiteSpeed")).toBe("passed 0");
    expect(healthCheck("static", "Apache")).toBe("passed 0");
  });

  it("gives up after try 28 when the app never answers 2xx or 3xx with the release", () => {
    expect(healthCheck("php", "Apache", 500)).toBe("failed 135: it answered 500 with release 7-1");
  });
});
