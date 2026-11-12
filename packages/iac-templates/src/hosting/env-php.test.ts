import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { renderEnvPhp } from "./env-php";

const php = spawnSync("php", ["-v"], { encoding: "utf8" }).status === 0;
if (!php) console.warn("[iac-templates] skipping env.php's runs: php is not available");

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Runs a script printing NAME from getenv(), $_ENV and $_SERVER, with env.php prepended. */
function runWith(envPhp: string, dotenv: string | undefined, names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "opscrew-env-php-"));
  folders.push(dir);
  writeFileSync(join(dir, "env.php"), envPhp);
  if (dotenv !== undefined) writeFileSync(join(dir, ".env"), dotenv);
  const print = names.map(
    (n) =>
      `echo json_encode([getenv('${n}'), $_ENV['${n}'] ?? null, $_SERVER['${n}'] ?? null]), "\\n";`,
  );
  writeFileSync(join(dir, "show.php"), `<?php\n${print.join("\n")}\n`);
  return spawnSync(
    "php",
    ["-n", "-d", `auto_prepend_file=${join(dir, "env.php")}`, join(dir, "show.php")],
    {
      encoding: "utf8",
    },
  );
}

describe("renderEnvPhp", () => {
  it("renders the loader with the names it loads", () => {
    expect(renderEnvPhp(["APP_KEY", "DB_PASSWORD"])).toMatchSnapshot();
  });

  it.each([["1PASSWORD"], ["DB-PASSWORD"], ["X'"], [""]])("refuses the name %j", (name) => {
    expect(() => renderEnvPhp(["APP_KEY", name])).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses a name given twice", () => {
    expect(() => renderEnvPhp(["APP_KEY", "APP_KEY"])).toThrow(/APP_KEY/);
  });

  it.skipIf(!php)("is valid PHP", () => {
    const dir = mkdtempSync(join(tmpdir(), "opscrew-env-php-"));
    folders.push(dir);
    writeFileSync(join(dir, "env.php"), renderEnvPhp(["APP_KEY"]));
    const result = spawnSync("php", ["-l", join(dir, "env.php")], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it.skipIf(!php)(
    "loads the listed values, bare, single- or double-quoted, and nothing else",
    () => {
      const password = fakeSecret("generic-password", "env-php");
      const dotenv = [
        "# the app's settings",
        `DB_PASSWORD=${password}`,
        "APP_NAME='Notes $HOME'",
        'MAIL_FROM="Notes \\"team\\"\\nline two \\$x \\\\ end"',
        "UNLISTED=nope",
        "",
      ].join("\n");
      const result = runWith(
        renderEnvPhp(["DB_PASSWORD", "APP_NAME", "MAIL_FROM", "MISSING"]),
        dotenv,
        ["DB_PASSWORD", "APP_NAME", "MAIL_FROM", "UNLISTED"],
      );
      expect(result.status).toBe(0);
      expect(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        [password, password, password],
        ["Notes $HOME", "Notes $HOME", "Notes $HOME"],
        Array(3).fill('Notes "team"\nline two $x \\ end'),
        [false, null, null],
      ]);
    },
  );

  it.skipIf(!php)("stops with nothing printed when the values file is missing", () => {
    const result = runWith(renderEnvPhp(["APP_KEY"]), undefined, ["APP_KEY"]);
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });
});
