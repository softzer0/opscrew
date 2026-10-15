import { PortainerEnvironmentSchema } from "@opscrew/agents";
import type { DockerInfo, PortainerEnvironment } from "@opscrew/connector-portainer";
import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  createPortainerAccess,
  hidePortainerAddress,
  portainerAddressNames,
} from "./portainer-access";

const URL_ = "https://nas-portainer.home.arpa:9443";
const FINGERPRINT = `SHA256:${Array.from({ length: 32 }, () => "AB").join(":")}`;

function fakeClient(environments: PortainerEnvironment[], infos: Record<number, DockerInfo>) {
  const calls: { endpoint?: unknown; token?: string; info: number[] } = { info: [] };
  const factory = (endpoint: unknown, token: string) => {
    calls.endpoint = endpoint;
    calls.token = token;
    return {
      listEnvironments: async () => environments,
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
    await access.listEnvironments("http://localhost:9000", "x".repeat(20), undefined);
    expect(calls.endpoint).toEqual({ url: "http://localhost:9000" });
  });

  it("registers Portainer's address with the redactor before anything is sent", async () => {
    const redactor = new Redactor();
    const access = createPortainerAccess({
      redactor,
      fetchCertificateFingerprint: async () => FINGERPRINT,
    });
    expect(await access.fetchCertificateFingerprint(URL_)).toBe(FINGERPRINT);
    const text = redactor.redact(`at ${URL_}/api and nas-portainer.home.arpa`);
    expect(text).not.toContain("nas-portainer");
  });
});

describe("Portainer's address", () => {
  it("is hidden by host and origin, but never by a loopback host name", () => {
    const redactor = new Redactor();
    hidePortainerAddress(redactor, "https://localhost:9443");
    expect(redactor.redact("localhost is fine")).toBe("localhost is fine");
    expect(redactor.redact("https://localhost:9443")).not.toContain("localhost:9443");
    expect(portainerAddressNames(URL_)).toEqual(
      [
        URL_,
        "https://nas-portainer.home.arpa:9443",
        "nas-portainer.home.arpa:9443",
        "nas-portainer.home.arpa",
      ].filter((name, index, all) => all.indexOf(name) === index),
    );
    expect(portainerAddressNames("not a url")).toEqual([]);
  });
});
