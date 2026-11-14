// Feature 027 (T2710): the interview for a hosting account, its panel found without asking, and
// an SFTP host's key read with ssh-keyscan and confirmed.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeCpanel } from "@opscrew/connector-cpanel";
import { FakeDirectAdmin } from "@opscrew/connector-directadmin";
import { fakePlesk } from "@opscrew/connector-plesk";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { hostingRecordFile, readHostingRecord, updateHostingRecord } from "../hosting/record";
import { hostKeyFingerprint } from "../shared";
import { createTestPhaseDeps, ScriptedApprovalHandler, ScriptedRunner } from "../testing";
import { makeFacts } from "../testing/catalog";
import type { HostingQuestion } from "./hosting";
import { buildQuestions, type InterviewAnswers } from "./questions";
import { runInterview } from "./run";

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const TOKEN = fakeSecret("generic-password", "hosting-interview");
const HOST_KEY = Buffer.from("an SFTP host's ed25519 key, for tests only").toString("base64");
const FINGERPRINT = hostKeyFingerprint(HOST_KEY);

const BASE: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 5, currency: "EUR" },
  uptime: "standard",
  dataCriticality: "important",
  provider: "hosting",
};

/** A panel's host: `/` answers on `port` with `server`; every other request goes to `api`. */
function panelHost(port: number, server: string, api: FetchLike): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/") return api(input, init);
    if (Number(url.port) !== port) throw new TypeError("fetch failed: connection refused");
    return new Response("", { status: 200, headers: { server } });
  };
}

const PANEL_ENV = (url: string, user: string) => ({
  OPSCREW_HOSTING_URL: url,
  OPSCREW_HOSTING_USER: user,
  OPSCREW_HOSTING_TOKEN: TOKEN,
});

const SFTP_ENV = {
  OPSCREW_SFTP_HOST: "sftp.example.net",
  OPSCREW_SFTP_USER: "deploy",
  OPSCREW_SFTP_KEY: "/home/me/.ssh/id_ed25519",
};

/** `ssh-keyscan` answering with the host's key; every other command succeeds silently. */
function keyscan(key = HOST_KEY) {
  return new ScriptedRunner((command, args) => {
    if (command !== "ssh-keyscan") return { exitCode: 0, stdout: "", stderr: "" };
    const port = args[args.indexOf("-p") + 1];
    const host = args.at(-1) ?? "";
    const name = port === "22" ? host : `[${host}]:${port}`;
    return {
      exitCode: 0,
      stdout: `# ${host}:${port} SSH-2.0-OpenSSH_9.6\n${name} ssh-ed25519 ${key}\n`,
      stderr: "",
    };
  });
}

/** A plain PHP app with MySQL, analysed afresh by the interview. */
async function project(
  env: Record<string, string>,
  options: Partial<Parameters<typeof createTestPhaseDeps>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-hosting-interview-"));
  await materializeFixture(join(examples, "php-plain-mysql"), root);
  return createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew"), ...env },
    ...options,
  });
}

/** Every file the interview wrote and everything it said, which must never show the token. */
async function written(deps: Awaited<ReturnType<typeof project>>): Promise<string> {
  const files = await Promise.all(
    [deps.paths.files.requirements, hostingRecordFile(deps.paths)].map((file) =>
      readFile(file, "utf8").catch(() => ""),
    ),
  );
  return [...files, deps.reporter.text()].join("\n");
}

describe("the provider question", () => {
  it("offers a hosting account only when the environment reaches one", () => {
    const options = (hosting: boolean) =>
      buildQuestions(makeFacts(), undefined, [], hosting ? { hosting } : {})
        .find((question) => question.id === "provider")
        ?.options?.map((option) => option.value);
    expect(options(true)).toContain("hosting");
    expect(options(false)).not.toContain("hosting");
  });

  it("stops plainly when a hosting account is chosen without its variables", async () => {
    const deps = await project({});
    const error = await runInterview(deps, {
      answers: { ...BASE, domain: "notes.example.com" },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.hint).toContain(
      "OPSCREW_HOSTING_URL, OPSCREW_HOSTING_USER and OPSCREW_HOSTING_TOKEN",
    );
  });
});

describe("a hosting account with a panel", () => {
  it("finds cPanel without asking, takes the hostname as the domain and records the account", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com" });
    const deps = await project(PANEL_ENV("https://panel.example.com", "acct"), {
      fetch: panelHost(2083, "cpsrvd/11.130.0.4", fake.fetch),
    });
    const asked: HostingQuestion[][] = [];
    const providerOptions: unknown[] = [];
    const result = await runInterview(deps, {
      ask: async (questions) => {
        providerOptions.push(questions.find((q) => q.id === "provider")?.options);
        return { ...BASE, domain: "" };
      },
      askHosting: async (questions) => {
        asked.push(questions);
        return { "hosting.hostname": "Notes.Example.com" };
      },
    });
    expect(JSON.stringify(providerOptions)).toContain('"value":"hosting"');
    expect(asked.map((questions) => questions.map((q) => q.id))).toEqual([["hosting.hostname"]]);
    expect(asked[0]?.[0]?.help).toContain("(example.com), such as app.example.com");
    expect(result.requirements).toMatchObject({
      provider: "hosting",
      domain: "notes.example.com",
      dnsProvider: "other",
    });
    expect(result.requirements.region).toBeUndefined();
    expect(await readHostingRecord(deps.paths)).toEqual({
      schemaVersion: 1,
      panel: { kind: "cpanel", url: "https://panel.example.com:2083", user: "acct" },
      objects: [],
    });
    // Only reads reached the account.
    expect(fake.state.domains.map((domain) => domain.name)).toEqual(["example.com"]);
    const text = await written(deps);
    expect(text).toContain("Saved how to reach your hosting account in .opscrew/hosting.json");
    expect(text).not.toContain(TOKEN);
  });

  it("refuses a hostname the account serves already, unless OpsCrew made it", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com" });
    fake.state.domains.push({ name: "shop.example.com", kind: "subdomain", documentRoot: "shop" });
    const deps = await project(PANEL_ENV("https://panel.example.com:2083", "acct"), {
      fetch: panelHost(2083, "cpsrvd", fake.fetch),
    });
    const answers = { ...BASE, domain: "shop.example.com", dnsProvider: "cloudflare" };
    await expect(runInterview(deps, { answers })).rejects.toThrow(
      "hosting.hostname: the account already serves shop.example.com, and OpsCrew never takes over a hostname it didn't make.",
    );
    await updateHostingRecord(deps.paths, () => ({
      schemaVersion: 1,
      panel: { kind: "cpanel", url: "https://panel.example.com:2083", user: "acct" },
      objects: [{ kind: "hostname", key: "shop.example.com" }],
    }));
    const result = await runInterview(deps, { answers });
    expect(result.requirements).toMatchObject({
      domain: "shop.example.com",
      dnsProvider: "cloudflare",
    });
    // The objects OpsCrew made stay recorded.
    expect((await readHostingRecord(deps.paths))?.objects).toEqual([
      { kind: "hostname", key: "shop.example.com" },
    ]);
  });

  it("stops when the record lists objects on another account", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN });
    const deps = await project(PANEL_ENV("https://panel.example.com", "acct"), {
      fetch: panelHost(2083, "cpsrvd", fake.fetch),
    });
    await updateHostingRecord(deps.paths, () => ({
      schemaVersion: 1,
      panel: { kind: "cpanel", url: "https://old.example.org:2083", user: "acct" },
      objects: [{ kind: "cron", key: "3" }],
    }));
    await expect(
      runInterview(deps, { answers: { ...BASE, domain: "notes.example.com" } }),
    ).rejects.toThrow("OpsCrew made objects for this app on another hosting account");
  });

  it("finds Plesk on 8443", async () => {
    const fake = fakePlesk({ token: TOKEN });
    const deps = await project(PANEL_ENV("https://plesk.example.test", fake.login), {
      fetch: panelHost(8443, "sw-cp-server", fake.fetch),
    });
    await runInterview(deps, {
      answers: { ...BASE, domain: "notes.example.com", "hosting.hostname": "notes.example.com" },
    });
    expect((await readHostingRecord(deps.paths))?.panel).toEqual({
      kind: "plesk",
      url: "https://plesk.example.test:8443",
      user: fake.login,
    });
  });

  it("on Plesk given SFTP access too, has the SFTP host's key confirmed and pins it", async () => {
    const fake = fakePlesk({ token: TOKEN });
    const runner = keyscan();
    const deps = await project(
      { ...PANEL_ENV("https://plesk.example.test", fake.login), ...SFTP_ENV },
      { fetch: panelHost(8443, "sw-cp-server", fake.fetch), runner },
    );
    const answers = {
      ...BASE,
      domain: "notes.example.com",
      "hosting.hostname": "notes.example.com",
    };
    // Nobody confirmed it yet: refused, nothing recorded or pinned.
    const unconfirmed = await runInterview(deps, { answers }).catch((e) => e);
    expect(unconfirmed.code).toBe("PHASE_PRECONDITION");
    expect(unconfirmed.hint).toContain(`answer hosting.hostKey: ${FINGERPRINT}`);
    expect(await readHostingRecord(deps.paths)).toBeUndefined();
    await runInterview(deps, { answers: { ...answers, "hosting.hostKey": FINGERPRINT } });
    expect(runner.calls.find((call) => call.command === "ssh-keyscan")?.args).toEqual([
      "-T",
      "10",
      "-p",
      "22",
      "-t",
      "ed25519,ecdsa,rsa",
      "sftp.example.net",
    ]);
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(
      `sftp.example.net ssh-ed25519 ${HOST_KEY}\n`,
    );
    expect((await readHostingRecord(deps.paths))?.panel?.kind).toBe("plesk");
    // Pinned now: a run again takes it without the answer, and a changed key stops.
    await runInterview(deps, { answers });
    const changed = await createTestPhaseDeps({
      root: deps.paths.root,
      env: {
        OPSCREW_HOME: join(deps.paths.root, ".home-opscrew"),
        ...PANEL_ENV("https://plesk.example.test", fake.login),
        ...SFTP_ENV,
      },
      fetch: panelHost(8443, "sw-cp-server", fake.fetch),
      runner: keyscan(Buffer.from("new").toString("base64")),
    });
    await expect(runInterview(changed, { answers })).rejects.toThrow(
      "changed since you confirmed it",
    );
  });

  it("on cPanel, whose API writes files, reads no SFTP host key", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com" });
    const runner = keyscan();
    const deps = await project(
      { ...PANEL_ENV("https://panel.example.com", "acct"), ...SFTP_ENV },
      { fetch: panelHost(2083, "cpsrvd/11.130.0.4", fake.fetch), runner },
    );
    await runInterview(deps, {
      answers: { ...BASE, domain: "notes.example.com", "hosting.hostname": "notes.example.com" },
    });
    expect(runner.calls.map((call) => call.command)).not.toContain("ssh-keyscan");
    expect(await readFile(deps.paths.files.knownHosts, "utf8").catch(() => "")).toBe("");
  });

  it("finds DirectAdmin on 2222", async () => {
    const fake = new FakeDirectAdmin({ token: TOKEN, domains: ["example.org"] });
    const deps = await project(PANEL_ENV("https://panel.example.test", fake.access.user), {
      fetch: panelHost(2222, "DirectAdmin Daemon v1.680", fake.fetch),
    });
    const result = await runInterview(deps, {
      answers: { ...BASE, hosting: { hostname: "notes.example.org" } },
    });
    expect(result.requirements.domain).toBe("notes.example.org");
    expect((await readHostingRecord(deps.paths))?.panel).toEqual({
      kind: "directadmin",
      url: "https://panel.example.test:2222",
      user: fake.access.user,
    });
  });
});

describe("an SFTP host", () => {
  const SFTP_ANSWERS = {
    ...BASE,
    domain: "notes.example.net",
    "hosting.port": "2222",
    "hosting.folder": "opscrew",
    "hosting.phpPath": "/home/deploy/opscrew",
  };

  it("reads the host key with ssh-keyscan, takes the confirmed fingerprint and pins it", async () => {
    const runner = keyscan();
    const deps = await project(SFTP_ENV, { runner });
    const result = await runInterview(deps, {
      answers: { ...SFTP_ANSWERS, "hosting.hostKey": FINGERPRINT },
    });
    expect(runner.calls.find((call) => call.command === "ssh-keyscan")?.args).toEqual([
      "-T",
      "10",
      "-p",
      "2222",
      "-t",
      "ed25519,ecdsa,rsa",
      "sftp.example.net",
    ]);
    expect(result.requirements).toMatchObject({ provider: "hosting", domain: "notes.example.net" });
    expect(await readHostingRecord(deps.paths)).toEqual({
      schemaVersion: 1,
      sftp: {
        host: "sftp.example.net",
        port: 2222,
        user: "deploy",
        hostKey: FINGERPRINT,
        folder: "opscrew",
        phpPath: "/home/deploy/opscrew",
      },
      objects: [],
    });
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(
      `[sftp.example.net]:2222 ssh-ed25519 ${HOST_KEY}\n`,
    );
    expect(deps.reporter.text()).toContain("The key stays in the file OPSCREW_SFTP_KEY names");
  });

  it("records the folder and PHP's path without a trailing slash, as every command joins them", async () => {
    const deps = await project(SFTP_ENV, { runner: keyscan() });
    await runInterview(deps, {
      answers: {
        ...SFTP_ANSWERS,
        "hosting.folder": "opscrew/",
        "hosting.phpPath": "/home/deploy/opscrew//",
        "hosting.hostKey": FINGERPRINT,
      },
    });
    expect((await readHostingRecord(deps.paths))?.sftp).toMatchObject({
      folder: "opscrew",
      phpPath: "/home/deploy/opscrew",
    });
  });

  it("asks for the folder and PHP's path, and has the key confirmed in a terminal", async () => {
    const approvals = new ScriptedApprovalHandler([true]);
    const deps = await project(SFTP_ENV, {
      runner: keyscan(),
      interactive: true,
      approvalHandler: approvals,
    });
    const asked: string[] = [];
    await runInterview(deps, {
      ask: async () => ({ ...BASE, domain: "notes.example.net" }),
      askHosting: async (questions) => {
        asked.push(...questions.map((question) => question.id));
        return {
          "hosting.hostname": "notes.example.net",
          "hosting.port": "22",
          "hosting.folder": "apps/notes",
          "hosting.phpPath": "/var/www/deploy/apps/notes",
        };
      },
    });
    expect(asked).toEqual([
      "hosting.hostname",
      "hosting.port",
      "hosting.folder",
      "hosting.phpPath",
    ]);
    expect(approvals.requests.map((request) => request.kind)).toEqual(["remote-exec"]);
    expect(approvals.requests[0]?.title).toBe("Trust the SSH host key of your SFTP host");
    expect(approvals.requests[0]?.details).toContain(`ssh-ed25519 ${FINGERPRINT}`);
    expect((await readHostingRecord(deps.paths))?.sftp).toMatchObject({
      port: 22,
      folder: "apps/notes",
      phpPath: "/var/www/deploy/apps/notes",
      hostKey: FINGERPRINT,
    });
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(
      `sftp.example.net ssh-ed25519 ${HOST_KEY}\n`,
    );
  });

  it("never trusts a host key nobody confirmed, or one that differs", async () => {
    const deps = await project(SFTP_ENV, { runner: keyscan() });
    const unconfirmed = await runInterview(deps, { answers: SFTP_ANSWERS }).catch((e) => e);
    expect(unconfirmed.code).toBe("PHASE_PRECONDITION");
    expect(unconfirmed.message).toContain(`presents ssh-ed25519 ${FINGERPRINT}`);
    expect(unconfirmed.hint).toContain(`answer hosting.hostKey: ${FINGERPRINT}`);
    const other = hostKeyFingerprint(Buffer.from("another key").toString("base64"));
    await expect(
      runInterview(deps, { answers: { ...SFTP_ANSWERS, "hosting.hostKey": other } }),
    ).rejects.toThrow(`not the fingerprint you answered (${other})`);
    // A pinned key that changed stops too.
    await runInterview(deps, { answers: { ...SFTP_ANSWERS, "hosting.hostKey": FINGERPRINT } });
    const changed = await project(SFTP_ENV, {
      runner: keyscan(Buffer.from("new").toString("base64")),
    });
    await updateHostingRecord(changed.paths, () => ({
      schemaVersion: 1,
      objects: [],
      sftp: {
        host: "sftp.example.net",
        port: 2222,
        user: "deploy",
        hostKey: FINGERPRINT,
        folder: "opscrew",
        phpPath: "/home/deploy/opscrew",
      },
    }));
    await expect(runInterview(changed, { answers: SFTP_ANSWERS })).rejects.toThrow(
      "changed since you confirmed it",
    );
    expect(await readHostingRecord(deps.paths)).toBeDefined();
  });

  it("refuses answers it can't use", async () => {
    const deps = await project(SFTP_ENV, { runner: keyscan() });
    await expect(
      runInterview(deps, {
        answers: { ...SFTP_ANSWERS, "hosting.phpPath": "home/x", "hosting.folder": "../up" },
      }),
    ).rejects.toThrow(
      "Some answers about your SFTP host are missing or not valid: hosting.folder: write the folder as SFTP shows it, such as opscrew, without ..; hosting.phpPath: write the folder's full path, starting with /, without ...",
    );
    await expect(
      runInterview(deps, { answers: { ...SFTP_ANSWERS, "hosting.password": "x" } }),
    ).rejects.toThrow("hosting.password: not a known answer");
    // Never an option for ssh-keyscan, nor a key's text where its path belongs.
    const option = await project(
      { ...SFTP_ENV, OPSCREW_SFTP_HOST: "-oProxyCommand=evil" },
      { runner: keyscan() },
    );
    await expect(runInterview(option, { answers: SFTP_ANSWERS })).rejects.toThrow(
      "OPSCREW_SFTP_HOST isn't a host's address.",
    );
    const material = await project(
      { ...SFTP_ENV, OPSCREW_SFTP_KEY: `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----` },
      { runner: keyscan() },
    );
    await expect(runInterview(material, { answers: SFTP_ANSWERS })).rejects.toThrow(
      "OPSCREW_SFTP_KEY must be the path of your SSH key file, never the key itself.",
    );
  });
});
