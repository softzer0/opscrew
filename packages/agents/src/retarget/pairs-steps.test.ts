import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findExecutable } from "@opscrew/core";
import {
  DEPLOY_SECRETS,
  PORTAINER_DEPLOY_SECRETS,
  PORTAINER_IMAGE_PLACEHOLDER,
} from "@opscrew/iac-templates";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { readServerAddresses, writeRenderedFiles } from "../shared";
import { DOMAIN, ED25519, freshFacts, OLD_IPV4 } from "../testing";
import { NEW_IPV4, PORTAINER, pairHarness } from "./__fixtures__/pairs";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";
import { oldSideTarget } from "./layouts";
import { moveOf, renderFiles, useLayout } from "./session";
import {
  deployFilesChanged,
  deployStep,
  prepareStep,
  proposeDeployFiles,
  storeDeploySecrets,
} from "./steps";
import { switchStep } from "./switch";

const MAIN_TF = "opscrew/infra/prod/main.tf";
/** The server's committed Compose file and Portainer's stack template share this path. */
const COMPOSE = "opscrew/runtime/compose.yaml";

describe.skipIf(!findExecutable("git"))(
  "step deployed, for the user's own server and Portainer",
  () => {
    it("a workflow that differs for the new side waits for its pull request, then deploys once it is merged", async () => {
      const h = await pairHarness("hetzner", "own", { step: "created", ownPort: 2222 });
      const stop = await deployStep(h.session, {});
      expect(stop).toMatchObject({ step: "created", done: false });
      expect(stop?.next.join(" ")).toContain("The deploy files for your new server differ");
      expect(stop?.next.join(" ")).toContain("opscrew retarget");
      expect(h.github.runs).toEqual([]);
      expect(h.handler.requests.some((r) => r.kind === "pull-request")).toBe(true);
      // The secrets point to the new side already: once merged, every push deploys there.
      expect(h.github.secrets.get("OPSCREW_HOST")).toBe(NEW_IPV4);
      expect(h.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
        `[${NEW_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`,
      );

      // Not merged yet: it stops again, opening nothing new.
      expect(await deployStep(h.session, {})).toMatchObject({ done: false });

      // Merged on GitHub: the deploy runs, the app answers there, and its edge stops.
      await h.git(h.root, "push", h.bare, "HEAD:refs/heads/main");
      expect(await deployStep(h.session, {})).toBeUndefined();
      expect(moveOf(h.session).step).toBe("deployed");
      expect(h.github.runs).toHaveLength(1);
      expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: true, caddy: false });
    });

    it("an abort after the workflow's pull request was merged proposes the old side's workflow back", async () => {
      const h = await pairHarness("hetzner", "own", { step: "created", ownPort: 2222 });
      await deployStep(h.session, {});
      await h.git(h.root, "push", h.bare, "HEAD:refs/heads/main");
      expect(await deployStep(h.session, {})).toBeUndefined();
      // The user is back on the merged main, as after any merged pull request.
      await h.git(h.root, "fetch", h.bare, "main");
      await h.git(h.root, "checkout", "-B", "main", "FETCH_HEAD");
      const before = h.handler.requests.filter((r) => r.kind === "pull-request").length;
      const result = await abortRetarget(h.deps, {
        services: h.services,
        confirm: async () => true,
      });
      expect(result).toMatchObject({ step: "aborted", done: true });
      expect(h.handler.requests.filter((r) => r.kind === "pull-request").length).toBe(before + 1);
      expect(result.next.join(" ")).toContain("it puts the deploy files for Hetzner Cloud back");
    });

    it("a password-logins choice on the new own server names what the move offers", async () => {
      const h = await pairHarness("hetzner", "own", { step: "renamed" });
      h.services.own.host.facts = freshFacts({
        loginUsers: [{ name: "alice", uid: 1001, password: true, keys: false }],
      });
      const error = await prepareStep(h.session, {}).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        hint: expect.stringContaining("`opscrew retarget --password-logins off`"),
      });
      expect((error as { hint: string }).hint).not.toContain("opscrew provision --password-logins");
      expect(h.services.own.host.applies).toEqual([]);
    });

    it("from Portainer to a cloud server: the server's Compose file goes into the pull request with the workflow, replacing Portainer's stack template", async () => {
      const h = await pairHarness("portainer", "hetzner", { step: "created" });
      // GitHub's branch holds the Portainer side's deploy files, as after a move into Portainer.
      const portainerPlan = { ...h.session.plan, target: oldSideTarget(moveOf(h.session)) };
      const committed = (await renderFiles(h.session, undefined, portainerPlan, "fromOwn")).filter(
        (file) => file.kind !== "infra",
      );
      expect(committed.find((f) => f.path === COMPOSE)?.content).toContain(
        PORTAINER_IMAGE_PLACEHOLDER,
      );
      await writeRenderedFiles(h.root, committed);
      await h.git(h.root, "add", ...committed.map((file) => file.path));
      await h.git(h.root, "commit", "-m", "Portainer's deploy files");
      await h.git(h.root, "push", h.bare, "HEAD:refs/heads/main");

      const stop = await deployStep(h.session, {});
      expect(stop?.next.join(" ")).toContain(
        "The deploy files for the new server on Hetzner Cloud differ",
      );
      expect(h.github.runs).toEqual([]);
      const proposed = (await h.git(h.root, "show", "--name-only", "--format=", "HEAD")).split(
        "\n",
      );
      expect(proposed).toEqual(expect.arrayContaining([COMPOSE, h.plan.cicd.workflowPath]));
      const compose = await h.git(h.root, "show", `HEAD:${COMPOSE}`);
      expect(compose).not.toContain(PORTAINER_IMAGE_PLACEHOLDER);
      expect(compose).toContain("services:");

      // Merged on GitHub: the server's deploy runs with them.
      await h.git(h.root, "push", h.bare, "HEAD:refs/heads/main");
      expect(await deployStep(h.session, {})).toBeUndefined();
      expect(h.github.runs).toHaveLength(1);
    });

    it("keeps a newer image pin GitHub's branch holds (Dependabot's) in the proposed Compose file", async () => {
      const h = await pairHarness("portainer", "hetzner", { step: "created" });
      const portainerPlan = { ...h.session.plan, target: oldSideTarget(moveOf(h.session)) };
      const template = (await renderFiles(h.session, undefined, portainerPlan, "fromOwn")).find(
        (file) => file.path === COMPOSE,
      );
      const server = (await renderFiles(h.session)).find((file) => file.path === COMPOSE);
      // An image both files pin, with another digest on GitHub's branch.
      const pins = (text = ""): string[] =>
        text.match(/[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}/g) ?? [];
      const shared = pins(server?.content).find((pin) => pins(template?.content).includes(pin));
      expect(shared).toBeDefined();
      const bumped = `${shared?.split("@")[0]}@sha256:${"0".repeat(64)}`;
      await mkdir(dirname(join(h.root, COMPOSE)), { recursive: true });
      await writeFile(join(h.root, COMPOSE), template?.content.replace(shared ?? "", bumped) ?? "");
      await h.git(h.root, "add", COMPOSE);
      await h.git(h.root, "commit", "-m", "Dependabot's newer pin");
      await h.git(h.root, "push", h.bare, "HEAD:refs/heads/main");

      expect(await proposeDeployFiles(h.session, h.session.plan)).toMatchObject({
        kind: "proposed",
      });
      const compose = await h.git(h.root, "show", `HEAD:${COMPOSE}`);
      expect(compose).toContain(bumped);
      expect(compose).not.toContain(PORTAINER_IMAGE_PLACEHOLDER);
    });

    it("from a server to Portainer: Portainer's stack template goes into the pull request with its workflow", async () => {
      const h = await pairHarness("own", "portainer", { step: "created" });
      expect(await deployFilesChanged(h.session)).toBe(true);
      expect(await proposeDeployFiles(h.session, h.session.plan)).toMatchObject({
        kind: "proposed",
      });
      const proposed = (await h.git(h.root, "show", "--name-only", "--format=", "HEAD")).split(
        "\n",
      );
      expect(proposed).toEqual(expect.arrayContaining([COMPOSE, h.plan.cicd.workflowPath]));
      expect(await h.git(h.root, "show", `HEAD:${COMPOSE}`)).toContain(PORTAINER_IMAGE_PLACEHOLDER);
    });

    it("between two cloud servers whose deploy files are the same: no pull request, the deploy runs at once", async () => {
      const h = await pairHarness("hetzner", "digitalocean", { step: "created" });
      expect(await deployFilesChanged(h.session)).toBe(false);
      expect(await deployStep(h.session, {})).toBeUndefined();
      expect(moveOf(h.session).step).toBe("deployed");
      expect(h.handler.requests.some((r) => r.kind === "pull-request")).toBe(false);
      expect(h.github.runs).toHaveLength(1);
    });

    it("a workflow that stays the same deploys at once", async () => {
      const h = await pairHarness("hetzner", "own", { step: "created" });
      expect(await deployStep(h.session, {})).toBeUndefined();
      expect(moveOf(h.session).step).toBe("deployed");
      expect(h.handler.requests.some((r) => r.kind === "pull-request")).toBe(false);
    });

    it("stores Portainer's deploy secrets for a Portainer side: the build's values, never a server's", async () => {
      const h = await pairHarness("own", "portainer", { step: "created" });
      await storeDeploySecrets(h.session, "new");
      expect(h.github.secrets.has("OPSCREW_BUILD_ENV")).toBe(true);
      expect(h.github.secrets.has("OPSCREW_HOST")).toBe(false);
      expect(h.github.secrets.has("OPSCREW_SSH_KEY")).toBe(false);
      const record = JSON.parse(await readFile(h.paths.files.deploySecrets, "utf8"));
      expect(record).toMatchObject({ host: "portainer" });
      // Back to the user's own old server on abort: its public address, its login's host key.
      await storeDeploySecrets(h.session, "old");
      expect(h.github.secrets.get("OPSCREW_HOST")).toBe(OLD_IPV4);
      expect(h.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
        `${OLD_IPV4} ssh-ed25519 ${ED25519}\n`,
      );
      expect(h.reporter.text()).not.toContain(OLD_IPV4);
    });
  },
);

describe.skipIf(!findExecutable("git"))("the deploy secrets of the other kind of side", () => {
  /** What only a side over SSH stores: the deploy key, its address and host key, the app's values. */
  const SERVER_ONLY = [
    DEPLOY_SECRETS.appEnv,
    DEPLOY_SECRETS.host,
    DEPLOY_SECRETS.originTls,
    DEPLOY_SECRETS.knownHosts,
    DEPLOY_SECRETS.sshKey,
  ];

  it("an abort back to Portainer deletes the secrets the new server's side stored", async () => {
    const h = await pairHarness("portainer", "hetzner", { step: "deployed" });
    // The app's domain has origin TLS: its certificate is among the server's secrets.
    h.session.site = {
      edge: { originTls: { hostnames: [DOMAIN] } },
      values: { ORIGIN_TLS_CERT: "origin certificate", ORIGIN_TLS_KEY: "origin key" },
    };
    await storeDeploySecrets(h.session, "new");
    for (const name of SERVER_ONLY) expect(h.github.secrets.has(name)).toBe(true);

    const result = await abortRetarget(h.deps, { services: h.services, confirm: async () => true });
    expect(result).toMatchObject({ step: "aborted", done: true });
    for (const name of SERVER_ONLY) expect(h.github.secrets.has(name)).toBe(false);
    expect(h.github.secrets.has(DEPLOY_SECRETS.buildEnv)).toBe(true);
    const approval = h.handler.requests.filter((r) => r.kind === "github-secrets").at(-1);
    expect(approval?.details).toContain("Deleted, since the deploy no longer reads them");
  });

  it("a move from Portainer to a server deletes the secrets only Portainer's deploy read", async () => {
    const h = await pairHarness("portainer", "hetzner", { step: "created" });
    // Portainer's redeploy through Cloudflare stored its webhook's secrets from this computer.
    const portainerOnly = Object.values(PORTAINER_DEPLOY_SECRETS);
    const stored = [DEPLOY_SECRETS.buildEnv, DEPLOY_SECRETS.buildSecrets, ...portainerOnly];
    for (const name of stored) h.github.secrets.set(name, "stored");
    const repo = `${h.session.github.owner}/${h.session.github.repo}`;
    await writeFile(
      h.paths.files.deploySecrets,
      `${JSON.stringify({ host: "portainer", repo, names: stored })}
`,
    );

    await storeDeploySecrets(h.session, "new");
    for (const name of portainerOnly) expect(h.github.secrets.has(name)).toBe(false);
    expect(h.github.secrets.get(DEPLOY_SECRETS.host)).toBe(NEW_IPV4);
    expect(h.github.secrets.has(DEPLOY_SECRETS.buildEnv)).toBe(true);
  });

  it("a move from a server to Portainer deletes the server's secrets once they point to Portainer, so a finished move leaves none", async () => {
    const h = await pairHarness("own", "portainer", { step: "created" });
    await storeDeploySecrets(h.session, "old");
    expect(h.github.secrets.has(DEPLOY_SECRETS.host)).toBe(true);
    await storeDeploySecrets(h.session, "new");
    for (const name of SERVER_ONLY) expect(h.github.secrets.has(name)).toBe(false);
    expect(h.github.secrets.has(DEPLOY_SECRETS.buildEnv)).toBe(true);
  });

  it("a move between two servers deletes nothing the new one still needs", async () => {
    const h = await pairHarness("own", "hetzner", { step: "created" });
    await storeDeploySecrets(h.session, "old");
    const before = [...h.github.secrets.keys()].sort();
    h.handler.requests.length = 0;
    await storeDeploySecrets(h.session, "new");
    expect([...h.github.secrets.keys()].sort()).toEqual(before);
    expect(h.github.secrets.get(DEPLOY_SECRETS.host)).toBe(NEW_IPV4);
    const approval = h.handler.requests.find((r) => r.kind === "github-secrets");
    expect(approval?.details).not.toContain("Deleted");
  });
});

describe.skipIf(!findExecutable("git"))("the DNS switch's layouts, for every pair", () => {
  it.each([
    ["own", "hetzner", { previous: OLD_IPV4 }],
    ["hetzner", "own", { server: NEW_IPV4 }],
    ["own", "own", { server: NEW_IPV4, previous: OLD_IPV4 }],
    ["hetzner", "portainer", { server: NEW_IPV4 }],
    ["portainer", "own", { server: NEW_IPV4, previous: OLD_IPV4 }],
  ] as const)(
    "%s to %s: an address side's records point at it through TF_VAR, never a file",
    async (from, to, vars) => {
      const h = await pairHarness(from, to, { step: "migrated" });
      const files = await useLayout(h.session, "switched");
      expect(h.session.env.TF_VAR_server_ipv4).toBe("server" in vars ? vars.server : undefined);
      expect(h.session.env.TF_VAR_previous_server_ipv4).toBe(
        "previous" in vars ? vars.previous : undefined,
      );
      const written = files.map((file) => file.content).join("\n");
      for (const ip of [OLD_IPV4, NEW_IPV4]) expect(written).not.toContain(ip);
      const main = await readFile(join(h.root, MAIN_TF), "utf8");
      expect(main).toContain('module "dns"');
      expect(main).not.toContain("import {");
    },
  );

  it("adopts a Portainer old side's records, still the user's, with import blocks", async () => {
    const h = await pairHarness("portainer", "own", { step: "migrated", userRecords: true });
    expect(h.session.adoptRecords).toEqual({ a: expect.any(String), aaaa: expect.any(String) });
    await useLayout(h.session, "switched");
    const main = await readFile(join(h.root, MAIN_TF), "utf8");
    expect(main).toContain("to = module.dns.cloudflare_dns_record.a");
    expect(main).toContain(`id = "`);
    // The old side's address is where the user's record points.
    expect(h.session.env.TF_VAR_previous_server_ipv4).toBe(OLD_IPV4);
    expect(DOMAIN).toBeTruthy();
  });

  it("switches end to end between two address sides: the adopting plan passes the update-only check", async () => {
    const h = await pairHarness("portainer", "own", { step: "migrated", userRecords: true });
    h.hosts.host(NEW_IPV4).caddy = false;
    expect(await switchStep(h.session, {})).toBeUndefined();
    expect(moveOf(h.session).step).toBe("switched");
    // The records were imported and updated in place to the new side's address.
    const main = await readFile(join(h.root, MAIN_TF), "utf8");
    expect(main).toContain("to = module.dns.cloudflare_dns_record.a");
    expect(h.events.filter((e) => e.type === "apply")).toEqual([
      expect.objectContaining({
        updates: expect.arrayContaining([expect.stringMatching(/^module\.dns\./)]),
      }),
    ]);
    expect(h.engine.dnsServer()?.ipv4).toBe(NEW_IPV4);
    // Applied, they are OpsCrew's now: the old target says so.
    expect(moveOf(h.session).from.target).toMatchObject({ web: { records: true } });
    expect(h.session.adoptRecords).toBeUndefined();
  });

  it("once a plan adopted them, the Portainer old side's records are OpsCrew's, so an abort keeps them", async () => {
    const h = await pairHarness("portainer", "hetzner", { step: "renamed", userRecords: true });
    // No server of the move is in the state yet: the create step's plan makes the new one.
    h.engine.state.servers = {};
    expect(await prepareStep(h.session, {})).toBeUndefined();
    expect(moveOf(h.session).step).toBe("created");
    const main = await readFile(join(h.root, MAIN_TF), "utf8");
    expect(main).toContain("to = module.dns.cloudflare_dns_record.a");
    const from = moveOf(h.session).from.target;
    expect(from).toMatchObject({ provider: "portainer", web: { mode: "caddy", records: true } });
    expect(h.session.adoptRecords).toBeUndefined();
    const onDisk = (await readArtifact("plan", h.paths.files.plan)).retarget?.from.target;
    expect(onDisk).toMatchObject({ web: { records: true } });
  });
});

describe.skipIf(!findExecutable("git"))(
  "--finish and --abort, end to end, for an own and a Portainer old side",
  () => {
    it("--finish from the user's own server takes only the app off it, then publishes the final files", async () => {
      const h = await pairHarness("own", "hetzner", { step: "switched", dns: "none" });
      h.hosts.host(NEW_IPV4).caddy = true;
      const result = await finishRetarget(h.deps, {
        services: h.services,
        confirm: async () => true,
      });
      expect(result).toMatchObject({ step: "finished", done: true });
      // Only the app's teardown host plan: the server itself stays.
      expect(h.services.own.host.applies.map((a) => a.plan.purpose)).toEqual(["teardown"]);
      expect(h.events.filter((e) => e.type === "apply")).toEqual([]);
      const plan = await readArtifact("plan", h.paths.files.plan);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target).toMatchObject({ provider: "hetzner" });
      // The old server's host keys are forgotten, its admin login's too.
      expect(await readFile(h.paths.files.knownHosts, "utf8")).not.toContain(OLD_IPV4);
      expect((await readServerAddresses(h.paths)).retarget).toBeUndefined();
      expect(h.reporter.text()).toContain("the app is removed from your old server");
    });

    it("--abort back to the user's own server removes the new cloud server and points the secrets back", async () => {
      const h = await pairHarness("own", "hetzner", { step: "deployed", dns: "none" });
      const result = await abortRetarget(h.deps, {
        services: h.services,
        confirm: async () => true,
      });
      expect(result).toMatchObject({ step: "aborted", done: true });
      expect(h.events.filter((e) => e.type === "apply").map((e) => e.type)).toContain("apply");
      expect(h.github.secrets.get("OPSCREW_HOST")).toBe(OLD_IPV4);
      const plan = await readArtifact("plan", h.paths.files.plan);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target).toMatchObject({ provider: "own" });
      // The old side's login is back in its slot.
      expect((await readServerAddresses(h.paths)).own).toMatchObject({ host: OLD_IPV4 });
    });

    it("--finish from Portainer stops its app, removes what is left of it, and finishes", async () => {
      const h = await pairHarness("portainer", "hetzner", { step: "switched", dns: "none" });
      h.hosts.host(NEW_IPV4).caddy = true;
      const result = await finishRetarget(h.deps, {
        services: h.services,
        confirm: async () => true,
      });
      expect(result).toMatchObject({ step: "finished", done: true });
      const app = [...h.hosts.docker(PORTAINER).containers.values()].find(
        (c) => c.labels["com.docker.compose.service"] === "app",
      );
      expect(app?.state).toBe("exited");
      expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();
      expect(h.events.filter((e) => e.type === "apply")).toEqual([]);
    });

    it("--abort back to Portainer removes the new cloud server and stores Portainer's deploy secrets again", async () => {
      // Caddy in the app's stack serves a domain: OpsCrew manages its records there.
      const h = await pairHarness("portainer", "hetzner", { step: "deployed" });
      const result = await abortRetarget(h.deps, {
        services: h.services,
        confirm: async () => true,
      });
      expect(result).toMatchObject({ step: "aborted", done: true });
      const plan = await readArtifact("plan", h.paths.files.plan);
      expect(plan.target).toMatchObject({ provider: "portainer" });
      expect(h.github.secrets.has("OPSCREW_BUILD_ENV")).toBe(true);
      expect((await readServerAddresses(h.paths)).portainer).toMatchObject({ environmentId: 3 });
    });
  },
);
