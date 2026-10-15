import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture } from "@opscrew/core/testing";
import { QuestionSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  damagedServerAddressesFile,
  readOwnServer,
  recordOwnServer,
  serverAddressesFile,
} from "../shared";
import { createTestPhaseDeps } from "../testing";
import {
  answersToOwnServer,
  answersToRequirements,
  buildServerQuestions,
  type InterviewAnswers,
  runInterview,
  splitServerAnswers,
  suggestReachable,
} from "./index";

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const now = new Date("2026-10-14T12:00:00.000Z");
const IPV4 = "203.0.113.10";
const HOST_KEY = `SHA256:${createHash("sha256").update("own server host key").digest("base64").replace(/=+$/, "")}`;

const BASE: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  uptime: "standard",
};

async function deps() {
  const root = await mkdtemp(join(tmpdir(), "opscrew-own-interview-"));
  await materializeFixture(join(examples, "static-vite"), root);
  return createTestPhaseDeps({ root });
}

const split = (server: Record<string, unknown>) => splitServerAnswers({ server });

describe("questions for a server the user already has", () => {
  it("asks for the address, SSH port, user, key and reachability, never a password", () => {
    const questions = buildServerQuestions();
    expect(questions.map((q) => q.id)).toEqual([
      "server.host",
      "server.port",
      "server.user",
      "server.key",
      "server.reachable",
      "server.serve",
    ]);
    for (const question of questions) {
      // Same shape as every other interview question.
      expect(QuestionSchema.safeParse({ ...question, id: "notes" }).success).toBe(true);
    }
    expect(questions.find((q) => q.id === "server.port")?.default).toBe("22");
    expect(questions.find((q) => q.id === "server.key")?.default).toBe("agent");
    expect(questions.find((q) => q.id === "server.reachable")).toMatchObject({
      kind: "confirm",
      default: true,
    });
    expect(JSON.stringify(questions)).not.toMatch(/enter (your|the) password/i);
  });

  it("pre-fills the previous answers and takes the reachability suggestion", () => {
    const previous = {
      host: IPV4,
      port: 2222,
      user: "admin",
      keyPath: "~/.ssh/id_ed25519",
      agent: false,
      reachable: false,
    };
    const questions = buildServerQuestions({ previous });
    const defaults = Object.fromEntries(questions.map((q) => [q.id, q.default]));
    expect(defaults).toEqual({
      "server.host": IPV4,
      "server.port": "2222",
      "server.user": "admin",
      "server.key": "~/.ssh/id_ed25519",
      "server.reachable": false,
      "server.serve": "tunnel",
    });
    const suggested = buildServerQuestions({ previous, suggestedReachable: true });
    expect(suggested.find((q) => q.id === "server.reachable")?.default).toBe(true);
  });

  it("asks how to serve the site: the tunnel recommended, the filter and DNS only explained", () => {
    const serve = buildServerQuestions().find((q) => q.id === "server.serve");
    expect(serve).toMatchObject({ kind: "single-select", default: "tunnel" });
    expect(serve?.options?.map((o) => o.value)).toEqual(["tunnel", "proxy", "dns-only"]);
    expect(serve?.options?.[0]?.label).toMatch(/recommended/);
    expect(serve?.options?.[1]?.hint).toMatch(/needs no Cloudflare Zero Trust.*fails closed/i);
    expect(serve?.options?.[2]?.hint).toMatch(/neither hides nor protects/);
    // The earlier answer is the default next time.
    const previous = { host: IPV4, port: 22, user: "root", agent: true, serve: "proxy" as const };
    expect(buildServerQuestions({ previous }).find((q) => q.id === "server.serve")?.default).toBe(
      "proxy",
    );
    // Without a domain on Cloudflare only DNS only is offered, and the help says why.
    const only = buildServerQuestions({ cloudflareDomain: false }).find(
      (q) => q.id === "server.serve",
    );
    expect(only?.options?.map((o) => o.value)).toEqual(["dns-only"]);
    expect(only?.help).toMatch(/not on Cloudflare/);
  });

  it("guesses reachability from the address", () => {
    expect(suggestReachable(IPV4)).toBe(true);
    expect(suggestReachable("192.168.1.20")).toBe(false);
    expect(suggestReachable("10.0.0.5")).toBe(false);
    expect(suggestReachable("172.20.0.5")).toBe(false);
    expect(suggestReachable("100.100.1.1")).toBe(false);
    expect(suggestReachable("2001:db8::10")).toBe(true);
    expect(suggestReachable("fd00::1")).toBe(false);
    expect(suggestReachable("pi.local")).toBe(false);
    expect(suggestReachable("nas")).toBe(false);
    expect(suggestReachable("server.example.com")).toBeUndefined();
  });
});

describe("answersToOwnServer", () => {
  it("accepts flat server.* keys and a nested server mapping, defaulting the port to 22", () => {
    const flat = splitServerAnswers({
      ...BASE,
      "server.host": ` ${IPV4} `,
      "server.user": "root",
      "server.key": "agent",
    });
    expect(flat.rest).toEqual(BASE);
    expect(answersToOwnServer(flat)).toEqual({
      host: IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      serve: "tunnel",
    });
    const nested = split({
      host: "[2001:db8::10]",
      port: "2222",
      user: "ubuntu",
      key: "~/.ssh/id_ed25519",
      reachable: "no",
    });
    expect(answersToOwnServer(nested)).toEqual({
      host: "2001:db8::10",
      port: 2222,
      user: "ubuntu",
      keyPath: "~/.ssh/id_ed25519",
      agent: false,
      reachable: false,
      serve: "tunnel",
    });
  });

  it("takes how the site is served, and refuses anything else", () => {
    const base = { host: IPV4, user: "root", key: "agent" };
    for (const serve of ["tunnel", "proxy", "dns-only"] as const) {
      expect(answersToOwnServer(split({ ...base, serve })).serve).toBe(serve);
    }
    expect(answersToOwnServer(split({ ...base, serve: "Proxy" })).serve).toBe("proxy");
    expect(() => answersToOwnServer(split({ ...base, serve: "open" }))).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/server\.serve: answer tunnel/) }),
    );
    // Without a domain on Cloudflare only DNS only is possible.
    expect(answersToOwnServer(split(base), { cloudflareDomain: false }).serve).toBe("dns-only");
    expect(() =>
      answersToOwnServer(split({ ...base, serve: "proxy" }), { cloudflareDomain: false }),
    ).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/only be served with DNS only/) }),
    );
  });

  it("refuses the web filter for a server known only by an IPv6 address", () => {
    const v6 = { host: "2001:db8::10", user: "root", key: "agent", reachable: "yes" };
    expect(() => answersToOwnServer(split({ ...v6, serve: "proxy" }))).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/proxy needs your server's public IPv4 address/),
      }),
    );
    expect(answersToOwnServer(split({ ...v6, serve: "tunnel" })).serve).toBe("tunnel");
    expect(answersToOwnServer(split({ ...v6, host: IPV4, serve: "proxy" })).serve).toBe("proxy");
  });

  it("suggests reachability from inspection, then the address", () => {
    const answers = split({ host: "192.168.1.20", user: "pi", key: "agent" });
    expect(answersToOwnServer(answers).reachable).toBe(false);
    expect(answersToOwnServer(answers, { suggestedReachable: true }).reachable).toBe(true);
  });

  it("lists missing and invalid answers in plain English", () => {
    expect(() => answersToOwnServer(split({}))).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/server\.host .*missing.*server\.user .*missing/),
      }),
    );
    try {
      answersToOwnServer(
        split({
          host: "root@203.0.113.10",
          port: 70000,
          user: "-l root",
          key: "id_ed25519",
          reachable: "maybe",
          address: "x",
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      const message = (error as Error).message;
      expect(message).toMatch(/server\.address: not a known answer/);
      expect(message).toMatch(/server\.host: give only the address/);
      expect(message).toMatch(/server\.port: write a port number/);
      expect(message).toMatch(/server\.user: write a login name/);
      expect(message).toMatch(/server\.key: write the full path/);
      expect(message).toMatch(/server\.reachable: answer yes or no/);
    }
    expect(() => answersToOwnServer(split({ host: "-oProxyCommand=x", user: "root" }))).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/server\.host: write an IP/) }),
    );
  });

  it("refuses passwords, passphrases and key material without echoing them", () => {
    const secret = "correct-horse-battery";
    for (const key of ["password", "passphrase"]) {
      const error = (() => {
        try {
          answersToOwnServer(split({ host: IPV4, user: "root", [key]: secret }));
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error?.message).toMatch(/never asks for or stores a password or passphrase/);
      expect(error?.message).not.toContain(secret);
    }
    const pem = `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`;
    const error = (() => {
      try {
        answersToOwnServer(split({ host: IPV4, user: "root", key: pem }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toMatch(/never the key itself/);
    expect(error?.message).not.toContain("BEGIN");
  });
});

describe("a domain Cloudflare serves for a server the user already has", () => {
  const base = { host: IPV4, user: "root", key: "agent" };
  const deep = { cloudflareDomain: true, domain: "api.shop.example.com" };
  const reason =
    "domain: Cloudflare's free certificate covers only example.com and *.example.com, so api.shop.example.com would fail HTTPS at Cloudflare's edge; use a name one level below example.com, such as api-shop.example.com, or ";

  it("refuses it two levels below the zone through the tunnel or behind the proxy", () => {
    expect(() => answersToOwnServer(split({ ...base, serve: "tunnel" }), deep)).toThrow(
      `${reason}if the internet can reach your server, serve it with DNS only (server.reachable yes, server.serve dns-only).`,
    );
    expect(() =>
      answersToOwnServer(split({ ...base, reachable: "no", serve: "proxy" }), deep),
    ).toThrow(`${reason}if the internet can reach your server`);
    expect(() =>
      answersToOwnServer(split({ ...base, reachable: "yes", serve: "proxy" }), deep),
    ).toThrow(`${reason}serve it with DNS only (server.serve dns-only).`);
  });

  it("allows it with DNS only, one level below the zone, or off Cloudflare", () => {
    expect(
      answersToOwnServer(split({ ...base, reachable: "yes", serve: "dns-only" }), deep).serve,
    ).toBe("dns-only");
    for (const domain of ["shop.example.com", "example.com"]) {
      expect(
        answersToOwnServer(split({ ...base, serve: "tunnel" }), { cloudflareDomain: true, domain })
          .serve,
      ).toBe("tunnel");
    }
    expect(
      answersToOwnServer(split(base), { cloudflareDomain: false, domain: deep.domain }).serve,
    ).toBe("dns-only");
  });

  it("is not refused in the requirements, where the serving answer is not known", () => {
    expect(
      answersToRequirements(
        { ...BASE, provider: "own", dataCriticality: "none", domain: deep.domain },
        { now },
      ).domain,
    ).toBe(deep.domain);
  });
});

describe("requirements for a server the user already has", () => {
  it("records only provider: own, with no region needed", () => {
    const requirements = answersToRequirements(
      { ...BASE, provider: "own", dataCriticality: "none" },
      { now },
    );
    expect(requirements.provider).toBe("own");
    expect(requirements.region).toBeUndefined();
    const ignored = answersToRequirements(
      { ...BASE, provider: "OWN", region: "eu-central", dataCriticality: "none" },
      { now },
    );
    expect(ignored.region).toBeUndefined();
    // Hetzner still needs a region.
    expect(() =>
      answersToRequirements({ ...BASE, provider: "hetzner", dataCriticality: "none" }, { now }),
    ).toThrow(expect.objectContaining({ message: expect.stringMatching(/region/) }));
  });
});

describe("runInterview with a server the user already has", () => {
  it("saves the connection answers locally and only provider: own in requirements.yaml", async () => {
    const d = await deps();
    const result = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        region: "eu-central",
        "server.host": IPV4,
        "server.port": 2222,
        "server.user": "admin",
        "server.key": "~/.ssh/id_ed25519",
        "server.reachable": false,
      },
    });
    expect(result.ownServer).toEqual({
      host: IPV4,
      port: 2222,
      user: "admin",
      keyPath: "~/.ssh/id_ed25519",
      agent: false,
      reachable: false,
      serve: "dns-only",
    });
    const text = await readFile(d.paths.files.requirements, "utf8");
    expect(text).toMatch(/provider: own/);
    expect(text).not.toContain(IPV4);
    expect(text).not.toMatch(/admin|id_ed25519|2222|region|server/);
    expect((await readArtifact("requirements", d.paths.files.requirements)).region).toBeUndefined();
    // Recorded in the local server state, without a host key until provision pins one.
    expect(await readOwnServer(d.paths)).toEqual(result.ownServer);
    expect(serverAddressesFile(d.paths)).toBe(join(d.paths.stateDir, "server.json"));
    expect((await d.state.read()).phases.interview?.summary).toMatch(/your own server/);
    expect((await d.state.read()).phases.interview?.summary).not.toContain(IPV4);
  });

  it("refuses a domain too deep for the tunnel before anything is written", async () => {
    const d = await deps();
    await expect(
      runInterview(d, {
        answers: {
          ...BASE,
          provider: "own",
          domain: "api.shop.example.com",
          dnsProvider: "cloudflare",
          server: { host: IPV4, user: "root", key: "agent", serve: "tunnel" },
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(
        "so api.shop.example.com would fail HTTPS at Cloudflare's edge; use a name one level below example.com, such as api-shop.example.com",
      ),
    });
    await expect(readFile(d.paths.files.requirements, "utf8")).rejects.toThrow();
    expect(await readOwnServer(d.paths)).toBeUndefined();
    // DNS only is served with Caddy's own certificate.
    const direct = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        domain: "api.shop.example.com",
        dnsProvider: "cloudflare",
        server: { host: IPV4, user: "root", key: "agent", reachable: true, serve: "dns-only" },
      },
    });
    expect(direct.requirements.domain).toBe("api.shop.example.com");
  });

  it("asks the server questions after the others, pre-filled from the last answers", async () => {
    const d = await deps();
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { host: IPV4, user: "root", key: "agent" } },
    });
    let asked: string[] = [];
    let defaults: Record<string, unknown> = {};
    const result = await runInterview(d, {
      ask: async () => ({ ...BASE, provider: "own" }),
      askServer: async (questions) => {
        asked = questions.map((q) => q.id);
        defaults = Object.fromEntries(questions.map((q) => [q.id, q.default]));
        return { "server.host": IPV4, "server.user": "ubuntu", "server.key": "agent" };
      },
      suggestedReachable: false,
    });
    expect(asked).toEqual([
      "server.host",
      "server.port",
      "server.user",
      "server.key",
      "server.reachable",
      "server.serve",
    ]);
    expect(defaults).toMatchObject({ "server.host": IPV4, "server.user": "root" });
    expect(result.ownServer).toMatchObject({ user: "ubuntu", reachable: false });
  });

  it("offers every way to serve the site only with a domain on Cloudflare", async () => {
    const serveQuestion = async (answers: InterviewAnswers) => {
      const d = await deps();
      let options: string[] = [];
      let help = "";
      await runInterview(d, {
        ask: async () => ({ ...BASE, provider: "own", ...answers }),
        askServer: async (questions) => {
          const serve = questions.find((q) => q.id === "server.serve");
          options = serve?.options?.map((o) => o.value) ?? [];
          help = serve?.help ?? "";
          return { "server.host": IPV4, "server.user": "root", "server.key": "agent" };
        },
      });
      return { options, help, saved: await readOwnServer(d.paths) };
    };
    const cloudflare = await serveQuestion({
      domain: "app.example.com",
      dnsProvider: "cloudflare",
    });
    expect(cloudflare.options).toEqual(["tunnel", "proxy", "dns-only"]);
    expect(cloudflare.saved?.serve).toBe("tunnel");
    // A reachable server without a Cloudflare domain: DNS only, and the help says why.
    const other = await serveQuestion({ domain: "app.example.com", dnsProvider: "other" });
    expect(other.options).toEqual(["dns-only"]);
    expect(other.help).toMatch(/not on Cloudflare/);
    expect(other.saved?.serve).toBe("dns-only");

    // An answers file that asks for the filter without a Cloudflare domain is refused plainly.
    const d = await deps();
    const error = await runInterview(d, {
      answers: {
        ...BASE,
        provider: "own",
        "server.host": IPV4,
        "server.user": "root",
        "server.serve": "proxy",
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/only be served with DNS only/),
    });
  });

  it("reuses the saved answers when none are given and fails plainly without any", async () => {
    const d = await deps();
    const error = await runInterview(d, { answers: { ...BASE, provider: "own" } }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/server\.host/),
    });
    await expect(readFile(d.paths.files.requirements, "utf8")).rejects.toThrow();
    await runInterview(d, {
      answers: { ...BASE, provider: "own", "server.host": IPV4, "server.user": "root" },
    });
    const again = await runInterview(d, { answers: { ...BASE, provider: "own" } });
    expect(again.ownServer).toMatchObject({ host: IPV4, user: "root", agent: true });
  });

  it("keeps the pinned host key for the same server and drops it when the server changes", async () => {
    const d = await deps();
    const pinned = {
      host: IPV4,
      user: "root",
      keyPath: "/home/me/.ssh/id_ed25519",
      agent: false,
      hostKey: HOST_KEY,
      publicIpv4: IPV4,
    };
    await recordOwnServer(d.paths, pinned);
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { host: IPV4, user: "admin", key: "agent" } },
    });
    expect(await readOwnServer(d.paths)).toEqual({
      host: IPV4,
      port: 22,
      user: "admin",
      agent: true,
      reachable: true,
      serve: "dns-only",
      hostKey: HOST_KEY,
      publicIpv4: IPV4,
    });

    // Another port on the same address may be another machine (port forwarding): ask again.
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { port: 2222 } },
    });
    expect(await readOwnServer(d.paths)).toEqual({
      host: IPV4,
      port: 2222,
      user: "admin",
      agent: true,
      reachable: true,
      serve: "dns-only",
    });

    await recordOwnServer(d.paths, pinned);
    await runInterview(d, {
      answers: { ...BASE, provider: "own", server: { host: "198.51.100.7", user: "root" } },
    });
    const moved = await readOwnServer(d.paths);
    expect(moved).toMatchObject({ host: "198.51.100.7", user: "root" });
    expect(moved?.hostKey).toBeUndefined();
    expect(moved?.publicIpv4).toBeUndefined();
    // The pinned key path is reused as the default key.
    expect(moved).toMatchObject({ agent: false, keyPath: "/home/me/.ssh/id_ed25519" });
  });

  it("ignores server answers for a cloud provider, with a warning", async () => {
    const d = await deps();
    const result = await runInterview(d, {
      answers: { ...BASE, region: "eu-central", "server.host": IPV4 },
    });
    expect(result.ownServer).toBeUndefined();
    expect(result.requirements.provider).toBe("hetzner");
    expect(d.reporter.text()).toMatch(/server\.\*\) were ignored/);
    expect(await readOwnServer(d.paths)).toBeUndefined();
  });

  it("keeps a damaged server record aside, never deleting it, once new answers are valid", async () => {
    const d = await deps();
    await mkdir(d.paths.stateDir, { recursive: true });
    await writeFile(serverAddressesFile(d.paths), "{ not json");
    // Invalid answers change nothing.
    const error = await runInterview(d, {
      answers: { ...BASE, provider: "own", "server.user": "root" },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(await readFile(serverAddressesFile(d.paths), "utf8")).toBe("{ not json");

    const result = await runInterview(d, {
      answers: { ...BASE, provider: "own", "server.host": IPV4, "server.user": "root" },
    });
    expect(result.ownServer?.host).toBe(IPV4);
    expect(await readFile(damagedServerAddressesFile(d.paths), "utf8")).toBe("{ not json");
    expect(await readOwnServer(d.paths)).toMatchObject({ host: IPV4, user: "root" });
    expect(d.reporter.text()).toMatch(/is damaged, so your earlier answers are not pre-filled/);
    expect(d.reporter.text()).toMatch(
      /Kept the damaged record as \.opscrew\/server\.json\.damaged .*confirm your server's host key again/,
    );
  });

  it("leaves a damaged server record alone for a cloud provider", async () => {
    const d = await deps();
    await mkdir(d.paths.stateDir, { recursive: true });
    await writeFile(serverAddressesFile(d.paths), "{ not json");
    await runInterview(d, { answers: { ...BASE, region: "eu-central" } });
    expect(await readFile(serverAddressesFile(d.paths), "utf8")).toBe("{ not json");
  });
});
