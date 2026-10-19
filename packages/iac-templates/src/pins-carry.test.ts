import { describe, expect, it } from "vitest";
import { keepNewerPins } from "./index";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const sha = (c: string) => c.repeat(40);

describe("keepNewerPins", () => {
  it("keeps the committed digest of the same tag (a Dependabot update)", () => {
    const committed = `FROM node:24-alpine@${digest("b")} AS build\nFROM node:24-alpine@${digest("b")}\n`;
    const rendered = `FROM node:24-alpine@${digest("a")} AS build\nFROM node:24-alpine@${digest("a")}\n`;
    expect(keepNewerPins(committed, rendered)).toBe(committed);
  });

  it("keeps a higher committed tag, and replaces an older one", () => {
    const rendered = [
      `    image: caddy:2.11.7-alpine@${digest("a")}`,
      `    image: postgres:17.6-alpine@${digest("a")}`,
      `    image: basecamp/kamal-proxy:v0.10.2@${digest("a")}`,
      `    image: cloudflare/cloudflared:2026.5.1@${digest("a")}`,
      "",
    ].join("\n");
    const committed = [
      `    image: caddy:2.11.10-alpine@${digest("b")}`,
      `    image: postgres:17.2-alpine@${digest("b")}`,
      `    image: basecamp/kamal-proxy:v0.10.10@${digest("b")}`,
      `    image: cloudflare/cloudflared:2026.4.0@${digest("b")}`,
      "",
    ].join("\n");
    expect(keepNewerPins(committed, rendered)).toBe(
      [
        `    image: caddy:2.11.10-alpine@${digest("b")}`,
        `    image: postgres:17.6-alpine@${digest("a")}`,
        `    image: basecamp/kamal-proxy:v0.10.10@${digest("b")}`,
        `    image: cloudflare/cloudflared:2026.5.1@${digest("a")}`,
        "",
      ].join("\n"),
    );
  });

  it("keeps the committed major of the images Dependabot keeps on their major", () => {
    // OpsCrew's pins moved to new majors; the committed majors stay, older or newer.
    const rendered = [
      `    image: postgres:18-alpine@${digest("a")}`,
      `    image: caddy:3.0.1-alpine@${digest("a")}`,
      `FROM node:24-alpine@${digest("a")}`,
      `FROM python:4.0-slim@${digest("a")}`,
      `    image: valkey/valkey:9-alpine@${digest("a")}`,
      "",
    ].join("\n");
    const committed = [
      `    image: postgres:17-alpine@${digest("b")}`,
      `    image: caddy:2.11.10-alpine@${digest("b")}`,
      `FROM node:26-alpine@${digest("b")}`,
      `FROM python:3.15-slim@${digest("b")}`,
      // Not one of them: the higher tag wins, as before.
      `    image: valkey/valkey:8-alpine@${digest("b")}`,
      "",
    ].join("\n");
    expect(keepNewerPins(committed, rendered)).toBe(
      [...committed.split("\n").slice(0, 4), ...rendered.split("\n").slice(4)].join("\n"),
    );
    // Within the major the higher tag still wins (Python 3.14 to 3.15 is a minor update).
    expect(
      keepNewerPins(
        `FROM python:3.14-slim@${digest("b")}\n`,
        `FROM python:3.15-slim@${digest("a")}\n`,
      ),
    ).toBe(`FROM python:3.15-slim@${digest("a")}\n`);
  });

  it("keeps the committed minor of the images Dependabot keeps on their minor (Meilisearch)", () => {
    const pin = (tag: string, c: string) => `    image: getmeili/meilisearch:${tag}@${digest(c)}\n`;
    // A new OpsCrew minor, newer or older, leaves the committed one alone.
    expect(keepNewerPins(pin("v1.55.0", "b"), pin("v1.56.0", "a"))).toBe(pin("v1.55.0", "b"));
    expect(keepNewerPins(pin("v1.56.0", "b"), pin("v1.55.0", "a"))).toBe(pin("v1.56.0", "b"));
    // Within the minor the higher patch still wins.
    expect(keepNewerPins(pin("v1.55.0", "b"), pin("v1.55.1", "a"))).toBe(pin("v1.55.1", "a"));
    // Typesense keeps only its major.
    expect(
      keepNewerPins(
        `    image: typesense/typesense:30.2@${digest("b")}\n`,
        `    image: typesense/typesense:30.3@${digest("a")}\n`,
      ),
    ).toBe(`    image: typesense/typesense:30.3@${digest("a")}\n`);
  });

  it("keeps OpsCrew's image when the committed one is another variant or not comparable", () => {
    const rendered = `FROM node:24-alpine@${digest("a")}\nFROM python:3.14-slim@${digest("a")}\n`;
    for (const committed of [
      `FROM node:26-slim@${digest("b")}\nFROM python:3.15-bookworm@${digest("b")}\n`,
      `FROM node:lts-alpine@${digest("b")}\nFROM python:latest@${digest("b")}\n`,
      // Pinned by tag only: nothing to carry over.
      "FROM node:26-alpine\nFROM python:3.15-slim\n",
      "",
    ]) {
      expect(keepNewerPins(committed, rendered)).toBe(rendered);
    }
  });

  it("carries images on registries other than Docker Hub", () => {
    const rendered = `BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.42.0@${digest("a")}\n`;
    const committed = `BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.43.1@${digest("b")}\n`;
    expect(keepNewerPins(committed, rendered)).toBe(committed);
  });

  it("keeps newer action pins and their tag comments", () => {
    const rendered = [
      `      - uses: actions/checkout@${sha("1")} # v7.0.1`,
      `      - uses: docker/build-push-action@${sha("1")} # v7.4.0`,
      `      - uses: buildpacks/github-actions/setup-pack@${sha("1")} # v6.2.0`,
      `      - uses: sigstore/cosign-installer@${sha("1")} # v4.1.2`,
      "",
    ].join("\n");
    const committed = [
      // Same tag, other commit: the committed one stays.
      `      - uses: actions/checkout@${sha("2")} # v7.0.1`,
      // A newer release.
      `      - uses: docker/build-push-action@${sha("2")} # v7.5.0`,
      `      - uses: buildpacks/github-actions/setup-pack@${sha("2")} # v6.10.0`,
      // An older release is replaced.
      `      - uses: sigstore/cosign-installer@${sha("2")} # v4.0.0`,
      "",
    ].join("\n");
    expect(keepNewerPins(committed, rendered)).toBe(
      [
        `      - uses: actions/checkout@${sha("2")} # v7.0.1`,
        `      - uses: docker/build-push-action@${sha("2")} # v7.5.0`,
        `      - uses: buildpacks/github-actions/setup-pack@${sha("2")} # v6.10.0`,
        `      - uses: sigstore/cosign-installer@${sha("1")} # v4.1.2`,
        "",
      ].join("\n"),
    );
  });

  it("keeps an action pinned by commit without a tag comment as OpsCrew renders it", () => {
    const rendered = `      - uses: actions/checkout@${sha("1")} # v7.0.1\n`;
    expect(keepNewerPins(`      - uses: actions/checkout@${sha("2")}\n`, rendered)).toBe(rendered);
    expect(keepNewerPins("      - uses: actions/checkout@v8\n", rendered)).toBe(rendered);
  });

  it("matches each variant of an image on its own", () => {
    const rendered = `FROM node:24-alpine@${digest("a")}\nFROM node:24-slim@${digest("a")}\n`;
    // The higher slim pin must not hide the alpine one Dependabot refreshed, nor the other way round.
    const committed = `FROM node:24-alpine@${digest("b")}\nFROM node:24.3-slim@${digest("c")}\n`;
    expect(keepNewerPins(committed, rendered)).toBe(committed);
    expect(keepNewerPins(`FROM node:24.3-slim@${digest("c")}\n`, rendered)).toBe(
      `FROM node:24-alpine@${digest("a")}\nFROM node:24.3-slim@${digest("c")}\n`,
    );
  });

  it("uses the highest committed pin when the committed file names an image twice", () => {
    const committed = `FROM node:24-alpine@${digest("b")}\nFROM node:24.2-alpine@${digest("c")}\n`;
    const rendered = `FROM node:24-alpine@${digest("a")}\n`;
    expect(keepNewerPins(committed, rendered)).toBe(`FROM node:24.2-alpine@${digest("c")}\n`);
  });
});
