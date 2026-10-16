import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PortainerEnvironment as AdapterEnvironment,
  type DockerInfo,
  PortainerApiError,
  type PortainerClient,
} from "@opscrew/connector-portainer";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCertificate, portainerPlan } from "../provision/__fixtures__/portainer";
import {
  PortainerEnvironmentError,
  portainerContainerUrl,
  requirePortainerConnection,
} from "../provision/portainer";
import { recordPortainerConnection } from "../shared";
import { createTestPhaseDeps } from "../testing";
import { hideRecordedPortainerAddress } from "../verify/portainer";
import { PortainerEnvironmentSchema } from "./portainer";
import {
  createPortainerAccess,
  hidePortainerAddress,
  portainerAddressNames,
} from "./portainer-access";

const URL_ = "https://nas:9443";
const FINGERPRINT = `SHA256:${Array.from({ length: 32 }, () => "AB").join(":")}`;

/** A Portainer client with only the two reads the access makes; `listing` throws from the list. */
function fakeClient(
  environments: AdapterEnvironment[],
  infos: Record<number, DockerInfo>,
  o: { listing?: Error } = {},
) {
  const calls: { endpoint?: unknown; token?: string; listed: number; info: number[] } = {
    listed: 0,
    info: [],
  };
  const factory = (
    endpoint: unknown,
    token: string,
  ): Pick<PortainerClient, "listEnvironments" | "dockerInfo"> => {
    calls.endpoint = endpoint;
    calls.token = token;
    return {
      listEnvironments: async () => {
        calls.listed++;
        if (o.listing !== undefined) throw o.listing;
        return environments;
      },
      dockerInfo: async (id: number) => {
        calls.info.push(id);
        const info = infos[id];
        if (info === undefined) throw new Error("not reachable");
        return info;
      },
    };
  };
  return { factory, calls };
}

describe("createPortainerAccess", () => {
  it("maps the adapter's kinds and reads each Docker host's architecture", async () => {
    const { factory, calls } = fakeClient(
      [
        { id: 1, name: "local", type: 1, status: 1 },
        { id: 2, name: "nas\nagent", type: 2, status: 1 },
        { id: 3, name: "cluster", type: 1, status: 1, swarm: true },
        { id: 4, name: "edge", type: 4, status: 1 },
        { id: 5, name: "k8s", type: 5, status: 1 },
        { id: 6, name: "aci", type: 3, status: 1 },
        { id: 7, name: "down", type: 1, status: 2 },
        { id: 8, name: "pi", type: 2, status: 1 },
        { id: 9, name: "swarm-mode", type: 1, status: 1 },
        { id: 10, name: "broken", type: 1, status: 1 },
        { id: 11, name: "edge-k8s", type: 7, status: 1 },
        { id: 12, name: "future", type: 42, status: 1 },
        { id: 13, name: "  ", type: 1, status: 2 },
      ],
      {
        1: { architecture: "x86_64", swarmActive: false },
        2: { architecture: "aarch64", swarmActive: false },
        8: { architecture: "armv7l", swarmActive: false },
        9: { architecture: "x86_64", swarmActive: true },
      },
    );
    const token = fakeSecret("generic-password", "portainer-token");
    const access = createPortainerAccess({ redactor: new Redactor(), client: factory });
    const listed = await access.listEnvironments(URL_, token, FINGERPRINT);
    expect(calls.endpoint).toEqual({ url: URL_, certFingerprint: FINGERPRINT });
    expect(calls.token).toBe(token);
    // One listing and Docker's info, nothing else (the fake has no other reads).
    expect(calls.listed).toBe(1);
    expect(listed).toEqual([
      { id: 1, name: "local", kind: "docker", up: true, arch: "amd64" },
      { id: 2, name: "nas agent", kind: "docker", up: true, arch: "arm64" },
      { id: 3, name: "cluster", kind: "swarm", up: true },
      { id: 4, name: "edge", kind: "edge", up: true },
      { id: 5, name: "k8s", kind: "kubernetes", up: true },
      { id: 6, name: "aci", kind: "other", up: true },
      { id: 7, name: "down", kind: "docker", up: false },
      { id: 8, name: "pi", kind: "docker", up: true, arch: "other" },
      { id: 9, name: "swarm-mode", kind: "swarm", up: true, arch: "amd64" },
      { id: 10, name: "broken", kind: "docker", up: true },
      { id: 11, name: "edge-k8s", kind: "edge", up: true },
      { id: 12, name: "future", kind: "other", up: true },
      { id: 13, name: "environment 13", kind: "docker", up: false },
    ]);
    // Docker's info only for Docker hosts that are up (not Swarm, Edge, Kubernetes or down ones).
    expect(calls.info.sort((a, b) => a - b)).toEqual([1, 2, 8, 9, 10]);
    for (const environment of listed) {
      expect(PortainerEnvironmentSchema.safeParse(environment).success).toBe(true);
    }
  });

  it("sends no certificate for plain HTTP to this computer", async () => {
    const { factory, calls } = fakeClient([], {});
    const access = createPortainerAccess({ redactor: new Redactor(), client: factory });
    expect(
      await access.listEnvironments("http://localhost:9000", "x".repeat(20), undefined),
    ).toEqual([]);
    expect(calls.endpoint).toEqual({ url: "http://localhost:9000" });
  });

  it("stops plainly when Portainer rejects the token", async () => {
    const rejected = new PortainerApiError("CREDENTIALS_INVALID", 401, "rejected", "set it again");
    const { factory } = fakeClient([], {}, { listing: rejected });
    const access = createPortainerAccess({ redactor: new Redactor(), client: factory });
    const error = await access
      .listEnvironments(URL_, "x".repeat(20), FINGERPRINT)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).not.toBeInstanceOf(PortainerApiError);
    expect((error as OpsCrewError).code).toBe("CREDENTIALS_INVALID");
    expect((error as OpsCrewError).message).toBe(
      "Portainer rejected the access token (HTTP 401), so OpsCrew saved nothing.",
    );
    expect((error as OpsCrewError).hint).toContain("PORTAINER_API_KEY");
  });

  it("passes on the adapter's error when Portainer refuses to list the environments", async () => {
    const refused = new PortainerApiError("CREDENTIALS_INVALID", 403, "refused", "ask for access");
    const { factory } = fakeClient([], {}, { listing: refused });
    const access = createPortainerAccess({ redactor: new Redactor(), client: factory });
    await expect(access.listEnvironments(URL_, "x".repeat(20), FINGERPRINT)).rejects.toBe(refused);
  });

  it("passes on an unreachable Portainer", async () => {
    const unreachable = new PortainerApiError("PROVIDER_ERROR", 0, "unreachable", "check it");
    const { factory } = fakeClient([], {}, { listing: unreachable });
    const access = createPortainerAccess({ redactor: new Redactor(), client: factory });
    await expect(access.listEnvironments(URL_, "x".repeat(20), FINGERPRINT)).rejects.toBe(
      unreachable,
    );
  });

  it("registers Portainer's address with the redactor before anything is sent", async () => {
    const redactor = new Redactor();
    let seen = "";
    const access = createPortainerAccess({
      redactor,
      fetchCertificateFingerprint: async (url) => {
        seen = redactor.redact(`reading ${url}`);
        return FINGERPRINT;
      },
    });
    expect(await access.fetchCertificateFingerprint(URL_)).toBe(FINGERPRINT);
    expect(seen).toBe("reading [REDACTED:portainer-address]");
    expect(redactor.redact(`at ${URL_}/api, NAS:9000 and nas; kept nas.url and nas-agent`)).toBe(
      "at [REDACTED:portainer-address]/api, [REDACTED:portainer-address]:9000 and [REDACTED:portainer-address]; kept nas.url and nas-agent",
    );
  });
});

describe("Portainer's address", () => {
  it("lists the URL, its origin, host and host name", () => {
    expect(portainerAddressNames("https://nas:9443/portainer")).toEqual([
      "https://nas:9443/portainer",
      "https://nas:9443",
      "nas:9443",
      "nas",
    ]);
    expect(portainerAddressNames("https://nas.home.arpa")).toEqual([
      "https://nas.home.arpa",
      "nas.home.arpa",
    ]);
    expect(portainerAddressNames("not a url")).toEqual([]);
  });

  it("also lists a trailing-dot host without its dot and an IPv6 host without brackets", () => {
    expect(portainerAddressNames("https://nas.lan.:9443")).toEqual([
      "https://nas.lan.:9443",
      "nas.lan.:9443",
      "nas.lan:9443",
      "nas.lan.",
      "nas.lan",
    ]);
    expect(portainerAddressNames("https://[fd00::5]:9443")).toEqual([
      "https://[fd00::5]:9443",
      "[fd00::5]:9443",
      "[fd00::5]",
      "fd00::5",
    ]);
    expect(portainerAddressNames("https://portainer.:9443")).toEqual([
      "https://portainer.:9443",
      "portainer.:9443",
      "portainer:9443",
    ]);
    expect(portainerAddressNames("https://localhost.:9443")).toEqual(["https://localhost.:9443"]);
    const redactor = new Redactor();
    hidePortainerAddress(redactor, "https://nas.lan.:9443");
    hidePortainerAddress(redactor, "https://[fd00::5]:9443");
    expect(
      redactor.redact("at nas.lan, NAS.LAN:9443, host:fd00::5 and [fd00::5]; Portainer. kept"),
    ).toBe(
      "at [REDACTED:portainer-address], [REDACTED:portainer-address], host:[REDACTED:portainer-address] and [REDACTED:portainer-address]; Portainer. kept",
    );
  });

  it("with the host `nas`, hides it after a colon or a percent-escape", () => {
    const redactor = new Redactor();
    hidePortainerAddress(redactor, "https://nas:9443");
    expect(
      redactor.redact(
        "DNS:nas, u=https%3A%2F%2Fnas%3A9443, p=%2F%2Fnas, e=user%40nas; kept nas.url, 10.nas, opscrew-shop-nas-tunnel",
      ),
    ).toBe(
      "DNS:[REDACTED:portainer-address], u=[REDACTED:portainer-address], p=%2F%2F[REDACTED:portainer-address], e=user%40[REDACTED:portainer-address]; kept nas.url, 10.nas, opscrew-shop-nas-tunnel",
    );
  });

  it("never names a loopback host alone", () => {
    expect(portainerAddressNames("https://localhost:9443")).toEqual(["https://localhost:9443"]);
    expect(portainerAddressNames("http://127.0.0.1:9000/")).toEqual([
      "http://127.0.0.1:9000/",
      "http://127.0.0.1:9000",
    ]);
    expect(portainerAddressNames("https://host.docker.internal:9443")).toEqual([
      "https://host.docker.internal:9443",
    ]);
    const redactor = new Redactor();
    hidePortainerAddress(redactor, "https://localhost:9443");
    expect(redactor.redact("localhost is fine; https://localhost:9443/api is not")).toBe(
      "localhost is fine; [REDACTED:portainer-address]/api is not",
    );
  });

  it("with the host `portainer`, hides the address but never the product's own name", () => {
    expect(portainerAddressNames("https://portainer:9443")).toEqual([
      "https://portainer:9443",
      "portainer:9443",
    ]);
    expect(portainerAddressNames("https://Portainer")).toEqual(["https://Portainer"]);
    const redactor = new Redactor();
    const token = fakeSecret("generic-password", "portainer");
    redactor.addLiteral(token, "PORTAINER_API_KEY");
    hidePortainerAddress(redactor, "https://portainer:9443");
    const text = [
      `Connected to https://portainer:9443/api and PORTAINER:9443 with ${token}.`,
      "Answer portainer.url and portainer.environment.",
      "Removed the stack opscrew-shop-portainer-tunnel and opscrew_portainer_x.",
      "Nothing in your Portainer changed; Portainer rejected nothing.",
    ].join("\n");
    expect(redactor.redact(text)).toBe(
      [
        "Connected to [REDACTED:portainer-address]/api and [REDACTED:portainer-address] with [REDACTED:PORTAINER_API_KEY].",
        "Answer portainer.url and portainer.environment.",
        "Removed the stack opscrew-shop-portainer-tunnel and opscrew_portainer_x.",
        "Nothing in your Portainer changed; Portainer rejected nothing.",
      ].join("\n"),
    );
  });

  it("with the host `nas`, hides it wherever it stands alone", () => {
    const redactor = new Redactor();
    hidePortainerAddress(redactor, "https://nas:9443");
    hidePortainerAddress(redactor, "not a url");
    expect(
      redactor.redact(
        "Portainer on nas (https://nas:9443, nas:8000, NAS); kept: nas.url, opscrew-shop-nas-tunnel, nas.lan",
      ),
    ).toBe(
      "Portainer on [REDACTED:portainer-address] ([REDACTED:portainer-address], [REDACTED:portainer-address]:8000, [REDACTED:portainer-address]); kept: nas.url, opscrew-shop-nas-tunnel, nas.lan",
    );
  });
});

describe("the phases hide Portainer's address with the same helper", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function recorded(url: string) {
    const root = await mkdtemp(join(tmpdir(), "opscrew-portainer-access-"));
    roots.push(root);
    const deps = await createTestPhaseDeps({
      root,
      env: { OPSCREW_HOME: join(root, ".home-opscrew") },
    });
    await recordPortainerConnection(deps.paths, {
      url,
      certFingerprint: fakeCertificate().fingerprint,
      environmentId: 3,
      environmentName: "local",
    });
    return deps;
  }

  const TEXT =
    "Portainer at https://nas:9443 (NAS, nas:8000); stack opscrew-shop-nas-tunnel; answer nas.url.";
  const HIDDEN =
    "Portainer at [REDACTED:portainer-address] ([REDACTED:portainer-address], [REDACTED:portainer-address]:8000); stack opscrew-shop-nas-tunnel; answer nas.url.";

  it("provision, drift and destroy: the recorded connection, with the host `nas`", async () => {
    const deps = await recorded("https://nas:9443");
    await requirePortainerConnection(deps, portainerPlan());
    expect(deps.redactor.redact(TEXT)).toBe(HIDDEN);
  });

  it("another environment than the plan's stops, with the mismatch readable on its own", async () => {
    const deps = await recorded("https://nas:9443");
    const error = await requirePortainerConnection(deps, portainerPlan({ environmentId: 4 })).catch(
      (e: unknown) => e,
    );
    const mismatch =
      "opscrew/plan.yaml deploys to Portainer environment 4, but the interview on this computer chose environment 3 (local).";
    expect(error).toBeInstanceOf(PortainerEnvironmentError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `${mismatch} Nothing was changed.`,
      hint: "Run `opscrew design` again so the plan uses the environment you chose, then run `opscrew provision` again.",
      mismatch,
    });
  });

  it("verify: the recorded connection, with the host `nas`", async () => {
    const deps = await recorded("https://nas:9443");
    await hideRecordedPortainerAddress(deps);
    expect(deps.redactor.redact(TEXT)).toBe(HIDDEN);
  });

  it("with the host `portainer`, the stack names and question ids stay readable", async () => {
    const deps = await recorded("https://portainer:9443");
    await requirePortainerConnection(deps, portainerPlan());
    expect(
      deps.redactor.redact(
        "Stopped opscrew-shop-portainer-tunnel on https://portainer:9443 (portainer:9443); answer portainer.url in your Portainer.",
      ),
    ).toBe(
      "Stopped opscrew-shop-portainer-tunnel on [REDACTED:portainer-address] ([REDACTED:portainer-address]); answer portainer.url in your Portainer.",
    );
  });

  it("the engine's origin for a Portainer on this computer hides only that origin", () => {
    const redactor = new Redactor();
    const origin = portainerContainerUrl("https://localhost:9443");
    hidePortainerAddress(redactor, origin);
    expect(redactor.redact(`${origin}/api/stacks/webhooks/x via host.docker.internal`)).toBe(
      "[REDACTED:portainer-address]/api/stacks/webhooks/x via host.docker.internal",
    );
  });
});
