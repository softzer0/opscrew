import { describe, expect, it } from "vitest";
import { detectProject } from "./detect";
import { makeTree, removeTree } from "./test-helpers";
import { dockerfileWorkdir } from "./workdir";

describe("dockerfileWorkdir", () => {
  it("reads the last WORKDIR of the last stage, resolving relative ones", () => {
    const text = [
      "FROM node:24 AS build",
      "WORKDIR /build",
      "RUN npm ci",
      "",
      "# The runtime stage.",
      "FROM node:24-slim",
      "WORKDIR /srv",
      "WORKDIR app/",
      "COPY --from=build /build ./",
      'CMD ["node", "server.js"]',
    ].join("\n");
    expect(dockerfileWorkdir(text)).toBe("/srv/app");
    expect(dockerfileWorkdir('FROM python:3.13\nworkdir "/opt/app"\n')).toBe("/opt/app");
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR /a\nWORKDIR ../b\n")).toBe("/b");
  });

  it("is unknown without a WORKDIR in the last stage, a relative one alone, or a variable", () => {
    expect(dockerfileWorkdir("FROM node:24 AS build\nWORKDIR /app\nFROM nginx\n")).toBeUndefined();
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR app\n")).toBeUndefined();
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR $APP_HOME\n")).toBeUndefined();
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR /srv\nWORKDIR $DIR/app\n")).toBeUndefined();
    // A later absolute WORKDIR is known again.
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR $APP\nWORKDIR /app\n")).toBe("/app");
  });

  it("is in the facts of an app with its own Dockerfile", async () => {
    const root = await makeTree(
      {
        "package.json": JSON.stringify({ name: "api", dependencies: { express: "^5.0.0" } }),
        Dockerfile: "FROM node:24-alpine\nWORKDIR /usr/src/app\nCOPY . .\nCMD node server.js\n",
      },
      "workdir",
    );
    try {
      expect((await detectProject(root)).build.workdir).toBe("/usr/src/app");
    } finally {
      await removeTree(root);
    }
  });
});
