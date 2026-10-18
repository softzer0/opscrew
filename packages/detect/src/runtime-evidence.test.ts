import { ProjectFactsSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function factsOf(files: Record<string, string>) {
  const root = await makeTree(files, "evidence");
  roots.push(root);
  const facts = await detectProject(root);
  expect(ProjectFactsSchema.parse(facts)).toEqual(facts);
  return facts;
}
const evidenceOf = async (files: Record<string, string>) => (await factsOf(files)).runtimeEvidence;
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

const PACKAGE = JSON.stringify({ name: "web", scripts: { start: "node server.js" } });
const CI = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
        include:
          - node: 24
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: \${{ matrix.node }}
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@v6
        with:
          python-version: 3.10
      - uses: actions/setup-node@v5
        with:
          node-version: lts/*
      - uses: actions/setup-node@v5
        with:
          node-version: \${{ env.NODE }}
`;

describe("runtime version evidence", () => {
  it("records every setup-node and setup-python version of the CI workflows, matrix included", async () => {
    const release =
      "name: release\njobs:\n  publish:\n    steps:\n      - uses: actions/setup-python@v6\n        with:\n          python-version: |\n            3.12\n            3.13\n";
    expect(
      await evidenceOf({
        "package.json": PACKAGE,
        ".github/workflows/ci.yml": CI,
        ".github/workflows/release.yaml": release,
        ".github/workflows/notes.md": "node-version: 18\n",
      }),
    ).toEqual({
      node: [
        { value: "20", source: ".github/workflows/ci.yml" },
        { value: "22", source: ".github/workflows/ci.yml" },
        { value: "24", source: ".github/workflows/ci.yml" },
        { value: "lts/*", source: ".github/workflows/ci.yml" },
      ],
      python: [
        { value: "3.10", source: ".github/workflows/ci.yml" },
        { value: "3.12", source: ".github/workflows/release.yaml" },
        { value: "3.13", source: ".github/workflows/release.yaml" },
      ],
    });
  });

  it("reads .tool-versions, the first version of each line", async () => {
    expect(
      await evidenceOf({
        "package.json": PACKAGE,
        ".tool-versions": "# pinned\nnodejs 20.11.1\npython 3.11.9 3.10.14\nruby 3.4.2\n",
      }),
    ).toEqual({
      node: [{ value: "20.11.1", source: ".tool-versions" }],
      python: [{ value: "3.11.9", source: ".tool-versions" }],
    });
  });

  it("reads mise.toml's tools as a string, a list or a table", async () => {
    const mise = '[tools]\nnode = { version = "22" }\npython = ["3.12", "3.11"]\n';
    expect(await evidenceOf({ "package.json": PACKAGE, "mise.toml": mise })).toEqual({
      node: [{ value: "22", source: "mise.toml" }],
      python: [
        { value: "3.12", source: "mise.toml" },
        { value: "3.11", source: "mise.toml" },
      ],
    });
    expect(
      (await evidenceOf({ "package.json": PACKAGE, "mise.toml": '[tools]\nnodejs = "20"\n' }))
        ?.node,
    ).toEqual([{ value: "20", source: "mise.toml" }]);
  });

  it("reads the last FROM per language of the app's Dockerfile, with ARG defaults", async () => {
    const dockerfile = [
      "ARG NODE_VERSION=20.18",
      "FROM node:16 AS deps",
      "FROM python:3.11-slim@sha256:0000 AS tools",
      `FROM --platform=linux/amd64 docker.io/library/node:\${NODE_VERSION}-alpine AS build`,
      "RUN npm ci",
      "FROM nginx:1.27",
      "",
    ].join("\n");
    expect(await evidenceOf({ "package.json": PACKAGE, Dockerfile: dockerfile })).toEqual({
      node: [{ value: "20.18", source: "Dockerfile" }],
      python: [{ value: "3.11", source: "Dockerfile" }],
    });
    const multiStage = "FROM node:16 AS build\nRUN npm ci\nFROM node:20\nCMD node server.js\n";
    expect(await evidenceOf({ "package.json": PACKAGE, Dockerfile: multiStage })).toEqual({
      node: [{ value: "20", source: "Dockerfile" }],
    });
    // The running stage's tag names no version, so the Dockerfile gives none.
    const lts = "FROM node:20 AS build\nFROM node:lts-alpine\n";
    expect(await evidenceOf({ "package.json": PACKAGE, Dockerfile: lts })).toBeUndefined();
  });

  it("drops values that name no version: system, PyPy and GraalPy", async () => {
    const ci = [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      '        python: ["3.12", "pypy3.10", "graalpy-24.1"]',
      "    steps:",
      "      - uses: actions/setup-python@v6",
      "        with:",
      `          python-version: \${{ matrix.python }}`,
      "      - uses: actions/setup-python@v6",
      "        with:",
      "          python-version: pypy-3.11",
      "",
    ].join("\n");
    expect(
      await evidenceOf({
        "package.json": PACKAGE,
        ".github/workflows/ci.yml": ci,
        ".tool-versions": "python system 3.11.9\nnodejs system\n",
      }),
    ).toEqual({
      python: [
        { value: "3.12", source: ".github/workflows/ci.yml" },
        { value: "3.11.9", source: ".tool-versions" },
      ],
    });
  });

  it("reads the @types/node major of the app's package.json", async () => {
    const pkg = JSON.stringify({ name: "web", devDependencies: { "@types/node": "^22.10.1" } });
    expect(await evidenceOf({ "package.json": pkg })).toEqual({
      node: [{ value: "22", source: "package.json" }],
    });
  });

  it("gives the Python range of the installed Django release from the table", async () => {
    const manage = "import os\n";
    expect(
      await evidenceOf({ "requirements.txt": "Django==5.2.7\ngunicorn\n", "manage.py": manage }),
    ).toEqual({ python: [{ value: ">=3.10,<3.15", source: "Django 5.2" }] });
    expect(
      await evidenceOf({ "requirements.txt": "django>=4.2,<5.0\n", "manage.py": manage }),
    ).toEqual({ python: [{ value: ">=3.8,<3.13", source: "Django 4.2" }] });
    expect(await evidenceOf({ "requirements.txt": "django~=6.0\n", "manage.py": manage })).toEqual({
      python: [{ value: ">=3.12,<3.15", source: "Django 6.0" }],
    });
    // Upper bounds and exclusions name no release; the lower bound does.
    expect(
      await evidenceOf({ "requirements.txt": "django!=5.0.1,>=4.2\n", "manage.py": manage }),
    ).toEqual({ python: [{ value: ">=3.8,<3.13", source: "Django 4.2" }] });
    expect(await evidenceOf({ "requirements.txt": "django>=5,<6\n", "manage.py": manage })).toEqual(
      { python: [{ value: ">=3.10,<3.13", source: "Django 5.0" }] },
    );
    expect(await evidenceOf({ "requirements.txt": "django<5.2\n" })).toBeUndefined();
    // An unknown release or no version gives no evidence.
    expect(await evidenceOf({ "requirements.txt": "django==3.2\n" })).toBeUndefined();
    expect(await evidenceOf({ "requirements.txt": "django\n" })).toBeUndefined();
  });

  it("keeps the declared version next to the evidence, and records none without evidence", async () => {
    const facts = await factsOf({
      "package.json": JSON.stringify({ name: "web", engines: { node: ">=20" } }),
      ".nvmrc": "22\n",
      ".tool-versions": "nodejs 22.11.0\n",
    });
    expect(facts.runtimeVersions).toEqual({ node: "22" });
    expect(facts.runtimeEvidence).toEqual({
      node: [{ value: "22.11.0", source: ".tool-versions" }],
    });
    expect(await evidenceOf({ "package.json": PACKAGE })).toBeUndefined();
  });
});
