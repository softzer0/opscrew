import { writeFile } from "node:fs/promises";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { APP_HOST, DATA_HOST, splitWorld } from "../status/__fixtures__/split";
import { FakeGitHub, HOST_KEY } from "../testing";
import { environmentCheckKey, provisionCheck } from "./provision";
import { checkServerEntries } from "./servers";

const APP_REACH = {
  host: APP_HOST,
  port: 22,
  user: "deploy",
  knownHosts: `${APP_HOST} ${HOST_KEY}\n`,
};

/** The split app with both servers' host keys pinned on this computer. */
async function world(options: Parameters<typeof splitWorld>[0] = {}) {
  const split = await splitWorld(options);
  await writeFile(
    split.deps.paths.files.knownHosts,
    `${APP_HOST} ${HOST_KEY}\n${DATA_HOST} ${HOST_KEY}\n`,
  );
  return split;
}

describe("checkServerEntries: the check's server list (FR-1811)", () => {
  it("lists the app's server and each extra server by its plan name, as deploy", async () => {
    const { deps, plan } = await world();
    expect(await checkServerEntries(deps, plan, APP_REACH)).toEqual([
      { id: "app", ...APP_REACH },
      {
        id: "data",
        host: DATA_HOST,
        port: 22,
        user: "deploy",
        knownHosts: `${DATA_HOST} ${HOST_KEY}\n`,
      },
    ]);
  });

  it("lists only the extra servers when the app's disk is read on its own runner", async () => {
    const { deps, plan } = await world();
    expect((await checkServerEntries(deps, plan, undefined)).map((e) => e.id)).toEqual(["data"]);
  });

  it("gives the private addresses, with the same host keys, once public SSH is closed", async () => {
    const { deps, plan, prefix } = await world({
      network: (network) => ({ ...network, publicSsh: false }),
    });
    const entries = await checkServerEntries(deps, plan, APP_REACH);
    expect(entries).toEqual([
      { id: "app", ...APP_REACH, host: `${prefix}.1`, knownHosts: `${prefix}.1 ${HOST_KEY}\n` },
      {
        id: "data",
        host: `${prefix}.2`,
        port: 22,
        user: "deploy",
        knownHosts: `${prefix}.2 ${HOST_KEY}\n`,
      },
    ]);
  });

  it("stops when an extra server's host key is not pinned on this computer", async () => {
    const { deps, plan } = await world();
    await writeFile(deps.paths.files.knownHosts, `${APP_HOST} ${HOST_KEY}\n`);
    await expect(checkServerEntries(deps, plan, APP_REACH)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("host key of server data is not pinned"),
    });
  });
});

describe("provisionCheck with extra servers", () => {
  it("stores the key and every server, the extra ones only, where the app deploys on its own runner", async () => {
    const split = await world({ network: (network) => ({ ...network, publicSsh: false }) });
    const plan = DeployPlanSchema.parse({
      ...split.plan,
      environment: { runner: "server" },
      observability: { check: { enabled: true } },
    });
    const github = new FakeGitHub();
    const key = await environmentCheckKey(split.deps, plan);
    expect(key).toBeDefined();
    let asked = false;
    const host = await provisionCheck(split.deps, {
      plan,
      github: { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
      ...(key === undefined ? {} : { key }),
      server: {
        remote: split.remote(APP_HOST),
        runAs: "login",
        apply: async () => {
          throw new Error("no host plan on the app's server");
        },
        hasKey: async () => {
          asked = true;
          return false;
        },
        reach: APP_REACH,
      },
      storeSecrets: true,
      services: {},
      command: "opscrew provision",
      phase: "provision",
    });
    expect(host).toBeUndefined();
    expect(asked).toBe(false);
    expect(github.secrets.has("OPSCREW_CHECK_SSH_KEY")).toBe(true);
    const list = JSON.parse(github.secrets.get("OPSCREW_CHECK_SERVER") ?? "[]");
    expect(list).toEqual([
      {
        id: "data",
        host: `${split.prefix}.2`,
        port: 22,
        user: "deploy",
        knownHosts: `${split.prefix}.2 ${HOST_KEY}\n`,
      },
    ]);
  });
});
