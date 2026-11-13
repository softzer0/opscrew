// Feature 027 (T2710): what design reads about a hosting account, never changing it.
import { CpanelPanel, fakeCpanel } from "@opscrew/connector-cpanel";
import type { FetchLike, HostingDomain, HostingFacts, HostingPanel } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { hostingAccountLines, quotaLeftMb, readHostingAccount, webServerOf } from "./facts";

const TOKEN = fakeSecret("generic-password", "hosting-facts");

/** `domain` answers over `schemes` with `server` (absent: no header); other requests go to `api`. */
function site(
  domain: string,
  server: string | undefined,
  api?: FetchLike,
  schemes = ["https", "http"],
): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === domain) {
      if (!schemes.includes(url.protocol.replace(":", ""))) throw new TypeError("fetch failed");
      return new Response("", { status: 301, headers: server === undefined ? {} : { server } });
    }
    if (api === undefined) throw new Error(`Unexpected request: ${url.href}`);
    return api(input, init);
  };
}

describe("the web server from the main domain's Server header", () => {
  it("names LiteSpeed, Apache and nginx, and nothing else", async () => {
    expect(await webServerOf("example.com", site("example.com", "LiteSpeed"))).toBe("LiteSpeed");
    expect(await webServerOf("example.com", site("example.com", "Apache/2.4.62 (cPanel)"))).toBe(
      "Apache",
    );
    expect(await webServerOf("example.com", site("example.com", "nginx/1.27.3"))).toBe("nginx");
    // A CDN in front, or a hidden header, tells nothing about the account's server.
    expect(await webServerOf("example.com", site("example.com", "cloudflare"))).toBeUndefined();
    expect(await webServerOf("example.com", site("example.com", undefined))).toBeUndefined();
  });

  it("asks over HTTP when HTTPS doesn't answer, and gives up quietly when neither does", async () => {
    expect(
      await webServerOf("example.com", site("example.com", "LiteSpeed", undefined, ["http"])),
    ).toBe("LiteSpeed");
    expect(await webServerOf("example.com", site("example.com", "x", undefined, []))).toBe(
      undefined,
    );
  });
});

describe("the account's facts", () => {
  it("reads cPanel's facts and its main domain's web server, with read-only calls", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com" });
    const panel = new CpanelPanel(
      { url: "https://panel.example.com:2083", user: "acct", token: TOKEN },
      { fetch: fake.fetch },
    );
    const account = await readHostingAccount(panel, site("example.com", "LiteSpeed", fake.fetch));
    expect(account.mainDomain).toBe("example.com");
    expect(account.webServer).toBe("LiteSpeed");
    expect(account.webServerDomain).toBe("example.com");
    expect(account.facts.panel).toBe("cpanel");
    // Nothing on the account was changed.
    expect(
      fake.calls.every((call) => !/^(add|create|delete|remove|set|save|upload)/i.test(call.func)),
    ).toBe(true);
    expect(hostingAccountLines(account)).toEqual([
      "The account: cPanel. Web server: LiteSpeed, from example.com's Server header.",
      "Databases: MariaDB, every name starting with acct_. Disk: 9,728 MB left of 10,240 MB. Apps: Node.js and Python through the panel, 4 slots left.",
    ]);
  });

  it("says what the panel doesn't tell", () => {
    const facts: HostingFacts = {
      panel: "plesk",
      domains: [{ name: "example.com", kind: "main" }],
      addresses: [],
      databases: { engines: [] },
      apps: { selectors: [] },
      phpPerHostname: [],
      documentRoots: "anywhere",
    };
    expect(quotaLeftMb(facts)).toBeUndefined();
    expect(hostingAccountLines({ facts, mainDomain: "example.com" })).toEqual([
      "The account: Plesk. Web server: the account's domains don't name it.",
      "Databases: none. Disk: the panel doesn't say how much is left. Apps: the panel runs no Node.js or Python apps.",
    ]);
    const unlimited = { ...facts, quota: { usedMb: 300 } };
    expect(quotaLeftMb(unlimited)).toBeUndefined();
    expect(hostingAccountLines({ facts: unlimited })[1]).toContain("Disk: no limit (300 MB used)");
    expect(quotaLeftMb({ quota: { usedMb: 1200, limitMb: 1000 } })).toBe(0);
  });
});

describe("the web server from the first of the account's domains that answers (R13)", () => {
  const facts = (domains: HostingDomain[]): HostingFacts => ({
    panel: "cpanel",
    domains,
    addresses: [],
    databases: { engines: [] },
    apps: { selectors: [] },
    phpPerHostname: [],
    documentRoots: "anywhere",
  });
  const panelOf = (domains: HostingDomain[]) =>
    ({ inspect: async () => facts(domains) }) as unknown as HostingPanel;
  /** Answers each domain in `servers` with its header; any other domain doesn't resolve. */
  const answering =
    (servers: Record<string, string>, asked: string[]): FetchLike =>
    async (input) => {
      const { hostname } = new URL(String(input));
      if (!asked.includes(hostname)) asked.push(hostname);
      const server = servers[hostname];
      if (server === undefined) throw new TypeError("fetch failed");
      return new Response("", { status: 301, headers: { server } });
    };

  it("asks the parked domain when the main domain doesn't resolve", async () => {
    const asked: string[] = [];
    const account = await readHostingAccount(
      panelOf([
        { name: "sub.parked.example", kind: "subdomain" },
        { name: "parked.example", kind: "parked" },
        { name: "main.example", kind: "main" },
      ]),
      answering({ "parked.example": "LiteSpeed", "sub.parked.example": "Apache" }, asked),
    );
    expect(asked).toEqual(["main.example", "parked.example"]);
    expect(account).toMatchObject({
      mainDomain: "main.example",
      webServer: "LiteSpeed",
      webServerDomain: "parked.example",
    });
    expect(hostingAccountLines(account)[0]).toBe(
      "The account: cPanel. Web server: LiteSpeed, from parked.example's Server header.",
    );
  });

  it("says the account's domains don't name it when none answers", async () => {
    const account = await readHostingAccount(
      panelOf([
        { name: "main.example", kind: "main" },
        { name: "addon.example", kind: "addon" },
      ]),
      answering({ "addon.example": "cloudflare" }, []),
    );
    expect(account.webServer).toBeUndefined();
    expect(account.webServerDomain).toBeUndefined();
    expect(hostingAccountLines(account)[0]).toBe(
      "The account: cPanel. Web server: the account's domains don't name it.",
    );
  });

  it("asks at most five domains: main, addon, parked, then subdomains", async () => {
    const asked: string[] = [];
    const account = await readHostingAccount(
      panelOf([
        { name: "s1.main.example", kind: "subdomain" },
        { name: "s2.main.example", kind: "subdomain" },
        { name: "p1.example", kind: "parked" },
        { name: "a1.example", kind: "addon" },
        { name: "a2.example", kind: "addon" },
        { name: "main.example", kind: "main" },
      ]),
      answering({ "s2.main.example": "LiteSpeed" }, asked),
    );
    expect(asked).toEqual([
      "main.example",
      "a1.example",
      "a2.example",
      "p1.example",
      "s1.main.example",
    ]);
    expect(account.webServer).toBeUndefined();
  });
});
