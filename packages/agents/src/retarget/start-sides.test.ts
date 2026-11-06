import { readFile } from "node:fs/promises";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { OwnServerAnswers } from "../interview/own-server";
import type { PortainerAnswers } from "../interview/portainer";
import {
  readServerAddresses,
  recordOwnServer,
  recordPortainerConnection,
  serverAddressesFile,
  updateServerAddresses,
} from "../shared";
import {
  ED25519_FINGERPRINT,
  FakeHostServer,
  fakePortainer,
  freshFacts,
  type MoveHarness,
  moveHarness,
  OLD_IPV4,
  OLD_IPV6,
  ownRunner,
  PORTAINER_CERT,
  PORTAINER_TOKEN,
  PORTAINER_URL,
  portainerServices,
  preparedServerFacts,
  ScriptedRunner,
} from "../testing";
import { NEW_IPV4, PORTAINER } from "./__fixtures__/pairs";
import { runRetarget } from "./run";
import { startMove } from "./start";
import type { RetargetOptions, RetargetServices, RetargetSummary } from "./types";

/** The move's state on this computer and in the repository: what a refusal leaves as it was. */
async function snapshot(h: MoveHarness): Promise<string> {
  const local = await readFile(serverAddressesFile(h.paths), "utf8").catch(() => "");
  return `${await readFile(h.paths.files.plan, "utf8")}\n${local}`;
}

/** The new own server's answers: reachable, served directly. */
const OWN_ANSWERS: OwnServerAnswers = {
  host: NEW_IPV4,
  port: 22,
  user: "root",
  agent: true,
  reachable: true,
  serve: "dns-only",
};

/** The new Portainer's answers: web mode caddy with the updater. */
const PORTAINER_ANSWERS: PortainerAnswers = {
  url: PORTAINER_URL,
  certFingerprint: PORTAINER_CERT.fingerprint,
  environmentId: 3,
  environmentName: "local",
  arch: "amd64",
  redeploy: "updater",
  web: { mode: "caddy" },
};

const own = (access: "public" | "tunnel") => ({
  provider: "own",
  mode: "vps-compose",
  arch: "amd64",
  access,
  edge: "caddy",
});
const portainer = (web: object) => ({
  provider: "portainer",
  mode: "portainer-stack",
  environmentId: 3,
  arch: "amd64",
  redeploy: "updater",
  web,
});

/** Runs `opscrew retarget` with the harness's services and `options`; the error it stops with. */
async function refused(h: MoveHarness, options: RetargetOptions): Promise<OpsCrewError> {
  const error = await runRetarget(h.deps, { services: h.services, ...options }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe.skipIf(!findExecutable("git"))("startMove: every refusal comes before any change", () => {
  it.each([
    {
      what: "an own old side served through a Cloudflare Tunnel",
      target: own("tunnel"),
      options: {},
      says: "is served through a Cloudflare Tunnel",
    },
    {
      what: "a Portainer old side reached through a Cloudflare Tunnel",
      target: portainer({ mode: "tunnel" }),
      options: {},
      says: "is reached through a Cloudflare Tunnel",
    },
    {
      what: "a Portainer old side behind the user's proxy with Cloudflare DNS",
      target: portainer({ mode: "proxy", port: 8080 }),
      options: {},
      says: "behind your own proxy with its DNS on Cloudflare",
    },
    {
      what: "a new own server reached through a tunnel",
      options: { to: "own", ownServer: { ...OWN_ANSWERS, reachable: false } },
      says: "Your new server would serve the app through a Cloudflare Tunnel",
    },
    {
      what: "a new Portainer reached through a tunnel",
      options: {
        to: "portainer",
        portainer: { ...PORTAINER_ANSWERS, web: { mode: "tunnel" } },
        portainerAddress: { ipv4: NEW_IPV4 },
      },
      says: "Your Portainer would reach the app through a Cloudflare Tunnel",
    },
    {
      what: "a new Portainer behind the user's proxy with Cloudflare DNS",
      options: {
        to: "portainer",
        portainer: { ...PORTAINER_ANSWERS, web: { mode: "proxy", port: 8080 } },
        portainerAddress: { ipv4: NEW_IPV4 },
      },
      says: "behind your own proxy with its DNS on Cloudflare",
    },
    {
      what: "a move to the user's server without its answers",
      options: { to: "own" },
      says: "OpsCrew needs the answers about your new server",
    },
    {
      what: "a move to Portainer without the address its Caddy serves on",
      options: { to: "portainer", portainer: PORTAINER_ANSWERS },
      says: "the public address of your Portainer host",
    },
    {
      what: "a move to the provider the app runs on",
      options: { to: "hetzner" },
      says: "already runs on Hetzner Cloud",
    },
  ] as const)("refuses $what, changing nothing", async ({ options, says, ...rest }) => {
    const h = await moveHarness();
    if ("target" in rest) {
      await writeArtifact(
        "plan",
        h.paths.files.plan,
        DeployPlanSchema.parse({
          ...h.plan,
          target: rest.target,
          dns: { ...h.plan.dns, proxied: false },
        }),
      );
    }
    const before = await snapshot(h);
    const error = await refused(h, options as RetargetOptions);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(says);
    expect(error.message).toContain("Nothing was changed.");
    expect(await snapshot(h)).toBe(before);
    expect(h.events).toEqual([]);
  });

  it("refuses this computer, a move between two Portainers and the same own server", async () => {
    const h = await moveHarness();
    const { region: _region, ...answers } = await readArtifact(
      "requirements",
      h.paths.files.requirements,
    );
    await writeArtifact("requirements", h.paths.files.requirements, {
      ...answers,
      provider: "localhost",
    });
    expect(await refused(h, {})).toMatchObject({
      message: expect.stringContaining("This computer runs a copy of the app"),
      hint: expect.stringContaining("opscrew env add"),
    });

    const p = await moveHarness();
    await writeArtifact(
      "plan",
      p.paths.files.plan,
      DeployPlanSchema.parse({
        ...p.plan,
        target: portainer({ mode: "caddy" }),
        dns: { ...p.plan.dns, proxied: false },
      }),
    );
    await recordPortainerConnection(p.paths, {
      ...PORTAINER_ANSWERS,
      created: { stacks: [{ id: 7, name: "opscrew-shop", role: "app" }], volumes: [] },
    });
    const before = await snapshot(p);
    const two = await refused(p, {
      to: "portainer",
      portainer: { ...PORTAINER_ANSWERS, environmentId: 5 },
      portainerAddress: { ipv4: NEW_IPV4 },
    });
    expect(two.message).toContain("between two Portainer environments");
    expect(two.message).toContain("Nothing was changed.");
    expect(await snapshot(p)).toBe(before);

    const o = await moveHarness();
    await writeArtifact(
      "plan",
      o.paths.files.plan,
      DeployPlanSchema.parse({ ...o.plan, target: own("public") }),
    );
    await recordOwnServer(o.paths, { ...OWN_ANSWERS, host: OLD_IPV4 });
    await updateServerAddresses(o.paths, (current) => ({
      ...current,
      deployment: { ipv4: OLD_IPV4 },
    }));
    const kept = await snapshot(o);
    const same = await refused(o, { to: "own", ownServer: { ...OWN_ANSWERS, host: OLD_IPV4 } });
    expect(same.message).toContain("already runs on that server");
    expect(await snapshot(o)).toBe(kept);
  });

  it("refuses an Edge Agent environment when it inspects the new side, before any change there or in the cloud", async () => {
    const h = await moveHarness();
    h.deps.env.PORTAINER_API_KEY = PORTAINER_TOKEN;
    const portainer = fakePortainer({ token: PORTAINER_TOKEN, environmentType: 4 });
    const services: RetargetServices = {
      ...h.services,
      portainer: portainerServices(h.hosts.docker(PORTAINER), { portainer }),
    };
    const error = await runRetarget(h.deps, {
      services,
      to: "portainer",
      portainer: PORTAINER_ANSWERS,
      portainerAddress: { ipv4: NEW_IPV4 },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("is an Edge agent environment"),
    });
    expect(portainer.mutations()).toEqual([]);
    expect(h.events.filter((e) => e.type === "remote")).toEqual([]);
    // Only the old server's moves-only rename in the infrastructure state was applied.
    expect(
      h.events.filter((e) => e.type === "apply").map((e) => [e.creates, e.updates, e.deletes]),
    ).toEqual([[[], [], []]]);
  });
});

describe.skipIf(!findExecutable("git"))("startMove: the new side must run the app", () => {
  it("refuses a Portainer of another architecture than the app's image, changing nothing", async () => {
    const h = await moveHarness();
    h.deps.env.PORTAINER_API_KEY = PORTAINER_TOKEN;
    const before = await snapshot(h);
    const error = await refused(h, {
      services: { ...h.services, portainer: portainerServices(h.hosts.docker(PORTAINER)) },
      to: "portainer",
      portainer: { ...PORTAINER_ANSWERS, arch: "arm64" },
      portainerAddress: { ipv4: NEW_IPV4 },
    });
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "Your Portainer environment runs on arm64, but the app's image is built for amd64",
      ),
      hint: expect.stringContaining("opscrew design"),
    });
    expect(error.message).toContain("Nothing was changed.");
    expect(await snapshot(h)).toBe(before);
  });

  it("refuses an own server with too little memory, as design checks it, changing nothing", async () => {
    const h = await moveHarness();
    const keys = ownRunner();
    const previous = h.deps.runner;
    h.deps.runner = new ScriptedRunner(async (command, args, options) =>
      command === "ssh-keyscan"
        ? keys.run(command, args, options)
        : previous.run(command, args, options),
    );
    const before = await snapshot(h);
    const error = await refused(h, {
      services: {
        ...h.services,
        own: { host: new FakeHostServer(freshFacts({ memoryGb: 0.25 })), homeDir: h.root },
      },
      to: "own",
      ownServer: OWN_ANSWERS,
      hostKey: ED25519_FINGERPRINT,
    });
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Your new server is too small for shop");
    expect(error.message).toContain("memory");
    expect(error.message).toContain("Nothing was changed.");
    expect(await snapshot(h)).toBe(before);
  });
});

describe.skipIf(!findExecutable("git"))("startMove onto the user's own server or Portainer", () => {
  it("records the own server's answers, inspects it, and starts with the data's sizes and what starts empty", async () => {
    const h = await moveHarness();
    const services: RetargetServices = {
      ...h.services,
      own: { host: new FakeHostServer(preparedServerFacts(h.paths.projectId)), homeDir: h.root },
    };
    const keys = ownRunner();
    const previous = h.deps.runner;
    h.deps.runner = new ScriptedRunner(async (command, args, options) =>
      command === "ssh-keyscan"
        ? keys.run(command, args, options)
        : previous.run(command, args, options),
    );
    let summary: RetargetSummary | undefined;
    const declined = await runRetarget(h.deps, {
      services,
      to: "own",
      ownServer: OWN_ANSWERS,
      hostKey: ED25519_FINGERPRINT,
      confirmStart: async (s) => {
        summary = s;
        return false;
      },
    }).catch((e: unknown) => e);
    expect(declined).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(summary).toMatchObject({
      to: { provider: "own", arch: "amd64", access: "public", edge: "caddy" },
      extraMonthly: { amount: 0 },
      data: [{ owner: "db", key: "/var/lib/postgresql/data", copy: true }],
      expectedDowntimeMinutes: 3,
    });
    expect(summary?.steps[1]).toContain("Set up your new server for the app with a host plan");
    expect(h.reporter.text()).toContain(
      "Moving shop from Hetzner Cloud (cx23 in nbg1) to your new server",
    );
    // Declined: the answers recorded for the inspection are forgotten again.
    expect((await readServerAddresses(h.paths)).own).toBeUndefined();
    expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();

    const session = await startMove(h.deps, h.plan, {
      services,
      to: "own",
      ownServer: OWN_ANSWERS,
      hostKey: ED25519_FINGERPRINT,
      empty: ["db"],
    });
    expect(session.plan.retarget).toMatchObject({ step: "started", empty: ["db"] });
    expect(session.plan.target).toMatchObject({ provider: "own", access: "public" });
    const recorded = await readServerAddresses(h.paths);
    expect(recorded.own).toMatchObject({ host: NEW_IPV4, hostKey: ED25519_FINGERPRINT });
    expect(recorded.retarget?.from).toEqual({ ipv4: OLD_IPV4, ipv6: OLD_IPV6 });
    expect(await readFile(h.paths.files.plan, "utf8")).not.toContain(NEW_IPV4);
    expect(h.reporter.text()).not.toContain(NEW_IPV4);
  });

  it("records the Portainer's answers and the address its records point to, with records OpsCrew manages", async () => {
    const h = await moveHarness();
    h.deps.env.PORTAINER_API_KEY = PORTAINER_TOKEN;
    const services: RetargetServices = {
      ...h.services,
      portainer: portainerServices(h.hosts.docker(PORTAINER)),
    };
    let summary: RetargetSummary | undefined;
    const session = await startMove(h.deps, h.plan, {
      services,
      to: "portainer",
      portainer: PORTAINER_ANSWERS,
      portainerAddress: { ipv4: NEW_IPV4 },
      confirmStart: async (s) => {
        summary = s;
        return true;
      },
    });
    expect(session.plan.target).toMatchObject({
      provider: "portainer",
      environmentId: 3,
      web: { mode: "caddy", records: true },
    });
    // About 15 MB/s through Portainer's proxy: 50 MB fit in its first minute.
    expect(summary?.expectedDowntimeMinutes).toBe(3);
    expect(summary?.steps[2]).toContain("set up the app's stacks there");
    const recorded = await readServerAddresses(h.paths);
    expect(recorded.portainer).toMatchObject({ environmentId: 3 });
    expect(recorded.retarget).toMatchObject({ next: { ipv4: NEW_IPV4 } });
    expect(h.reporter.text()).not.toContain(new URL(PORTAINER_URL).hostname);
  });
});
