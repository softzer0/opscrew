import { rm } from "node:fs/promises";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments/paths";
import { localPlan } from "../localhost/__fixtures__/computer";
import { networked, splitPlan } from "../network/__fixtures__/plans";
import { readServerAddresses, serverAddress, updateServerAddresses } from "../shared";
import { appMemoryMb } from "../shared/memory";
import {
  HOST_ENV,
  HOST_IPV4,
  HOST_KEY,
  hostTestPlan,
  ownPlan,
  portainerPlan,
  previewTestPlan,
  sharedPreviewTestPlan,
  withLaptop,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import { fakeShell, HOST_SSH_PORT, LIST_OUTPUT, sharedPreviewProject } from "./__fixtures__/plan";
import { destroyPreview } from "./destroy";
import {
  previewServer,
  previewServerAddress,
  requireHostApps,
  requireNoForeignPreviews,
  requireNoSharedPreviews,
  shareableHost,
  sharedPreviewsLimit,
  sharedServerReach,
  sharedServerWarning,
} from "./host";
import { listPreviews } from "./list";
import { previewLogs } from "./logs";

/** A fake deploy shell that also keeps the host each connection went to. */
function hostShell(stdout: string) {
  const hosts: string[] = [];
  const shell = fakeShell(() => ({ exitCode: 0, stdout }));
  return {
    hosts,
    commands: shell.commands,
    remote: (host: string) => {
      hosts.push(host);
      return shell.remote(host);
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe.each([
  ["a server OpsCrew created", false],
  ["the user's own server", true],
])("previews on dev's server, %s", (_name, own) => {
  it("reach it through dev's deploy login, at dev's address, for list, logs and destroy", async () => {
    const { deps, plan } = await sharedPreviewProject({ own });
    const shell = hostShell(`${LIST_OUTPUT}\n`);
    await listPreviews(deps, plan, { services: { remote: shell.remote } });
    const logs = hostShell("== shop-preview-pr-42-app-1 ==\nready\nopscrew-preview: listed 42\n");
    await previewLogs(deps, plan, "42", { services: { remote: logs.remote } });
    const down = hostShell("opscrew-preview: removed 42\n");
    await destroyPreview(deps, plan, "42", { services: { remote: down.remote } });
    expect([...shell.hosts, ...logs.hosts, ...down.hosts]).toEqual([
      HOST_IPV4,
      HOST_IPV4,
      HOST_IPV4,
    ]);
    expect(shell.commands).toEqual(["/srv/apps/shop-preview/bin/opscrew-preview list"]);
    expect(down.commands).toEqual(["/srv/apps/shop-preview/bin/opscrew-preview down 42"]);
    // Audited as dev's server, never by its address; nothing of it said.
    expect(deps.audit.entries.map((entry) => entry.target)).toEqual(
      expect.arrayContaining(["dev's server"]),
    );
    const said = [deps.reporter.text(), JSON.stringify(deps.audit.entries)].join("\n");
    expect(said).not.toContain(HOST_IPV4);
    // Nothing of dev's server is copied into the preview environment's state.
    expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });
  });

  it("needs dev's deploy key on this computer", async () => {
    const { deps, plan, host } = await sharedPreviewProject({ own });
    await rm(host.files.deployKey);
    const shell = hostShell(`${LIST_OUTPUT}\n`);
    const error = await failure(listPreviews(deps, plan, { services: { remote: shell.remote } }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(shell.hosts).toEqual([]);
  });

  it("give GitHub dev's address and pinned host key, and the preview root dev's address", async () => {
    const { deps, plan } = await sharedPreviewProject({ own });
    const server = await previewServer(deps, plan);
    expect(server.host).toBe(HOST_ENV);
    expect(server.deps.paths.environment).toBe(HOST_ENV);
    const port = own ? HOST_SSH_PORT : 22;
    const name = own ? `[${HOST_IPV4}]:${port}` : HOST_IPV4;
    expect(await sharedServerReach(server)).toEqual({
      host: HOST_IPV4,
      knownHosts: `${name} ${HOST_KEY}\n`,
      sshPort: port,
    });
    expect(await previewServerAddress(server)).toEqual({ ipv4: HOST_IPV4 });
    // The preview environment has no address of its own, and never records dev's.
    expect(await serverAddress(deps, plan)).toBeUndefined();
    expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });
  });
});

describe("previewServer", () => {
  it("is the preview environment's own server without previews.server", async () => {
    const { deps } = await sharedPreviewProject();
    const plan = previewTestPlan();
    const server = await previewServer(deps, plan);
    expect(server).toEqual({ deps, plan });
  });

  it("refuses while dev has no plan or is not provisioned", async () => {
    const { deps, plan, host } = await sharedPreviewProject();
    await writeArtifact("plan", host.files.plan, hostTestPlan({ deployed: false }));
    const error = await failure(previewServer(deps, plan));
    expect(error.message).toBe(
      "The previews run on dev's server, and dev is not provisioned on this computer. Nothing was changed.",
    );
    expect(error.hint).toContain("`opscrew provision --env dev`");
  });
});

describe("the host environment while previews run on its server", () => {
  it("refuses what would break them, naming `opscrew destroy --env preview`", async () => {
    const { deps, host } = await sharedPreviewProject();
    const error = await failure(
      requireNoSharedPreviews(host, "destroying dev", "opscrew destroy --env dev"),
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The previews of the preview environment run on dev's server, and destroying dev would break them. Nothing was changed.",
      hint: "Remove them first with `opscrew destroy --env preview` (it leaves dev's server as it is), then run `opscrew destroy --env dev` again.",
    });
    // Not while the previews are not provisioned, nor for another environment.
    const plan = sharedPreviewTestPlan();
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({ ...plan, deployment: {} }),
    );
    await requireNoSharedPreviews(host, "destroying dev", "opscrew destroy --env dev");
    await requireNoSharedPreviews(
      environmentPaths(deps.paths, "prod"),
      "destroying prod",
      "opscrew destroy --env prod",
    );
  });

  it("counts the previews' memory while a preview environment names it", async () => {
    const { deps, host, plan } = await sharedPreviewProject();
    const limit = await sharedPreviewsLimit(host);
    expect(limit?.name).toBe("the previews of preview");
    expect(limit?.memoryMb).toBe(3 * appMemoryMb(plan));
    expect(await sharedPreviewsLimit(deps.paths)).toBeUndefined();
    expect(await sharedPreviewsLimit(environmentPaths(deps.paths, "prod"))).toBeUndefined();
  });
});

describe("shareableHost", () => {
  const check = { preview: "preview", again: "opscrew env add preview --previews" };

  async function hostRefusal(plan: DeployPlan | undefined, name = HOST_ENV) {
    const { deps, host } = await sharedPreviewProject();
    if (plan !== undefined) await writeArtifact("plan", host.files.plan, plan);
    return failure(shareableHost(deps, name, check));
  }

  it("is dev's server when dev's plan allows it", async () => {
    const { deps } = await sharedPreviewProject();
    const server = await shareableHost(deps, HOST_ENV, check);
    expect(server.host).toBe(HOST_ENV);
    expect(server.plan.app.name).toBe("shop-dev");
  });

  it.each([
    ["prod", undefined, "prod", "Previews never run on prod's server"],
    [
      "the preview environment itself",
      undefined,
      "preview",
      "preview is the preview environment itself",
    ],
    ["an environment the app lacks", undefined, "staging", "The app has no staging environment."],
    [
      "a preview environment",
      DeployPlanSchema.parse({
        ...previewTestPlan(),
        app: { ...previewTestPlan().app, name: "shop-dev" },
        environment: { ...previewTestPlan().environment, name: HOST_ENV },
      }),
      HOST_ENV,
      "dev is a preview environment",
    ],
    ["Portainer", portainerPlan({ deployed: true }), HOST_ENV, "dev runs in your Portainer"],
    ["this computer", localPlan(), HOST_ENV, "dev runs on this computer"],
    ["a site", sitePlan(), HOST_ENV, "dev is a site without a server of its own"],
    [
      "a tunnel",
      DeployPlanSchema.parse({
        ...hostTestPlan({ own: true }),
        target: { ...hostTestPlan({ own: true }).target, access: "tunnel" },
      }),
      HOST_ENV,
      "dev's server is served through a Cloudflare Tunnel and takes no public SSH",
    ],
    [
      "nginx",
      DeployPlanSchema.parse({
        ...hostTestPlan(),
        target: { ...hostTestPlan().target, edge: "nginx" },
      }),
      HOST_ENV,
      "dev's server runs nginx as its proxy",
    ],
    [
      "dev not provisioned",
      hostTestPlan({ deployed: false }),
      HOST_ENV,
      "dev is not provisioned yet",
    ],
  ])("refuses %s before any change", async (_case, plan, name, said) => {
    const error = await hostRefusal(plan, name);
    expect(error.message).toContain(said);
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toContain("opscrew env add preview --previews");
  });

  it("warns plainly what sharing risks", () => {
    expect(sharedServerWarning("dev")).toBe(
      "Anyone who can push a branch to this repository then runs code on dev's server, beside its data and secrets. If that code escaped its container, it could reach them. Without escaping, it reaches whatever dev's server serves to the internet (its web ports), as any visitor can. Use it only when dev holds test data and test keys.",
    );
  });

  it("refuses dev's own server when prod's own server is at the same address", async () => {
    const { deps } = await sharedPreviewProject({ own: true });
    const prod = environmentPaths(deps.paths, "prod");
    await writeArtifact("plan", prod.files.plan, ownPlan({ deployed: true }));
    await updateServerAddresses(prod, (current) => ({
      ...current,
      deployment: { ipv4: HOST_IPV4 },
    }));
    const error = await failure(shareableHost(deps, HOST_ENV, check));
    expect(error.message).toBe(
      "prod runs on dev's server too, and previews never run beside prod's data. Nothing was changed.",
    );
    // Another address is another server.
    await updateServerAddresses(prod, (current) => ({
      ...current,
      deployment: { ipv4: "198.51.100.41" },
    }));
    expect((await shareableHost(deps, HOST_ENV, check)).host).toBe(HOST_ENV);
  });

  it("refuses a server on a private network, naming what a preview could reach there", async () => {
    // dev's Postgres on its server `data`, both on dev's private network.
    const split = networked({
      ...splitPlan(),
      app: { ...splitPlan().app, name: "shop-dev" },
      environment: { name: HOST_ENV, deploySource: { from: "main" }, runner: "github" },
      deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" },
    }).plan;
    const servers = await hostRefusal(split);
    expect(servers.message).toBe(
      "dev's server is on a private network, and a preview's containers there could reach server data without escaping anything: traffic within the server passes no firewall. Turn it off on dev first, or give the previews a server of their own. Nothing was changed.",
    );

    // One server, with a device that has its own login to the database, and Beszel's hub.
    const laptop = withLaptop(hostTestPlan());
    const devices = DeployPlanSchema.parse({
      ...laptop,
      network: {
        ...laptop.network,
        grants: [{ device: "laptop", service: "db", access: "read-only" }],
      },
      observability: {
        beszel: {
          enabled: true,
          version: "0.21.1",
          mode: "hub",
          access: "local",
          memoryMb: { hub: 128, agent: 64, proxy: 32 },
        },
      },
    });
    const reach = await hostRefusal(devices);
    expect(reach.message).toContain(
      "a preview's containers there could reach your device, db and Beszel's hub without escaping anything",
    );
    expect(reach.message).toContain("Turn them off on dev first");
    expect(reach.hint).toContain("leave the option out for a server of the previews' own");
  });
});

describe("requireNoSharedPreviews while the preview environment only names dev's server", () => {
  it("refuses with `named`, naming `opscrew env remove`, and lets the rest go on", async () => {
    const { deps, host } = await sharedPreviewProject();
    const plan = sharedPreviewTestPlan();
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({ ...plan, deployment: {} }),
    );
    await requireNoSharedPreviews(host, "destroying dev", "opscrew destroy --env dev");
    await expect(
      requireNoSharedPreviews(host, "removing dev", "opscrew env remove dev", true),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The previews of the preview environment are set up to run on dev's server, and removing dev would break them. Nothing was changed.",
      hint: "Remove that environment first with `opscrew env remove preview`, then run `opscrew env remove dev` again.",
    });
  });
});

describe("requireNoForeignPreviews", () => {
  const recipe = {
    app: "shop-preview",
    files: {},
    values: true,
    tls: true,
    cron: [],
    numbers: [42],
  };

  it("lets dev, whose server the previews share, and the previews' own run there; never prod", async () => {
    const { deps, host, plan } = await sharedPreviewProject({ own: true });
    const facts = { previews: [recipe] };
    await requireNoForeignPreviews(host, hostTestPlan({ own: true }), facts, "opscrew provision");
    await requireNoForeignPreviews(deps.paths, plan, facts, "opscrew provision");
    const prod = environmentPaths(deps.paths, "prod");
    const error = await failure(
      requireNoForeignPreviews(prod, ownPlan(), facts, "opscrew provision --env prod"),
    );
    expect(error.message).toBe(
      'Your server runs the previews of "shop-preview", which run pull requests\' code, and prod would run beside them. Nothing was changed.',
    );
    expect(error.hint).toBe(
      "Remove them first with `opscrew destroy --env preview`, or give prod another server, then run `opscrew provision --env prod` again.",
    );
  });
});

describe("requireHostApps", () => {
  const server = { host: HOST_ENV, plan: hostTestPlan() };
  const input = {
    previewApp: "shop-preview",
    prodApp: "shop",
    again: "opscrew env add preview --previews",
  };

  it("allows dev's app and the previews' own", () => {
    requireHostApps(["shop-dev", "shop-preview", "shop-preview-pr-42"], server, input);
  });

  it("refuses a server prod runs on, and one with other apps", () => {
    expect(() => requireHostApps(["shop-dev", "shop"], server, input)).toThrow(
      "prod runs on dev's server too, and previews never run beside prod's data. Nothing was changed.",
    );
    expect(() => requireHostApps(["shop-dev", "blog"], server, input)).toThrow(
      'dev\'s server also runs "blog", and previews may share a server only with dev itself. Nothing was changed.',
    );
  });
});
