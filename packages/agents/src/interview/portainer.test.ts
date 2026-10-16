import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { QuestionSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { readPortainerConnection, recordPortainerConnection, serverAddressesFile } from "../shared";
import { createTestPhaseDeps } from "../testing";
import { splitFollowUps } from "./follow-ups";
import {
  answersToPortainer,
  buildPortainerQuestions,
  PORTAINER_FIELDS,
  type PortainerAccess,
  type PortainerCertificate,
  type PortainerEnvironment,
  type PortainerQuestion,
  recordPortainerAnswers,
} from "./portainer";
import type { InterviewAnswers } from "./questions";
import { runInterview } from "./run";

const splitPortainerAnswers = (answers: InterviewAnswers) =>
  splitFollowUps(answers, "portainer", PORTAINER_FIELDS);

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const URL_ = "https://nas.home.example.com:9443";
// Fingerprint-shaped values generated at runtime, never committed.
const digest = (seed: string) => createHash("sha256").update(seed).digest();
const CERT = `SHA256:${(digest("portainer cert").toString("hex").toUpperCase().match(/../g) ?? []).join(":")}`;
const CERT_HEX = `SHA256:${digest("portainer cert").toString("hex")}`;
const CERT_B64 = `SHA256:${digest("portainer cert").toString("base64").replace(/=+$/, "")}`;
const OTHER_CERT = `SHA256:${digest("another cert").toString("hex")}`;
const TOKEN = fakeSecret("generic-password", "portainer-token");

const ENVIRONMENTS: PortainerEnvironment[] = [
  { id: 3, name: "local", kind: "docker", up: true, arch: "arm64" },
  { id: 4, name: "swarm", kind: "swarm", up: true, arch: "amd64" },
  { id: 5, name: "edge-box", kind: "edge", up: true },
  { id: 6, name: "offline", kind: "docker", up: false },
  { id: 7, name: "k8s", kind: "kubernetes", up: true },
];

const BASE: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  uptime: "standard",
  provider: "portainer",
};

/** A fake Portainer: records every call and what it was sent. */
function fakeAccess(
  options: { fingerprint?: string; environments?: PortainerEnvironment[] } = {},
): PortainerAccess & { calls: string[]; tokens: string[] } {
  const calls: string[] = [];
  const tokens: string[] = [];
  return {
    calls,
    tokens,
    async fetchCertificateFingerprint(url) {
      calls.push(`fingerprint ${url}`);
      return options.fingerprint ?? CERT;
    },
    async listEnvironments(url, token, certFingerprint) {
      calls.push(`list ${url} ${certFingerprint ?? "-"}`);
      tokens.push(token);
      return options.environments ?? ENVIRONMENTS;
    },
  };
}

async function deps(token: string | undefined = TOKEN) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-portainer-interview-"));
  await materializeFixture(join(examples, "static-vite"), root);
  const env = {
    OPSCREW_HOME: join(root, ".home-opscrew"),
    ...(token !== undefined ? { PORTAINER_API_KEY: token } : {}),
  };
  return createTestPhaseDeps({ root, env });
}

const split = (portainer: Record<string, unknown>) => splitPortainerAnswers({ portainer });
const listed = { url: URL_, certFingerprint: CERT, environments: ENVIRONMENTS };
const onCloudflare = { cloudflareDomain: true, domain: "app.example.com" };

describe("questions for an existing Portainer", () => {
  it("asks for the address, environment, redeploy and web modes and the port, never a token", () => {
    const questions = buildPortainerQuestions(onCloudflare);
    expect(questions.map((q) => q.id)).toEqual([
      "portainer.url",
      "portainer.environment",
      "portainer.redeploy",
      "portainer.web",
      "portainer.port",
    ]);
    for (const question of questions) {
      // Same shape as every other interview question.
      expect(QuestionSchema.safeParse({ ...question, id: "notes" }).success, question.id).toBe(
        true,
      );
    }
    const byId = (id: PortainerQuestion["id"]) => questions.find((q) => q.id === id);
    expect(byId("portainer.url")).toMatchObject({
      prompt: "What is your Portainer's address?",
      help: "The address you open Portainer at, for example https://nas.local:9443. OpsCrew connects over HTTPS and asks you to confirm Portainer's certificate the first time; plain http:// works only for a Portainer on this computer. OpsCrew keeps the address on this computer only, never in your repository. The access token comes from the PORTAINER_API_KEY environment variable, never from an answer.",
      kind: "text",
      required: true,
    });
    expect(byId("portainer.environment")).toMatchObject({
      prompt: "Which Portainer environment should run the app?",
      kind: "text",
    });
    expect(byId("portainer.redeploy")).toMatchObject({
      prompt: "How should new versions reach Portainer?",
      default: "updater",
      options: [
        { value: "updater", label: "Portainer fetches them itself (recommended)" },
        { value: "cloudflare", label: "GitHub Actions calls Portainer through Cloudflare Access" },
      ],
    });
    expect(byId("portainer.web")).toMatchObject({
      prompt: "How should visitors reach the app?",
      default: "tunnel",
      options: [
        { value: "tunnel", label: "Through a Cloudflare Tunnel (recommended)" },
        { value: "proxy", label: "Through your own reverse proxy" },
        { value: "caddy", label: "Through Caddy on ports 80 and 443" },
      ],
    });
    expect(byId("portainer.port")).toMatchObject({
      prompt: "Which port of your host should the app listen on?",
      default: "8080",
      required: false,
    });
    expect(JSON.stringify(questions)).not.toMatch(/enter (your|the) (password|token)/i);
  });

  it("offers only what the domain allows: proxy by default without Cloudflare, no Caddy without a domain", () => {
    const options = (questions: PortainerQuestion[], id: PortainerQuestion["id"]) =>
      questions.find((q) => q.id === id)?.options?.map((o) => o.value);
    const elsewhere = buildPortainerQuestions({
      cloudflareDomain: false,
      domain: "app.example.com",
    });
    expect(options(elsewhere, "portainer.web")).toEqual(["proxy", "caddy"]);
    expect(elsewhere.find((q) => q.id === "portainer.web")?.default).toBe("proxy");
    expect(options(elsewhere, "portainer.redeploy")).toEqual(["updater"]);
    const none = buildPortainerQuestions({ cloudflareDomain: false });
    expect(options(none, "portainer.web")).toEqual(["proxy"]);
  });

  it("lists the usable environments once Portainer listed them, and pre-fills earlier answers", () => {
    const previous = {
      url: URL_,
      certFingerprint: CERT,
      environmentId: 3,
      environmentName: "local",
      arch: "arm64" as const,
      redeploy: "cloudflare" as const,
      web: { mode: "proxy" as const, port: 8090 },
      created: { stacks: [], volumes: [] },
    };
    const questions = buildPortainerQuestions({
      ...onCloudflare,
      previous,
      environments: ENVIRONMENTS,
    });
    const environment = questions.find((q) => q.id === "portainer.environment");
    expect(environment).toMatchObject({
      kind: "single-select",
      default: "3",
      options: [{ value: "3", label: "local", hint: "Docker, arm64" }],
    });
    expect(questions.find((q) => q.id === "portainer.url")?.default).toBe(URL_);
    expect(questions.find((q) => q.id === "portainer.redeploy")?.default).toBe("cloudflare");
    expect(questions.find((q) => q.id === "portainer.web")?.default).toBe("proxy");
    expect(questions.find((q) => q.id === "portainer.port")?.default).toBe("8090");
  });
});

describe("answersToPortainer", () => {
  it("takes flat and nested answers, the environment by id or name, and the defaults", () => {
    const flat = answersToPortainer(
      splitPortainerAnswers({ "portainer.environment": "3", "portainer.web": "Caddy" }),
      { ...listed, ...onCloudflare },
    );
    expect(flat).toEqual({
      url: URL_,
      certFingerprint: CERT,
      environmentId: 3,
      environmentName: "local",
      arch: "arm64",
      redeploy: "updater",
      web: { mode: "caddy" },
    });
    // The only usable environment is the default; the tunnel is the default on Cloudflare.
    expect(answersToPortainer(split({}), { ...listed, ...onCloudflare })).toMatchObject({
      environmentId: 3,
      web: { mode: "tunnel" },
    });
    expect(
      answersToPortainer(split({ environment: "LOCAL", web: "proxy", port: "8080" }), listed).web,
    ).toEqual({ mode: "proxy", port: 8080 });
  });

  it("refuses environments OpsCrew cannot deploy to, naming why", () => {
    const refuse = (environment: string, why: RegExp) =>
      expect(() =>
        answersToPortainer(split({ environment }), { ...listed, ...onCloudflare }),
      ).toThrow(why);
    refuse(
      "swarm",
      /"swarm" is a Docker Swarm environment; OpsCrew deploys only to a single Docker host/,
    );
    refuse("5", /"edge-box" is an Edge agent environment, which OpsCrew does not support yet/);
    refuse("offline", /Portainer reports "offline" as down/);
    refuse("k8s", /"k8s" is a Kubernetes environment/);
    refuse(
      "nope",
      /Portainer has no environment "nope" for this token \(it lists local \(3, Docker\)/,
    );
    const unknownArch = [{ id: 9, name: "nas", kind: "docker", up: true } as const];
    expect(() =>
      answersToPortainer(split({}), { ...listed, environments: unknownArch, ...onCloudflare }),
    ).toThrow(/could not read the CPU architecture of "nas"/);
  });

  it("refuses the tunnel and the Cloudflare redeploy without a Cloudflare domain, Caddy without a domain", () => {
    const off = { ...listed, cloudflareDomain: false, domain: "app.example.com" };
    expect(() => answersToPortainer(split({ web: "tunnel", port: 8080 }), off)).toThrow(
      /portainer\.web: tunnel needs the app's domain on Cloudflare/,
    );
    expect(() => answersToPortainer(split({ redeploy: "cloudflare", web: "caddy" }), off)).toThrow(
      /portainer\.redeploy: cloudflare needs the app's domain on Cloudflare/,
    );
    expect(() =>
      answersToPortainer(split({ web: "caddy" }), { ...listed, cloudflareDomain: false }),
    ).toThrow(/portainer\.web: caddy needs a domain/);
    expect(() => answersToPortainer(split({ web: "proxy" }), off)).toThrow(
      /portainer\.port \(the port of your host your reverse proxy routes to\) is missing/,
    );
    expect(() => answersToPortainer(split({ web: "proxy", port: "99999" }), off)).toThrow(
      /portainer\.port: write a port number from 1 to 65535/,
    );
    expect(() => answersToPortainer(split({ web: "nginx" }), off)).toThrow(
      /portainer\.web: answer tunnel, proxy or caddy/,
    );
  });

  it("refuses a domain Cloudflare would serve more than one level below its zone through the tunnel", () => {
    const deep = { ...listed, cloudflareDomain: true, domain: "api.shop.example.com" };
    expect(() => answersToPortainer(split({ web: "tunnel" }), deep)).toThrow(
      /api\.shop\.example\.com would fail HTTPS at Cloudflare's edge; use a name one level below example\.com, such as api-shop\.example\.com, or serve it with Caddy or your own reverse proxy and DNS only/,
    );
    // Caddy and the user's proxy are DNS only, with their own certificates.
    expect(answersToPortainer(split({ web: "caddy" }), deep).web).toEqual({ mode: "caddy" });
  });

  it("refuses a token or password given as an answer, never echoing it", () => {
    for (const key of ["token", "apiKey", "password"]) {
      let error: unknown;
      try {
        answersToPortainer(split({ [key]: TOKEN }), listed);
      } catch (e) {
        error = e;
      }
      expect(error, key).toMatchObject({ code: "INVALID_INPUT" });
      expect(String((error as Error).message)).toContain("PORTAINER_API_KEY");
      expect(String((error as Error).message)).not.toContain(TOKEN);
    }
  });

  it("reuses the earlier environment only for the same Portainer address", () => {
    const two: PortainerEnvironment[] = [
      { id: 3, name: "local", kind: "docker", up: true, arch: "arm64" },
      { id: 9, name: "nas", kind: "docker", up: true, arch: "amd64" },
    ];
    const previous = {
      url: URL_,
      environmentId: 9,
      environmentName: "nas",
      created: { stacks: [], volumes: [] },
    };
    const same = { ...listed, environments: two, previous, web: undefined };
    expect(answersToPortainer(split({ web: "proxy", port: 8080 }), same).environmentId).toBe(9);
    const other = { ...same, url: "https://other.example.com:9443" };
    expect(() => answersToPortainer(split({ web: "proxy", port: 8080 }), other)).toThrow(
      /portainer\.environment \(which environment runs the app\) is missing/,
    );
    const env = (url: string) =>
      buildPortainerQuestions({ previous, url, environments: two }).find(
        (q) => q.id === "portainer.environment",
      )?.default;
    expect(env(URL_)).toBe("9");
    expect(env("https://other.example.com:9443")).toBe("3");
    expect(
      buildPortainerQuestions({ previous, url: "https://other.example.com:9443" }).find(
        (q) => q.id === "portainer.environment",
      )?.default,
    ).toBeUndefined();
  });

  it("offers only environments OpsCrew can deploy to", () => {
    const environments: PortainerEnvironment[] = [
      ...ENVIRONMENTS,
      { id: 10, name: "no-arch", kind: "docker", up: true },
      { id: 11, name: "s390x", kind: "docker", up: true, arch: "other" },
    ];
    const question = buildPortainerQuestions({ environments }).find(
      (q) => q.id === "portainer.environment",
    );
    expect(question?.options?.map((o) => o.label)).toEqual(["local"]);
  });
});

describe("runInterview with an existing Portainer", () => {
  it("confirms the certificate, lists the environments and saves the answers locally, never the token", async () => {
    const d = await deps();
    const access = fakeAccess();
    const confirmed: PortainerCertificate[] = [];
    const result = await runInterview(d, {
      answers: {
        ...BASE,
        domain: "app.example.com",
        dnsProvider: "cloudflare",
        portainer: { url: `${URL_}/`, environment: "local" },
      },
      portainer: {
        access,
        confirmCertificate: async (certificate) => {
          confirmed.push(certificate);
          return true;
        },
      },
    });
    expect(confirmed).toEqual([{ fingerprint: CERT }]);
    expect(access.calls).toEqual([`fingerprint ${URL_}`, `list ${URL_} ${CERT}`]);
    expect(access.tokens).toEqual([TOKEN]);
    expect(result.portainer).toEqual({
      url: URL_,
      certFingerprint: CERT,
      environmentId: 3,
      environmentName: "local",
      arch: "arm64",
      redeploy: "updater",
      web: { mode: "tunnel" },
    });
    expect(await readPortainerConnection(d.paths)).toEqual({
      ...result.portainer,
      created: { stacks: [], volumes: [] },
    });
    const requirements = await readFile(d.paths.files.requirements, "utf8");
    expect(requirements).toMatch(/provider: portainer/);
    expect(requirements).not.toMatch(/nas\.home|9443|local|tunnel|updater|region/);
    expect((await readArtifact("requirements", d.paths.files.requirements)).region).toBeUndefined();
    const record = await readFile(serverAddressesFile(d.paths), "utf8");
    expect(record).not.toContain(TOKEN);
    expect((await d.state.read()).phases.interview?.summary).toMatch(/your Portainer/);
    expect((await d.state.read()).phases.interview?.summary).not.toContain("nas.home");
    expect(d.reporter.text()).not.toContain(TOKEN);
    expect(d.redactor.redact(`token ${TOKEN}`)).not.toContain(TOKEN);
  });

  it("asks the address first, then the rest with the listed environments", async () => {
    const d = await deps();
    const asked: string[][] = [];
    const result = await runInterview(d, {
      answers: { ...BASE },
      askPortainer: async (questions) => {
        asked.push(questions.map((q) => q.id));
        if (questions[0]?.id === "portainer.url") return { "portainer.url": URL_ };
        expect(questions.find((q) => q.id === "portainer.environment")?.kind).toBe("single-select");
        return { "portainer.environment": "3", "portainer.web": "proxy", "portainer.port": "8081" };
      },
      portainer: { access: fakeAccess(), certFingerprint: CERT_HEX },
    });
    expect(asked).toEqual([
      ["portainer.url"],
      ["portainer.environment", "portainer.redeploy", "portainer.web", "portainer.port"],
    ]);
    expect(result.portainer?.web).toEqual({ mode: "proxy", port: 8081 });
  });

  it("changes nothing when the certificate is not confirmed, does not match, or the token is missing", async () => {
    const answers = {
      ...BASE,
      portainer: { url: URL_, environment: "local", web: "proxy", port: 8080 },
    };
    const declined = await deps();
    const access = fakeAccess();
    await expect(
      runInterview(declined, {
        answers,
        portainer: { access, confirmCertificate: async () => false },
      }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "You did not confirm Portainer's certificate, so OpsCrew sent nothing and saved nothing.",
    });
    // The token was never sent.
    expect(access.tokens).toEqual([]);
    await expect(readFile(declined.paths.files.requirements, "utf8")).rejects.toThrow();
    expect(await readPortainerConnection(declined.paths)).toBeUndefined();

    const mismatch = await deps();
    await expect(
      runInterview(mismatch, { answers, portainer: { access, certFingerprint: OTHER_CERT } }),
    ).rejects.toThrow(
      /Portainer answers with the certificate SHA256:.* not the SHA256:.* you gave/,
    );

    const unattended = await deps();
    await expect(runInterview(unattended, { answers, portainer: { access } })).rejects.toThrow(
      /OpsCrew must confirm Portainer's certificate before it sends the token\. Its fingerprint is SHA256:/,
    );

    const tokenless = await deps("");
    await expect(runInterview(tokenless, { answers, portainer: { access } })).rejects.toMatchObject(
      {
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("PORTAINER_API_KEY"),
      },
    );
    expect(access.tokens).toEqual([]);
  });

  it("refuses plain HTTP to another computer and needs no certificate on this one", async () => {
    const d = await deps();
    await expect(
      runInterview(d, {
        answers: { ...BASE, portainer: { url: "http://nas.lan:9000", web: "proxy", port: 8080 } },
        portainer: { access: fakeAccess() },
      }),
    ).rejects.toThrow(/OpsCrew sends the access token only over HTTPS/);
    const access = fakeAccess();
    const local = await runInterview(d, {
      answers: { ...BASE, portainer: { url: "http://localhost:9000", web: "proxy", port: 8080 } },
      portainer: { access },
    });
    expect(access.calls).toEqual(["list http://localhost:9000 -"]);
    expect(local.portainer?.certFingerprint).toBeUndefined();
  });

  it("refuses a malformed fingerprint given up front before connecting, and accepts other spellings", async () => {
    const d = await deps();
    const access = fakeAccess();
    const answers = { ...BASE, portainer: { url: URL_, web: "proxy", port: 8080 } };
    await expect(
      runInterview(d, { answers, portainer: { access, certFingerprint: "SHA256:abcd" } }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("is not a SHA-256 fingerprint"),
    });
    expect(access.calls).toEqual([]);
    const lower = await runInterview(d, {
      answers,
      portainer: { access, certFingerprint: `${CERT_B64.replace("SHA256:", "sha256:")}=` },
    });
    expect(lower.portainer?.certFingerprint).toBe(CERT);
  });

  it("refuses a changed pinned certificate without a confirmation, sending no token", async () => {
    const d = await deps();
    const answers = { ...BASE, portainer: { url: URL_, web: "proxy", port: 8080 } };
    await runInterview(d, { answers, portainer: { access: fakeAccess(), certFingerprint: CERT } });
    const changed = fakeAccess({ fingerprint: OTHER_CERT });
    await expect(
      runInterview(d, { answers, portainer: { access: changed } }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `Portainer's certificate changed from ${CERT} to ${OTHER_CERT}, so OpsCrew sent nothing.`,
    });
    expect(changed.tokens).toEqual([]);
    expect((await readPortainerConnection(d.paths))?.certFingerprint).toBe(CERT);
  });

  it("names only what the record lists when it refuses another environment", async () => {
    const d = await deps();
    await recordPortainerConnection(d.paths, {
      url: URL_,
      environmentId: 3,
      environmentName: "local",
      created: { stacks: [], registryId: 2, volumes: ["opscrew-app_pgdata", "opscrew-app_caddy"] },
    });
    const error = await recordPortainerAnswers(d.paths, {
      url: URL_,
      environmentId: 8,
      environmentName: "other",
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "proxy", port: 8080 },
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain(
      'OpsCrew\'s record lists a registry entry and 2 volumes it created in the Portainer environment "local"',
    );
    expect((error as Error).message).not.toMatch(/0 stacks/);
  });

  it("checks a pinned certificate silently and asks again when it changed", async () => {
    const d = await deps();
    const answers = { ...BASE, portainer: { url: URL_, web: "proxy", port: 8080 } };
    await runInterview(d, { answers, portainer: { access: fakeAccess(), certFingerprint: CERT } });
    const asked: PortainerCertificate[] = [];
    const confirm = async (certificate: PortainerCertificate) => {
      asked.push(certificate);
      return true;
    };
    // The same certificate (in another spelling) is checked without asking.
    await runInterview(d, {
      answers,
      portainer: { access: fakeAccess({ fingerprint: CERT_B64 }), confirmCertificate: confirm },
    });
    expect(asked).toEqual([]);
    await runInterview(d, {
      answers,
      portainer: { access: fakeAccess({ fingerprint: OTHER_CERT }), confirmCertificate: confirm },
    });
    expect(asked).toEqual([{ fingerprint: OTHER_CERT, previous: CERT }]);
    expect((await readPortainerConnection(d.paths))?.certFingerprint).toBe(OTHER_CERT);
  });

  it("keeps what OpsCrew created for the same environment and refuses to forget it for another", async () => {
    const d = await deps();
    const created = {
      stacks: [{ id: 12, name: "opscrew-static-vite", role: "app" as const }],
      volumes: [],
    };
    await recordPortainerConnection(d.paths, {
      url: URL_,
      certFingerprint: CERT,
      environmentId: 3,
      environmentName: "local",
      created,
    });
    const answers = { ...BASE, portainer: { web: "proxy", port: 8080 } };
    const access = fakeAccess();
    await runInterview(d, { answers, portainer: { access } });
    expect((await readPortainerConnection(d.paths))?.created).toEqual(created);

    const elsewhere = [{ id: 8, name: "other", kind: "docker", up: true, arch: "amd64" } as const];
    await expect(
      runInterview(d, {
        answers: { ...answers, portainer: { ...answers.portainer, environment: "8" } },
        portainer: { access: fakeAccess({ environments: [...ENVIRONMENTS, ...elsewhere] }) },
      }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        'OpsCrew\'s record lists a stack it created in the Portainer environment "local"',
      ),
    });
    expect((await readPortainerConnection(d.paths))?.environmentId).toBe(3);
  });

  it("stops on a damaged record instead of setting aside what OpsCrew created", async () => {
    const d = await deps();
    await mkdir(d.paths.stateDir, { recursive: true });
    await writeFile(
      serverAddressesFile(d.paths),
      JSON.stringify({ schemaVersion: 1, portainer: 1 }),
    );
    await expect(
      runInterview(d, {
        answers: { ...BASE, portainer: { url: URL_ } },
        portainer: { access: fakeAccess(), certFingerprint: CERT },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it("refuses a domain too deep for the tunnel before anything is written", async () => {
    const d = await deps();
    await expect(
      runInterview(d, {
        answers: {
          ...BASE,
          domain: "api.shop.example.com",
          dnsProvider: "cloudflare",
          portainer: { url: URL_ },
        },
        portainer: { access: fakeAccess(), certFingerprint: CERT },
      }),
    ).rejects.toThrow(/api\.shop\.example\.com would fail HTTPS at Cloudflare's edge/);
    await expect(readFile(d.paths.files.requirements, "utf8")).rejects.toThrow();
    expect(await readPortainerConnection(d.paths)).toBeUndefined();
  });

  it("ignores Portainer answers for another provider, with a warning", async () => {
    const d = await deps();
    const result = await runInterview(d, {
      answers: { ...BASE, provider: "hetzner", region: "eu-central", "portainer.url": URL_ },
    });
    expect(result.portainer).toBeUndefined();
    expect(d.reporter.text()).toMatch(/portainer\.\*\) were ignored/);
    expect(await readPortainerConnection(d.paths)).toBeUndefined();
  });
});
