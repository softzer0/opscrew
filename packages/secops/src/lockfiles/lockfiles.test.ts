import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanContext } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import {
  collectLockedPackages,
  isLockfile,
  type LockedPackage,
  normalizePythonName,
  parseLockfile,
} from "./index";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/deps/lockfiles");

function parseFixture(fixture: string, as = fixture): LockedPackage[] {
  return parseLockfile(as, readFileSync(join(FIXTURES, fixture), "utf8"));
}

const ids = (packages: LockedPackage[]) => packages.map((p) => `${p.name}@${p.version}`).sort();

describe("lockfile parsers", () => {
  it("reads package-lock.json v3 packages, nested copies, aliases; skips links, workspaces and paths", () => {
    const packages = parseFixture("package-lock.json");
    expect(ids(packages)).toEqual([
      "@types/node@20.11.5",
      "debug@2.6.9",
      "debug@4.3.4",
      "express@4.18.2",
      "string-width@4.2.3",
    ]);
    expect(packages.every((p) => p.ecosystem === "npm" && p.file === "package-lock.json")).toBe(
      true,
    );
  });

  it("reads package-lock.json v1 dependencies recursively, resolving npm: aliases", () => {
    expect(ids(parseFixture("package-lock-v1.json", "package-lock.json"))).toEqual([
      "lodash@4.17.20",
      "minimist@1.2.5",
      "qs@6.5.2",
      "request@2.88.2",
    ]);
  });

  it("reads pnpm-lock.yaml v6 keys with peer suffixes and explicit name/version entries", () => {
    expect(ids(parseFixture("pnpm-lock-v6.yaml", "pnpm-lock.yaml"))).toEqual([
      "@babel/runtime@7.23.9",
      "from-git@1.0.0-git",
      "js-tokens@4.0.0",
      "react-dom@18.2.0",
    ]);
  });

  it("reads pnpm-lock.yaml v9 keys and skips tarball keys without a name", () => {
    expect(ids(parseFixture("pnpm-lock-v9.yaml", "pnpm-lock.yaml"))).toEqual([
      "@next/env@15.1.0",
      "next@15.1.0",
      "react@19.0.0",
    ]);
  });

  it("reads pnpm-lock.yaml v5 keys (`/name/version_peer`)", () => {
    const text = [
      "lockfileVersion: 5.4",
      "packages:",
      "  /left-pad/1.3.0:",
      "    dev: false",
      "  /@types/react/18.0.0_react@18.0.0:",
      "    dev: true",
    ].join("\n");
    expect(ids(parseLockfile("pnpm-lock.yaml", text))).toEqual([
      "@types/react@18.0.0",
      "left-pad@1.3.0",
    ]);
  });

  it("reads classic yarn.lock blocks, aliases, and skips file: dependencies", () => {
    expect(ids(parseFixture("yarn-classic.lock", "yarn.lock"))).toEqual([
      "@babel/code-frame@7.12.13",
      "lodash@4.17.19",
      "string-width@4.2.3",
    ]);
  });

  it("reads berry yarn.lock resolutions and skips workspace and patch entries", () => {
    expect(ids(parseFixture("yarn-berry.lock", "yarn.lock"))).toEqual([
      "@scope/pkg@2.1.0",
      "axios@1.6.0",
    ]);
  });

  it("reads exact pins from requirements files, normalising names", () => {
    const packages = parseFixture("requirements.txt", "api/requirements-prod.txt");
    expect(ids(packages)).toEqual([
      "django@4.2.1",
      "fastapi@0.110.0",
      "redis@5.0.1",
      "requests@2.31.0",
      "zope-interface@6.1",
    ]);
    expect(packages.every((p) => p.ecosystem === "PyPI")).toBe(true);
  });

  it("reads poetry.lock packages and skips directory sources", () => {
    expect(ids(parseFixture("poetry.lock"))).toEqual(["certifi@2023.7.22", "jinja2@3.1.2"]);
  });

  it("reads uv.lock registry packages only", () => {
    expect(ids(parseFixture("uv.lock"))).toEqual(["anyio@4.2.0", "idna@3.6"]);
  });

  it("de-duplicates packages within one lockfile", () => {
    const text = "a==1.0\nA==1.0\na==2.0\n";
    expect(ids(parseLockfile("requirements.txt", text))).toEqual(["a@1.0", "a@2.0"]);
  });

  it("throws on malformed lockfiles so callers can skip them", () => {
    expect(() => parseLockfile("package-lock.json", "{ not json")).toThrow();
    expect(() => parseLockfile("poetry.lock", "[[package]\nname=")).toThrow();
  });
});

describe("isLockfile / normalizePythonName", () => {
  it("recognises supported lockfile names anywhere except node_modules", () => {
    for (const file of [
      "package-lock.json",
      "web/pnpm-lock.yaml",
      "yarn.lock",
      "npm-shrinkwrap.json",
      "requirements.txt",
      "api/requirements-dev.txt",
      "poetry.lock",
      "uv.lock",
    ]) {
      expect(isLockfile(file), file).toBe(true);
    }
    for (const file of [
      "package.json",
      "node_modules/x/package-lock.json",
      "reqs.txt",
      "Pipfile",
    ]) {
      expect(isLockfile(file), file).toBe(false);
    }
  });

  it("normalises Python names per PEP 503", () => {
    expect(normalizePythonName("Django_REST.framework")).toBe("django-rest-framework");
  });
});

describe("collectLockedPackages", () => {
  it("merges lockfiles in path order, de-duplicates across files and skips broken ones", async () => {
    const files: Record<string, string> = {
      "b/package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/x": { version: "1.0.0" },
          "node_modules/y": { version: "2.0.0" },
        },
      }),
      "a/package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/x": { version: "1.0.0" } },
      }),
      "c/poetry.lock": "[[package]\n",
      "README.md": "# hi",
    };
    const context: ScanContext = {
      rootDir: "/project",
      files: Object.keys(files),
      readFile: async (file) => files[file] ?? "",
      offline: true,
      fetch: async () => {
        throw new Error("no network in tests");
      },
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    };
    const packages = await collectLockedPackages(context);
    expect(packages).toEqual([
      { ecosystem: "npm", name: "x", version: "1.0.0", file: "a/package-lock.json" },
      { ecosystem: "npm", name: "y", version: "2.0.0", file: "b/package-lock.json" },
    ]);
  });
});
