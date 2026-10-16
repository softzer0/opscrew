import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PortainerAccess, PortainerEnvironment } from "@opscrew/agents";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withServices } from "../deps";
import {
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const HOST = "nas-portainer.home.arpa";
const URL_ = `https://${HOST}:9443`;
const FINGERPRINT = `SHA256:${Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(":")}`;
const OTHER_FINGERPRINT = `SHA256:${Array.from({ length: 32 }, () => "CD").join(":")}`;

/** A Portainer with one usable Docker environment and a Swarm one; records what was sent. */
function fakeAccess(fingerprint = FINGERPRINT) {
  const calls: { fingerprints: string[]; listed: { token: string; cert?: string }[] } = {
    fingerprints: [],
    listed: [],
  };
  const environments: PortainerEnvironment[] = [
    { id: 3, name: "nas", kind: "docker", up: true, arch: "arm64" },
    { id: 4, name: "cluster", kind: "swarm", up: true },
  ];
  const access: PortainerAccess = {
    fetchCertificateFingerprint: async (url) => {
      calls.fingerprints.push(url);
      return fingerprint;
    },
    listEnvironments: async (_url, token, cert) => {
      calls.listed.push({ token, ...(cert === undefined ? {} : { cert }) });
      return environments;
    },
  };
  return { access, calls };
}

const ANSWERS = [
  "provider: portainer",
  "expectedMonthlyUsers: <1k",
  "budgetMonthly: 10 EUR",
  "uptime: standard",
  "dataCriticality: important",
  "domain: shop.example.com",
  "dnsProvider: cloudflare",
  `portainer.url: ${URL_}`,
  "portainer.environment: nas",
  "portainer.redeploy: updater",
  "portainer.web: tunnel",
  "",
].join("\n");

async function setup(token: string) {
  project = await tempProject("nextjs-postgres");
  project.env.PORTAINER_API_KEY = token;
  const answers = path.join(project.dir, "answers.yaml");
  await writeFile(answers, ANSWERS);
  return { project, answers };
}

async function serverJson(p: TempProject) {
  const paths = resolveProjectPaths(p.root, { env: p.env });
  return JSON.parse(await readFile(path.join(paths.stateDir, "server.json"), "utf8"));
}

describe("opscrew interview for an existing Portainer", () => {
  it("trusts the certificate given with --portainer-cert in a script and keeps the address local", async () => {
    const token = fakeSecret("generic-password", "portainer-token");
    const { project: p, answers } = await setup(token);
    const ctx = projectContext(p);
    const { access, calls } = fakeAccess();
    withServices(ctx, { portainerAccess: access });
    // Any spelling of the fingerprint works (here: hex without colons).
    const spelled = FINGERPRINT.replace(/:/g, "").replace("SHA256", "SHA256:").toLowerCase();
    expect(
      await run(ctx, "interview", "--answers", answers, "--portainer-cert", spelled),
      ctx.errors,
    ).toBe(0);

    expect(calls.listed).toEqual([{ token, cert: FINGERPRINT }]);
    const requirements = parse(
      await readFile(resolveProjectPaths(p.root, { env: p.env }).files.requirements, "utf8"),
    );
    expect(requirements.provider).toBe("portainer");
    expect(JSON.stringify(requirements)).not.toContain(HOST);
    const local = await serverJson(p);
    expect(local.portainer).toMatchObject({
      url: URL_,
      certFingerprint: FINGERPRINT,
      environmentId: 3,
      environmentName: "nas",
    });
    expect(JSON.stringify(local)).not.toContain(token);
    expect(ctx.output).toContain("your existing Portainer");
    expect(ctx.output).toContain("opscrew design");
    for (const text of [ctx.output, ctx.errors]) {
      expect(text).not.toContain(HOST);
      expect(text).not.toContain(token);
    }
  });

  it("refuses a script without --portainer-cert, naming the fingerprint to check", async () => {
    const { project: p, answers } = await setup(fakeSecret("generic-password", "portainer-token"));
    const ctx = projectContext(p);
    const { access, calls } = fakeAccess();
    withServices(ctx, { portainerAccess: access });
    expect(await run(ctx, "interview", "--answers", answers)).not.toBe(0);
    expect(calls.listed).toEqual([]);
    expect(ctx.errors).toContain(FINGERPRINT);
    expect(ctx.errors).toContain("--portainer-cert");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(HOST);
  });

  it("refuses a --portainer-cert that does not match, and one that is not a fingerprint", async () => {
    const { project: p, answers } = await setup(fakeSecret("generic-password", "portainer-token"));
    const ctx = projectContext(p);
    const { access, calls } = fakeAccess();
    withServices(ctx, { portainerAccess: access });
    expect(
      await run(ctx, "interview", "--answers", answers, "--portainer-cert", OTHER_FINGERPRINT),
    ).not.toBe(0);
    expect(calls.listed).toEqual([]);
    expect(ctx.errors).toContain("not the");

    const bad = projectContext(p);
    withServices(bad, { portainerAccess: access });
    expect(await run(bad, "interview", "--answers", answers, "--portainer-cert", "abc")).toBe(2);
    expect(bad.errors).toContain("--portainer-cert expects");
  });

  it("asks the Portainer questions in a terminal and has the user confirm the certificate", async () => {
    const token = fakeSecret("generic-password", "portainer-token");
    project = await tempProject("nextjs-postgres");
    project.env.PORTAINER_API_KEY = token;
    const asked: { kind: string; message: string; options?: string[] }[] = [];
    const answer = (kind: string, message: string, initial: unknown, options?: string[]) => {
      asked.push({ kind, message: message.split("\n")[0] ?? "", ...(options ? { options } : {}) });
      if (message.includes("Where should OpsCrew run your app?")) return "portainer";
      if (message.includes("Portainer's address")) return URL_;
      if (message.startsWith("Trust this certificate")) return true;
      if (message.includes("Which Portainer environment")) return "3";
      if (message.includes("How should visitors reach the app?")) return "proxy";
      if (message.includes("Which port of your host")) return "8088";
      if (message.toLowerCase().includes("budget")) return "10 EUR";
      if (message.toLowerCase().includes("domain")) return "";
      return initial ?? "";
    };
    const prompts = new ScriptedPrompts([]);
    const fake = {
      ...prompts,
      isCancel: prompts.isCancel.bind(prompts),
      password: prompts.password.bind(prompts),
      select: async (o: { message: string; options: { value: string }[]; initialValue?: string }) =>
        answer(
          "select",
          o.message,
          o.initialValue ?? o.options[0]?.value,
          o.options.map((option) => option.value),
        ) as string,
      multiselect: async (o: { message: string; initialValues?: string[] }) =>
        answer("multiselect", o.message, o.initialValues ?? []) as string[],
      text: async (o: { message: string; initialValue?: string }) =>
        answer("text", o.message, o.initialValue) as string,
      confirm: async (o: { message: string; initialValue?: boolean }) =>
        answer("confirm", o.message, o.initialValue) as boolean,
    };
    const ctx = projectContext(project, { interactive: true, services: { prompts: fake } });
    const { access, calls } = fakeAccess();
    withServices(ctx, { portainerAccess: access });
    expect(await run(ctx, "interview"), ctx.errors).toBe(0);

    const messages = asked.map((item) => item.message);
    const trust = messages.findIndex((message) => message.startsWith("Trust this certificate"));
    const address = messages.findIndex((message) => message.includes("Portainer's address"));
    const environment = messages.findIndex((m) => m.includes("Which Portainer environment"));
    expect(address).toBeGreaterThanOrEqual(0);
    // The address first, then the certificate, then the environments Portainer listed.
    expect(trust).toBeGreaterThan(address);
    expect(environment).toBeGreaterThan(trust);
    expect(asked[environment]?.options).toEqual(["3"]);
    expect(ctx.output).toContain(FINGERPRINT);
    expect(calls.listed).toEqual([{ token, cert: FINGERPRINT }]);
    const local = await serverJson(project);
    expect(local.portainer).toMatchObject({
      certFingerprint: FINGERPRINT,
      environmentId: 3,
      web: { mode: "proxy", port: 8088 },
    });
    expect(ctx.output).not.toContain(HOST);
  });

  it("trusts nothing and saves nothing when the user declines the certificate", async () => {
    project = await tempProject("nextjs-postgres");
    project.env.PORTAINER_API_KEY = fakeSecret("generic-password", "portainer-token");
    await writeFile(path.join(project.dir, "answers.yaml"), ANSWERS);
    const prompts = new ScriptedPrompts([false]);
    const ctx = projectContext(project, { interactive: true, services: { prompts } });
    const { access, calls } = fakeAccess();
    withServices(ctx, { portainerAccess: access });
    expect(
      await run(ctx, "interview", "--answers", path.join(project.dir, "answers.yaml")),
    ).not.toBe(0);
    expect(prompts.calls.map((call) => call.kind)).toEqual(["confirm"]);
    expect(calls.listed).toEqual([]);
    expect(ctx.errors).toContain("did not confirm");
  });
});
