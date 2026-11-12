// Feature 027 (T2710): the hosting account's panel, found from the environment without asking.
import { CpanelPanel, fakeCpanel } from "@opscrew/connector-cpanel";
import { DirectAdminPanel, FakeDirectAdmin } from "@opscrew/connector-directadmin";
import { FAKE_PLESK_URL, fakePlesk, PleskPanel } from "@opscrew/connector-plesk";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  connectPanel,
  findPanel,
  HOSTING_TOKEN_VAR,
  hostingFiles,
  hostingReach,
  panelAccess,
} from "./panels";

const TOKEN = fakeSecret("generic-password", "hosting-panels");

/**
 * A panel's host on the network: each port answers `/` as `ports` says (a `Server` header, `""`
 * for none) or refuses the connection; every other request goes to `api`.
 */
function host(
  ports: Record<number, string>,
  api: FetchLike = refused,
): FetchLike & {
  probed: string[];
} {
  const probed: string[] = [];
  const fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/") return api(input, init);
    probed.push(url.port);
    const server = ports[Number(url.port)];
    if (server === undefined) throw new TypeError("fetch failed: connection refused");
    return new Response("<html></html>", {
      status: 200,
      headers: server === "" ? {} : { server },
    });
  }) as FetchLike & { probed: string[] };
  fetch.probed = probed;
  return fetch;
}

const refused: FetchLike = async () => {
  throw new TypeError("fetch failed: connection refused");
};

const env = (url: string, user = "acct") => ({
  OPSCREW_HOSTING_URL: url,
  OPSCREW_HOSTING_USER: user,
  OPSCREW_HOSTING_TOKEN: TOKEN,
});

describe("which account the environment reaches", () => {
  it("takes a panel when its three variables are set, else an SFTP host, else none", () => {
    expect(hostingReach(env("https://panel.example.com"))).toBe("panel");
    const sftp = {
      OPSCREW_SFTP_HOST: "sftp.example.com",
      OPSCREW_SFTP_USER: "deploy",
      OPSCREW_SFTP_KEY: "/home/me/.ssh/id_ed25519",
    };
    expect(hostingReach(sftp)).toBe("sftp");
    expect(hostingReach({ ...sftp, ...env("https://panel.example.com") })).toBe("panel");
    expect(hostingReach({ ...env("https://panel.example.com"), OPSCREW_HOSTING_TOKEN: " " })).toBe(
      undefined,
    );
    expect(hostingReach({ OPSCREW_SFTP_HOST: "sftp.example.com" })).toBe(undefined);
  });

  it("reads the panel's access and hides its token from every output", () => {
    const redactor = new Redactor();
    const access = panelAccess(env(" https://panel.example.com:2083 "), redactor);
    expect(access).toEqual({ url: "https://panel.example.com:2083", user: "acct", token: TOKEN });
    expect(redactor.redact(`token ${TOKEN}`)).toBe(`token [REDACTED:${HOSTING_TOKEN_VAR}]`);
    expect(() => panelAccess({ OPSCREW_HOSTING_URL: "https://x.example.com" }, redactor)).toThrow(
      "OPSCREW_HOSTING_USER and OPSCREW_HOSTING_TOKEN aren't set",
    );
  });
});

describe("finding the panel from its answer on 2083, 8443 or 2222", () => {
  it("knows cPanel, Plesk and DirectAdmin by the Server header on their ports", async () => {
    expect(
      await findPanel("https://panel.example.com", host({ 2083: "cpsrvd/11.130.0.4" })),
    ).toEqual({
      kind: "cpanel",
      url: "https://panel.example.com:2083",
    });
    expect(await findPanel("https://panel.example.com", host({ 8443: "sw-cp-server" }))).toEqual({
      kind: "plesk",
      url: "https://panel.example.com:8443",
    });
    const directadmin = host({ 2222: "DirectAdmin Daemon v1.680" });
    expect(await findPanel("https://Panel.Example.com/", directadmin)).toEqual({
      kind: "directadmin",
      url: "https://panel.example.com:2222",
    });
    expect(directadmin.probed.sort()).toEqual(["2083", "2222", "8443"]);
  });

  it("prefers a panel that names itself over a port that only answers", async () => {
    const found = await findPanel(
      "https://panel.example.com",
      host({ 2083: "", 8443: "sw-cp-server", 2222: "" }),
    );
    expect(found.kind).toBe("plesk");
  });

  it("takes the port's panel when the answer names none", async () => {
    expect((await findPanel("https://panel.example.com", host({ 2222: "" }))).kind).toBe(
      "directadmin",
    );
  });

  it("asks only the address's own port when it names one", async () => {
    const fetch = host({ 2083: "cpsrvd", 8443: "sw-cp-server" });
    expect(await findPanel("https://panel.example.com:8443", fetch)).toEqual({
      kind: "plesk",
      url: "https://panel.example.com:8443",
    });
    expect(fetch.probed).toEqual(["8443"]);
    // Another port is the panel's only by its header.
    expect(await findPanel("https://panel.example.com:2087", host({ 2087: "cpsrvd" }))).toEqual({
      kind: "cpanel",
      url: "https://panel.example.com:2087",
    });
  });

  it("says plainly when no panel answers, or the answer names none", async () => {
    const none = await findPanel("https://panel.example.com", refused).catch((e) => e);
    expect(none).toBeInstanceOf(OpsCrewError);
    expect(none.message).toBe(
      "No control panel answered at panel.example.com on port 2083, 8443 or 2222.",
    );
    expect(none.hint).toContain("OPSCREW_HOSTING_URL");
    const unnamed = await findPanel(
      "https://panel.example.com:8080",
      host({ 8080: "nginx" }),
    ).catch((e) => e);
    expect(unnamed.message).toBe(
      "The panel at panel.example.com doesn't say whether it is cPanel, Plesk or DirectAdmin.",
    );
    await expect(findPanel("http://panel.example.com", refused)).rejects.toThrow(
      "OPSCREW_HOSTING_URL isn't a panel's address.",
    );
  });
});

describe("the panel's connector and the account's files", () => {
  const redactor = () => new Redactor();

  it("builds cPanel's connector, whose API writes the account's files", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN });
    const deps = {
      env: env("https://panel.example.com"),
      fetch: host({ 2083: "cpsrvd/11.130" }, fake.fetch),
      redactor: redactor(),
    };
    const { panel, url, user } = await connectPanel(deps);
    expect(panel).toBeInstanceOf(CpanelPanel);
    expect({ url, user }).toEqual({ url: "https://panel.example.com:2083", user: "acct" });
    expect((await panel.inspect()).panel).toBe("cpanel");
    expect(hostingFiles(panel)).toBe(panel);
  });

  it("builds Plesk's, whose customer API writes no files: they are panel steps", async () => {
    const fake = fakePlesk({ token: TOKEN });
    const deps = {
      env: env("https://plesk.example.test", fake.login),
      fetch: host({ 8443: "sw-cp-server" }, fake.fetch),
      redactor: redactor(),
    };
    const { panel, url } = await connectPanel(deps);
    expect(panel).toBeInstanceOf(PleskPanel);
    expect(url).toBe(FAKE_PLESK_URL);
    expect((await panel.inspect()).panel).toBe("plesk");
    expect(hostingFiles(panel)).toBeUndefined();
    expect(
      panel.panelStep("writeFile", { path: "opscrew/app/agent.sh", mode: "0700" }).what,
    ).not.toBe("");
  });

  it("builds DirectAdmin's, whose API writes the account's files", async () => {
    const fake = new FakeDirectAdmin({ token: TOKEN });
    const deps = {
      env: env(fake.access.url, fake.access.user),
      fetch: host({ 2222: "" }, fake.fetch),
      redactor: redactor(),
    };
    const { panel } = await connectPanel(deps);
    expect(panel).toBeInstanceOf(DirectAdminPanel);
    expect((await panel.inspect()).panel).toBe("directadmin");
    expect(hostingFiles(panel)).toBe(panel);
  });

  it("takes the recorded panel without asking again, and stops for another account", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN });
    const recorded = {
      kind: "cpanel" as const,
      url: "https://panel.example.com:2083",
      user: "acct",
    };
    const deps = {
      env: env("https://panel.example.com"),
      fetch: host({}, fake.fetch),
      redactor: redactor(),
    };
    expect((await connectPanel(deps, recorded)).panel).toBeInstanceOf(CpanelPanel);
    const other = { ...deps, env: env("https://other.example.com") };
    await expect(connectPanel(other, recorded)).rejects.toThrow(
      "OPSCREW_HOSTING_URL and OPSCREW_HOSTING_USER name another account than the one OpsCrew recorded for this app (acct at panel.example.com).",
    );
  });
});
