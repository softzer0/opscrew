import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { detectPhpNeeds, PHP_8_EXTENSIONS } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function needsOf(files: Record<string, string>, appDir?: string) {
  const root = await makeTree(files, "php-needs");
  roots.push(root);
  return detectPhpNeeds(root, appDir);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const lock = (packages: unknown[], platform: Record<string, string> = {}) =>
  json({ packages, "packages-dev": [], platform, "platform-dev": {} });

describe("what a PHP app needs from the account's PHP", () => {
  it("reads composer.json's PHP constraint and the extensions of it and every locked package", async () => {
    const needs = await needsOf({
      "composer.json": json({
        require: {
          php: "^8.2",
          "ext-mbstring": "*",
          "ext-PDO_MySQL": "*",
          "laravel/framework": "^12",
        },
        "require-dev": { "ext-xdebug": "*" },
      }),
      "composer.lock": lock([
        {
          name: "laravel/framework",
          require: { php: "^8.2", "ext-mbstring": "*", "ext-fileinfo": "*" },
        },
        { name: "symfony/intl", require: { "ext-intl": "*" } },
        { name: "nothing/required" },
      ]),
    });
    expect(needs).toEqual({
      php: "^8.2",
      extensions: ["fileinfo", "intl", "mbstring", "pdo_mysql"],
      websockets: [],
    });
  });

  it("counts the extensions every PHP 8 build has as present", async () => {
    const always = [...PHP_8_EXTENSIONS].map((name) => [`ext-${name}`, "*"]);
    const needs = await needsOf({
      "composer.json": json({ require: { ...Object.fromEntries(always), "ext-gd": "*" } }),
    });
    expect(needs).toEqual({ extensions: ["gd"], websockets: [] });
    for (const name of ["json", "ctype", "filter", "hash", "pcre", "spl", "standard"]) {
      expect(PHP_8_EXTENSIONS.has(name)).toBe(true);
    }
  });

  it("leaves out the development packages, which a release never installs", async () => {
    const needs = await needsOf({
      "composer.json": json({ require: { php: ">=8.3" } }),
      "composer.lock": json({
        packages: [],
        "packages-dev": [{ name: "phpunit/phpunit", require: { "ext-dom": "*" } }],
      }),
    });
    expect(needs).toEqual({ php: ">=8.3", extensions: [], websockets: [] });
  });

  it("names the WebSocket servers the app requires", async () => {
    const needs = await needsOf({
      "composer.json": json({
        require: {
          "laravel/reverb": "^1.4",
          "cboden/ratchet": "^0.4",
          "pusher/pusher-php-server": "^7",
        },
      }),
    });
    expect(needs.websockets).toEqual(["cboden/ratchet", "laravel/reverb"]);
  });

  it("reads the app's own folder before the repository root", async () => {
    const needs = await needsOf(
      {
        "composer.json": json({ require: { php: "^7.4" } }),
        "apps/site/composer.json": json({ require: { php: "^8.4", "ext-zip": "*" } }),
      },
      "apps/site",
    );
    expect(needs).toEqual({ php: "^8.4", extensions: ["zip"], websockets: [] });
  });

  it("needs nothing it can tell without a composer.json, and ignores files it cannot read", async () => {
    expect(await needsOf({ "index.php": "<?php echo 1;\n" })).toEqual({
      extensions: [],
      websockets: [],
    });
    expect(await needsOf({ "composer.json": "{ not json", "composer.lock": "[]" })).toEqual({
      extensions: [],
      websockets: [],
    });
  });

  it("gives the example apps' needs", async () => {
    const examples = new URL("../../../examples/", import.meta.url);
    const read = (path: string) => readFile(new URL(path, examples), "utf8");
    const laravel = await needsOf({
      "composer.json": await read("laravel-app/composer.json"),
      "composer.lock": await read("laravel-app/composer.lock"),
    });
    expect(laravel.php).toBe("^8.4");
    expect(laravel.extensions).toEqual(expect.arrayContaining(["fileinfo", "mbstring"]));
    expect(laravel.extensions).not.toContain("json");
    const plain = await needsOf({
      "composer.json": await read("php-plain-mysql/composer.json"),
      "composer.lock": await read("php-plain-mysql/composer.lock"),
    });
    expect(plain).toEqual({ php: ">=8.3", extensions: ["pdo_mysql"], websockets: [] });
  });
});
