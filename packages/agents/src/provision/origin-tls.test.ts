import { readFile, writeFile } from "node:fs/promises";
import type { SharedRecord } from "@opscrew/connector-cloudflare";
import {
  fingerprintSha256,
  generateP256,
  OpsCrewError,
  selfSignedClientCertificate,
} from "@opscrew/core";
import { renderEdgeSite, renderPortainerStack } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { generatedValuesFile } from "../shared/app-secrets";
import { TUNNEL_DOWN_HINT } from "../shared/server-address";
import { updateServerAddresses } from "../shared/server-record";
import { APP_HOST, splitWorld } from "../status/__fixtures__/split";
import { createTestPhaseDeps, HOST_KEY, ownPlan, portainerPlan, testPlan } from "../testing";
import type { GitHubSetup } from "./credentials";
import {
  clientCertificateWarning,
  deployRenewedCertificate,
  edgeReadCommand,
  edgeSwitch,
  keepCertificateRequest,
  keepOriginCertificate,
  originTlsFor,
  originTlsHostnames,
  originTlsNotes,
  originTlsSecret,
  parseServerEdge,
  planOriginTls,
  portainerOriginTls,
  readOriginTlsValues,
  readServerEdge,
  requiringHostnames,
  stackServed,
  tlsWarnings,
} from "./origin-tls";

const ZONE = "0123456789abcdef0123456789abcdef";
const SHA = (c: string) => c.repeat(64);

function withEdge(plan: DeployPlan, edge: "caddy" | "nginx"): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge } });
}

/** A certificate made now, standing in for one Cloudflare issued. */
function certificate(name: string): { certificate: string; key: string } {
  const key = generateP256().privateKey;
  return { certificate: selfSignedClientCertificate({ key, commonName: name, days: 1 }), key };
}

function recordWith(tls: SharedRecord["tls"]): SharedRecord {
  return { zoneId: ZONE, hostnames: {}, createdEntrypoints: [], ...(tls ? { tls } : {}) };
}

describe("originTlsHostnames", () => {
  it("is the proxied hostnames of a public origin, and none behind a tunnel or DNS only", () => {
    expect(originTlsHostnames(testPlan({ domain: "example.com", www: true }))).toEqual([
      "example.com",
      "www.example.com",
    ]);
    const dnsOnly = testPlan({ domain: "shop.example.com" });
    expect(originTlsHostnames({ ...dnsOnly, dns: { ...dnsOnly.dns, proxied: false } })).toEqual([]);
    expect(originTlsHostnames(testPlan())).toEqual([]);
    expect(originTlsHostnames(ownPlan({ access: "tunnel" }))).toEqual([]);
    const caddy = portainerPlan({ web: { mode: "caddy" } });
    expect(originTlsHostnames(caddy)).toEqual([]);
    expect(originTlsHostnames({ ...caddy, dns: { ...caddy.dns, proxied: true } })).toEqual([
      "shop.example.com",
    ]);
    expect(originTlsHostnames(portainerPlan({ web: { mode: "tunnel" } }))).toEqual([]);
  });
});

describe("requiringHostnames: the hostnames a site requires the client certificate for", () => {
  const plan = testPlan({ domain: "example.com", www: true });
  const site = (p: DeployPlan, hostnames: string[] | undefined) =>
    renderEdgeSite(p, {
      opscrewVersion: "0.0.0-test",
      github: { owner: "acme", repo: "shop" },
      deploySshPublicKey: "",
      ...(hostnames !== undefined ? { originTls: { hostnames } } : {}),
    })[0]?.content ?? "";

  it.each(["caddy", "nginx"] as const)("reads %s's rendered site", (edge) => {
    const p = withEdge(plan, edge);
    expect(requiringHostnames(site(p, ["example.com", "www.example.com"]))).toEqual([
      "example.com",
      "www.example.com",
    ]);
    expect(requiringHostnames(site(p, ["example.com"]))).toEqual(["example.com"]);
    expect(requiringHostnames(site(p, undefined))).toEqual([]);
  });
});

describe("parseServerEdge", () => {
  const origin = certificate("example.com");
  const output = (proxy: string, pem: string, site: string) =>
    `opscrew-edge-read 1\nproxy=${proxy}\n--origin--\n${pem}--site--\n${site}--end--\n`;

  it("reads the proxy, the origin certificate's fingerprint and the hostnames that require", () => {
    const site = "example.com {\n\ttls a b {\n\t\tclient_auth {\n\t\t}\n\t}\n}\n";
    expect(parseServerEdge(output("nginx", origin.certificate, site))).toEqual({
      proxy: "nginx",
      served: { originSha256: fingerprintSha256(origin.certificate), requiring: ["example.com"] },
    });
    // An edge from before the proxy choice runs Caddy; a server without an edge runs nothing yet.
    expect(parseServerEdge(output("", "", ""))?.proxy).toBe("caddy");
    expect(parseServerEdge(output("none", "", ""))).toEqual({
      proxy: undefined,
      served: { requiring: [] },
    });
  });

  it("reads nothing from other output, so nothing is cleaned up on a guess", () => {
    expect(parseServerEdge("ready\n")).toBeUndefined();
    expect(parseServerEdge("")).toBeUndefined();
    expect(parseServerEdge("opscrew-edge-read 1\nproxy=caddy\n--origin--\n")).toBeUndefined();
    expect(parseServerEdge(output("traefik", "", ""))).toBeUndefined();
  });

  it("is read with one read-only command", () => {
    const command = edgeReadCommand("shop");
    expect(command).toContain("cat /srv/edge/tls/shop/origin.pem");
    expect(command).toContain("/srv/edge/sites/shop.caddy /srv/edge/sites/shop.conf");
    // Nothing secret is read and nothing is written (only errors go to /dev/null).
    expect(command).not.toMatch(/origin\.key|\brm |(?<!2)>/);
  });
});

describe("edgeSwitch", () => {
  const nginx = withEdge(testPlan({ domain: "shop.example.com" }), "nginx");
  const runs = (proxy: "caddy" | "nginx" | undefined) => ({ proxy, served: { requiring: [] } });
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return error as OpsCrewError;
    }
  };

  it("says nothing when the server runs the plan's proxy, or none yet", () => {
    expect(edgeSwitch(nginx, runs("nginx"), ["blog"])).toBeUndefined();
    expect(edgeSwitch(nginx, runs(undefined), ["blog"])).toBeUndefined();
    // Alone on a server that could not be read: nothing to refuse or to say.
    expect(edgeSwitch(nginx, undefined, [])).toBeUndefined();
  });

  it("plans the switch with its interruption while the app is alone", () => {
    const note = edgeSwitch(nginx, runs("caddy"), []);
    expect(note).toContain("from Caddy to nginx");
    expect(note).toContain("a few seconds");
    expect(note).toContain("under a minute");
  });

  it("refuses another proxy while other OpsCrew apps share the server", () => {
    const refused = refusal(() => edgeSwitch(nginx, runs("caddy"), ["blog"]));
    expect(refused).toBeInstanceOf(OpsCrewError);
    expect(refused?.code).toBe("PHASE_PRECONDITION");
    expect(refused?.message).toContain("every OpsCrew app on it shares (also blog)");
    expect(refused?.message).toContain("Nothing was changed.");
    expect(refused?.hint).toContain("while it holds one OpsCrew app");
  });

  it("fails closed when other apps share the server and its proxy could not be read", () => {
    const refused = refusal(() => edgeSwitch(nginx, undefined, ["blog"]));
    expect(refused?.code).toBe("PHASE_PRECONDITION");
    expect(refused?.message).toContain("OpsCrew could not read which proxy your server runs");
    expect(refused?.message).toContain("Nothing was changed.");
  });
});

describe("planOriginTls and the origin TLS values", () => {
  const plan = testPlan({ domain: "example.com", www: true });

  it("makes the client certificate once, keeps a request only while its plan creates one", async () => {
    const deps = await createTestPhaseDeps();
    const step = await planOriginTls(deps, { plan, record: undefined, served: undefined });
    if (step?.keys === undefined || step.request === undefined) throw new Error("no keys");
    expect(step.desired).toMatchObject({
      proxied: ["example.com", "www.example.com"],
      origin: { csr: step.request.csr },
      client: { sha256: fingerprintSha256(step.keys.clientCertificate) },
    });
    expect(step.desired.served).toBeUndefined();
    // The client certificate is kept at once; a fresh request is not, until a plan creates one.
    const values = await readOriginTlsValues(deps);
    expect(values.ORIGIN_PULL_KEY).toBe(step.keys.clientKey);
    expect(values.ORIGIN_TLS_REQUEST).toBeUndefined();
    await keepCertificateRequest(deps, step, {
      changes: [{ kind: "create-origin-certificate", hostnames: [], csrSha256: SHA("a") }],
    });
    const again = await planOriginTls(deps, { plan, record: undefined, served: undefined });
    expect(again?.request).toEqual(step.request);
    expect(again?.keys).toEqual(step.keys);
    // Applied: the request's key is the certificate's, and the request is done.
    const issued = certificate("example.com");
    if (again?.request === undefined) throw new Error("no request");
    await keepOriginCertificate(deps, again.request, issued.certificate);
    const kept = await readOriginTlsValues(deps);
    expect(kept).toMatchObject({
      ORIGIN_TLS_KEY: step.request.key,
      ORIGIN_TLS_CERT: issued.certificate,
    });
    expect(kept.ORIGIN_TLS_REQUEST).toBeUndefined();
    // Every private key is registered with the redactor.
    expect(deps.redactor.redact(step.keys.clientKey)).not.toContain("PRIVATE KEY");
    const file = await readFile(generatedValuesFile(deps), "utf8");
    expect(JSON.parse(file).originTls.ORIGIN_PULL_CERT).toBe(step.keys.clientCertificate);
  });

  it("keeps a hostname leaving the proxy until the server no longer requires it", async () => {
    const deps = await createTestPhaseDeps();
    const dnsOnly = { ...plan, dns: { ...plan.dns, proxied: false } };
    const record = recordWith({
      origin: {
        id: "o1",
        hostnames: ["example.com", "www.example.com"],
        expiresAt: "2041-10-21T09:00:00Z",
        sha256: SHA("1"),
        superseded: [],
      },
      client: {
        id: "c1",
        expiresAt: "2041-10-21T09:00:00Z",
        sha256: SHA("2"),
        enabled: ["example.com", "www.example.com"],
        retiring: [],
      },
    });
    const first = await planOriginTls(deps, {
      plan: dnsOnly,
      record,
      served: { originSha256: SHA("1"), requiring: ["example.com", "www.example.com"] },
    });
    expect(first?.leaving).toEqual(["example.com", "www.example.com"]);
    expect(first?.desired.proxied).toEqual(["example.com", "www.example.com"]);
    expect(first?.holdsProxy).toBe(true);
    // The deploy dropped the requirement: they leave `proxied`, so the planner turns them off.
    const second = await planOriginTls(deps, {
      plan: dnsOnly,
      record,
      served: { requiring: [] },
    });
    expect(second?.desired).toEqual({ proxied: [], served: { requiring: [] } });
    expect(second?.holdsProxy).toBe(false);
    // Without anything recorded or wanted there is no origin TLS to plan.
    expect(
      await planOriginTls(deps, { plan: dnsOnly, record: undefined, served: undefined }),
    ).toBeUndefined();
    // A hostname the app no longer serves at all is not kept: the planner turns it off once the
    // server shows it, and the new certificate covers only the app's hostnames.
    const apexOnly = testPlan({ domain: "example.com" });
    const removed = await planOriginTls(deps, {
      plan: apexOnly,
      record,
      served: { originSha256: SHA("1"), requiring: ["example.com", "www.example.com"] },
    });
    expect(removed?.leaving).toEqual([]);
    expect(removed?.desired.proxied).toEqual(["example.com"]);
    expect(removed?.holdsProxy).toBe(false);
  });

  it("serves origin TLS only for hostnames the record's certificates cover, with the keys here", async () => {
    const origin = certificate("example.com");
    const client = certificate("opscrew-shop");
    const values = {
      ORIGIN_TLS_KEY: origin.key,
      ORIGIN_TLS_CERT: origin.certificate,
      ORIGIN_PULL_KEY: client.key,
      ORIGIN_PULL_CERT: client.certificate,
    };
    const record = recordWith({
      origin: {
        id: "o1",
        hostnames: ["example.com", "www.example.com"],
        expiresAt: "2041-10-21T09:00:00Z",
        sha256: fingerprintSha256(origin.certificate),
        superseded: [],
      },
      client: {
        id: "c1",
        expiresAt: "2041-10-21T09:00:00Z",
        sha256: fingerprintSha256(client.certificate),
        enabled: ["example.com"],
        retiring: [],
      },
    });
    expect(originTlsFor(plan, record, values)).toEqual({ hostnames: ["example.com"] });
    expect(originTlsFor(plan, record, { ...values, ORIGIN_TLS_KEY: undefined })).toBeUndefined();
    expect(
      originTlsFor(plan, record, { ...values, ORIGIN_TLS_CERT: client.certificate }),
    ).toBeUndefined();
    expect(originTlsFor(plan, recordWith({ gap: "permission" }), values)).toBeUndefined();
    // The deploy secret: the certificate, then its key; the stack variable adds pull.pem, in base64.
    expect(originTlsSecret(values)).toBe(`${origin.certificate}${origin.key}`);
    expect(Buffer.from(portainerOriginTls(values), "base64").toString("utf8")).toBe(
      `${origin.certificate}${origin.key}${client.certificate}`,
    );
    expect(portainerOriginTls(values)).not.toContain("\n");
  });
});

describe("what provision says about TLS", () => {
  const clock = { now: () => new Date("2026-10-11T12:00:00.000Z") };
  const dnsOnly = (() => {
    const plan = testPlan({ domain: "shop.example.com" });
    return { ...plan, dns: { ...plan.dns, proxied: false, zone: "example.com" } };
  })();
  const caa = { foreignCaa: [{ name: "shop.example.com", content: '0 issue "digicert.com"' }] };

  it("reports CAA records of the user's where OpsCrew publishes its own, and never replaces them", () => {
    const [warning] = tlsWarnings(dnsOnly, caa, undefined, clock);
    expect(warning).toContain(
      "Cloudflare has CAA records at shop.example.com that OpsCrew did not create",
    );
    expect(warning).toContain('0 issue "digicert.com"');
    expect(warning).toContain("OpsCrew leaves them as they are");
    // None behind the proxy or on the zone apex, where OpsCrew publishes no CAA.
    const proxied = { ...dnsOnly, dns: { ...dnsOnly.dns, proxied: true } };
    expect(tlsWarnings(proxied, caa, undefined, clock)).toEqual([]);
    const apex = { ...dnsOnly, dns: { ...dnsOnly.dns, domain: "example.com" } };
    expect(tlsWarnings(apex, caa, undefined, clock)).toEqual([]);
  });

  it("warns 30 days before the client certificate expires, with the steps to replace it", () => {
    const near = recordWith({
      client: {
        id: "c1",
        expiresAt: "2026-11-09T12:00:00.000Z",
        sha256: SHA("2"),
        enabled: ["shop.example.com"],
        retiring: [],
      },
    });
    const [warning] = tlsWarnings(dnsOnly, undefined, { record: near }, clock);
    expect(warning).toContain("expires on 2026-11-09");
    expect(warning).toContain("OpsCrew does not replace it by itself");
    expect(warning).toContain("opscrew/runtime/edge/tls/pull.pem");
    // The same warning for status and secure.
    expect(clientCertificateWarning(dnsOnly, near, clock)).toBe(warning);
    const far = recordWith({
      client: {
        ...(near.tls?.client as NonNullable<NonNullable<SharedRecord["tls"]>["client"]>),
        expiresAt: "2041-10-21T09:00:00.000Z",
      },
    });
    expect(tlsWarnings(dnsOnly, undefined, { record: far }, clock)).toEqual([]);
  });

  it("says in the Cloudflare plan which deploy brings a renewed certificate, and what waits for the server", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan({ domain: "shop.example.com" });
    const step = await planOriginTls(deps, { plan, record: undefined, served: undefined });
    if (step === undefined) throw new Error("no step");
    const renewal = {
      changes: [
        {
          kind: "create-origin-certificate" as const,
          hostnames: ["shop.example.com"],
          csrSha256: SHA("c"),
        },
      ],
      previous: recordWith({
        origin: {
          id: "o1",
          hostnames: ["shop.example.com"],
          expiresAt: "2026-11-09T12:00:00.000Z",
          sha256: SHA("1"),
          superseded: [],
        },
      }),
      record: recordWith({
        origin: {
          id: "o2",
          hostnames: ["shop.example.com"],
          expiresAt: "2041-10-21T09:00:00.000Z",
          sha256: SHA("3"),
          superseded: ["o1"],
        },
      }),
    };
    const notes = originTlsNotes(step, { workflow: "opscrew-deploy.yml", branch: "main" });
    const said = notes({
      ...renewal,
      zoneId: ZONE,
      accountId: "",
      expect: {},
      findings: [],
      advice: [],
      hash: SHA("a"),
    });
    expect(said.join("\n")).toContain(
      "once the deploy secret holds it, OpsCrew starts the deploy workflow (opscrew-deploy.yml on main)",
    );
    // What the server serves could not be read: the replaced certificate waits.
    expect(said.join("\n")).toContain("OpsCrew could not read what your server serves now");
    // A stack in Portainer brings it itself: no deploy is named.
    const stack = originTlsNotes(
      step,
      undefined,
    )({
      ...renewal,
      zoneId: ZONE,
      accountId: "",
      expect: {},
      findings: [],
      advice: [],
      hash: SHA("a"),
    });
    expect(stack.join("\n")).not.toContain("deploy workflow");
  });
});

describe("stackServed: what a Portainer stack serves", () => {
  const caddy = DeployPlanSchema.parse({
    ...portainerPlan({ web: { mode: "caddy" } }),
    dns: { ...portainerPlan({ web: { mode: "caddy" } }).dns, proxied: true },
  });
  const ctx = { opscrewVersion: "0.0.0-test", github: { owner: "acme", repo: "shop" } };
  const record = recordWith({
    origin: {
      id: "o1",
      hostnames: ["shop.example.com"],
      expiresAt: "2041-10-21T09:00:00Z",
      sha256: SHA("1"),
      superseded: [],
    },
  });

  it("reads the stack Caddy's requirement, and the certificate when the stack holds ours", () => {
    const file = renderPortainerStack(caddy, {
      ...ctx,
      deploySshPublicKey: "",
      originTls: { hostnames: ["shop.example.com"] },
    }).content;
    expect(stackServed(file, record, { held: "f", fingerprint: "f" })).toEqual({
      originSha256: SHA("1"),
      requiring: ["shop.example.com"],
    });
    expect(stackServed(file, record, { held: "f", fingerprint: "g" })).toEqual({
      requiring: ["shop.example.com"],
    });
    const plain = renderPortainerStack(caddy, { ...ctx, deploySshPublicKey: "" }).content;
    expect(stackServed(plain, record, { held: "f", fingerprint: "f" })).toEqual({ requiring: [] });
    expect(stackServed(undefined, record, { held: undefined, fingerprint: "f" })).toEqual({
      requiring: [],
    });
  });
});

describe("deployRenewedCertificate's warnings", () => {
  const plan = testPlan({ domain: "example.com" });
  /** A GitHub whose dispatch fails, after accepting it when `accepts`. */
  const github = (accepts: boolean) => ({
    owner: "acme",
    repo: "shop",
    api: {
      dispatchWorkflow: async (...args: unknown[]) => {
        if (accepts) await (args[5] as () => Promise<void>)();
        throw new OpsCrewError("PROVIDER_ERROR", "no run showed up");
      },
    } as unknown as GitHubSetup["api"],
  });

  it("says the dispatch was not started when GitHub refused it", async () => {
    const deps = await createTestPhaseDeps();
    await deployRenewedCertificate(deps, github(false), plan, "provision");
    expect(deps.reporter.text()).toContain("OpsCrew could not start the deploy workflow");
    expect(deps.audit.entries).toHaveLength(0);
  });

  it("says GitHub accepted it, and where to look, when no run showed up", async () => {
    const deps = await createTestPhaseDeps();
    await deployRenewedCertificate(deps, github(true), plan, "provision");
    const text = deps.reporter.text();
    expect(text).toContain("GitHub accepted the start of the deploy workflow");
    expect(text).toContain("https://github.com/acme/shop/actions");
    expect(text).not.toContain("could not start");
    expect(deps.audit.entries).toHaveLength(1);
  });
});

describe("readServerEdge with public SSH closed (FR-1816)", () => {
  const EDGE_OUTPUT = "opscrew-edge-read 1\nproxy=caddy\n--origin--\n--site--\n--end--\n";

  /** The split app with the app server's host key pinned and this computer as device laptop. */
  async function world(publicSsh: boolean) {
    const split = await splitWorld({ network: (network) => ({ ...network, publicSsh }) });
    await writeFile(split.deps.paths.files.knownHosts, `${APP_HOST} ${HOST_KEY}\n`);
    await updateServerAddresses(split.deps.paths, (current) => ({
      ...current,
      thisDevice: "laptop",
    }));
    const app = split.servers[APP_HOST];
    if (app === undefined) throw new Error("no app server");
    app.other = (command) =>
      command === edgeReadCommand(split.plan.app.name)
        ? { exitCode: 0, stdout: EDGE_OUTPUT, stderr: "" }
        : undefined;
    split.servers[`${split.prefix}.1`] = app;
    return split;
  }

  it("reads the edge at the public address while public SSH is open", async () => {
    const w = await world(true);
    const edge = await readServerEdge(w.deps, w.plan, { remote: w.remote });
    expect(edge?.proxy).toBe("caddy");
    expect(w.commands.map((c) => c.host)).toEqual([APP_HOST]);
    // An unreachable server is not read, and the run goes on, as before.
    w.offline.add(APP_HOST);
    expect(await readServerEdge(w.deps, w.plan, { remote: w.remote })).toBeUndefined();
  });

  it("reads the edge at the private address, and says the tunnel looks down when it fails", async () => {
    const w = await world(false);
    const edge = await readServerEdge(w.deps, w.plan, { remote: w.remote });
    expect(edge?.proxy).toBe("caddy");
    expect(w.commands.map((c) => c.host)).toEqual([`${w.prefix}.1`]);

    w.offline.add(`${w.prefix}.1`);
    await expect(readServerEdge(w.deps, w.plan, { remote: w.remote })).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: expect.stringContaining("this computer's tunnel (device laptop) looks down"),
      hint: TUNNEL_DOWN_HINT,
    });
    expect(w.deps.audit.entries.at(-1)).toMatchObject({ detail: "not read" });
  });
});
