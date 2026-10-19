/**
 * Several OpsCrew apps on one server (feature 013, US5): one record per app, the host record that
 * lists them, the shared parts set up once, and conflicts refused before any change.
 */
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { deployApp, FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  DEPLOY_KEY,
  desiredFor,
  planFor,
  portainerDesired,
  portainerPassword,
  provision,
  removeApp,
  SHOP_PROJECT,
  TUNNEL_COMPOSE,
  TUNNEL_ID,
  tunnelDesired,
  tunnelToken,
} from "./__fixtures__/helpers";
import { AppRecordSchema, HostRecordSchema } from "./facts";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planHost, planTeardown, planUndo } from "./plan";
import type { DesiredHost, HostPlan } from "./types";

const BLOG_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBLOGBLOGBLOGBLOGBLOGBLOGBLOGBLOGBLOGBLOGBLOG opscrew-deploy";

const codes = (plan: HostPlan) => plan.findings.map((finding) => finding.code);
const changes = (plan: HostPlan) =>
  plan.steps.filter((step) => step.state === "change").map((step) => step.id);
const scopes = (plan: HostPlan) => plan.steps.map((step) => [step.id, step.scope]);

function blog(fake: FakeHost, overrides: Partial<DesiredHost> = {}): DesiredHost {
  return desiredFor(fake, {
    app: "blog",
    projectId: "blog-0123456789ab",
    deploy: { user: "deploy", publicKey: BLOG_KEY },
    hostnames: ["blog.example.com"],
    services: ["web", "db"],
    memoryMb: 768,
    ...overrides,
  });
}

/** "blog" served through a Cloudflare Tunnel of its own (`tunnelId`). */
function blogTunnel(fake: FakeHost, tunnelId = TUNNEL_ID): DesiredHost {
  return blog(fake, { access: "tunnel", tunnel: { compose: TUNNEL_COMPOSE, tunnelId } });
}

function hostRecord(fake: FakeHost) {
  return HostRecordSchema.parse(JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "null"));
}

function appRecord(fake: FakeHost, app: string) {
  const text = fake.files.get(`/etc/opscrew/apps/${app}.json`);
  return text === undefined ? undefined : AppRecordSchema.parse(JSON.parse(text));
}

/** A server with "shop" provisioned and deployed (its web container and the shared edge). */
async function withShop(): Promise<FakeHost> {
  const fake = new FakeHost();
  await provision(fake);
  deployApp(fake, "shop");
  return fake;
}

/** A server with "shop" and "blog" provisioned and deployed. */
async function withTwo(): Promise<FakeHost> {
  const fake = await withShop();
  await provision(fake, blog(fake));
  deployApp(fake, "blog");
  return fake;
}

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpsCrewError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("a fresh server and the first app", () => {
  it("marks each item as shared or the app's own, and writes the app's record", async () => {
    const fake = new FakeHost();
    const { plan, result } = await provision(fake);
    expect(codes(plan)).toEqual([]);
    expect(scopes(plan)).toEqual([
      ["docker", "shared"],
      ["docker-daemon", "shared"],
      ["deploy-user", "shared"],
      ["deploy-key", "app"],
      ["sshd", "shared"],
      ["ufw", "shared"],
      ["fail2ban", "shared"],
      ["unattended-upgrades", "shared"],
      ["runtime-dirs", "shared"],
      ["app-dirs", "app"],
      ["app-record", "app"],
    ]);
    expect(result.applied).toEqual(plan.steps.map((step) => step.id));

    expect(appRecord(fake, "shop")).toEqual({
      schemaVersion: 1,
      app: "shop",
      projectId: "shop-0123456789ab",
      state: "active",
      access: "public",
      hostnames: ["shop.example.com", "www.shop.example.com"],
      folders: { app: "/srv/apps/shop", data: "/srv/data/shop" },
      composeProject: "shop",
      services: ["web"],
      memoryMb: 512,
      deployKey: DEPLOY_KEY,
    });
    expect(hostRecord(fake).apps).toEqual(["shop"]);
    expect(fake.files.has("/etc/opscrew/app.json")).toBe(false);
    for (const dir of ["/srv/edge", "/srv/apps", "/srv/data", "/srv/apps/shop", "/srv/data/shop"]) {
      expect(fake.dirs.get(dir), dir).toMatchObject({ owner: "deploy", mode: "750" });
    }
    expect(fake.dirs.has("/srv/app")).toBe(false);
    expect(fake.users.get("deploy")?.keys).toEqual([DEPLOY_KEY]);

    const again = await planFor(fake);
    expect(again.steps.every((step) => step.state === "in-place")).toBe(true);
  });

  it("covers the scope of each item with the plan hash", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake);
    const flipped: HostPlan = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.id === "app-dirs" ? { ...step, scope: "shared" } : step,
      ),
    };
    expect(hostPlanHash(flipped)).not.toBe(hostPlanHash(plan));
  });
});

describe("a second app", () => {
  it("plans only its own items; the shared parts are already in place", async () => {
    const fake = await withShop();
    const plan = await planFor(fake, blog(fake));
    expect(codes(plan)).toEqual([]);
    expect(changes(plan)).toEqual(["deploy-key", "app-dirs", "app-record"]);
    for (const step of plan.steps) {
      expect(step.scope, step.id).toBe(step.state === "change" ? "app" : "shared");
    }
    // Both apps' deploy keys are authorized; the first app's key stays.
    expect(plan.steps.find((step) => step.id === "deploy-key")?.params).toEqual({
      user: "deploy",
      keys: [BLOG_KEY, DEPLOY_KEY].sort().join("\n"),
    });

    const shopContainers = fake.containers.map((container) => container.name);
    await applyApproved(fake, plan);
    expect(fake.containers.map((container) => container.name)).toEqual(shopContainers);
    expect(hostRecord(fake).apps).toEqual(["blog", "shop"]);
    expect(appRecord(fake, "blog")).toMatchObject({
      hostnames: ["blog.example.com"],
      services: ["db", "web"],
      memoryMb: 768,
    });
    expect(appRecord(fake, "shop")?.state).toBe("active");
    expect(fake.users.get("deploy")?.keys.sort()).toEqual([BLOG_KEY, DEPLOY_KEY].sort());
    expect(fake.dirs.get("/srv/apps/blog")).toMatchObject({ owner: "deploy", mode: "750" });
  });

  it("never weakens the SSH hardening another app on the server set up", async () => {
    // "shop" turned password logins off. With a password user added since, "blog" asks to keep
    // passwords on.
    const fake = await withShop();
    fake.users.set("bob", { uid: 1001, password: true, keys: [], groups: ["bob"] });
    const plan = await planFor(fake, blog(fake, { disablePasswords: false }));
    expect(codes(plan)).toEqual([]);
    expect(plan.steps.find((step) => step.id === "sshd")?.state).toBe("in-place");
    await applyApproved(fake, plan);
    expect(fake.files.get("/etc/ssh/sshd_config.d/10-opscrew.conf")).toContain(
      "PasswordAuthentication no",
    );
  });

  it("re-runs the first app's plan without touching the second app's key", async () => {
    const fake = await withTwo();
    const plan = await planFor(fake);
    expect(plan.steps.every((step) => step.state === "in-place")).toBe(true);
  });

  it("keeps the tunnel connector and Portainer of another app, and runs its own connector beside them", async () => {
    // "shop" is served directly, with Portainer on a subdomain through its tunnel connector.
    const fake = new FakeHost();
    const subdomain = { compose: TUNNEL_COMPOSE, tunnelId: TUNNEL_ID };
    await provision(fake, desiredFor(fake, { tunnel: subdomain, portainer: portainerDesired() }), {
      secrets: { tunnelToken: tunnelToken(), portainerPassword: portainerPassword() },
    });
    deployApp(fake, "shop");
    // Without a tunnel or Portainer of its own: both stay for "shop".
    const plain = await planFor(fake, blog(fake));
    expect(codes(plain)).toEqual([]);
    expect(plain.steps.some((step) => ["tunnel-connector", "portainer"].includes(step.id))).toBe(
      false,
    );
    // A tunnel of its own: its own connector, with its own token, next to the one of "shop".
    const other = { compose: TUNNEL_COMPOSE, tunnelId: "0a1b2c3d-2222-4e5f-8a9b-abcdefabcdef" };
    const tunnelled = await planFor(fake, blog(fake, { tunnel: other }));
    expect(codes(tunnelled)).toEqual([]);
    const connector = tunnelled.steps.find((step) => step.id === "tunnel-connector");
    expect(connector).toMatchObject({ state: "change", scope: "app" });
    expect(connector?.params).toMatchObject({ app: "blog", tunnelId: other.tunnelId });
    const shopToken = fake.files.get("/srv/opscrew/cloudflared/shop/tunnel.env");
    const blogToken = tunnelToken().replace("eyJ", "eyJblog");
    await applyApproved(fake, tunnelled, { secrets: { tunnelToken: blogToken } });
    expect(fake.files.get("/srv/opscrew/cloudflared/blog/tunnel.env")).toBe(
      `TUNNEL_TOKEN=${blogToken}\n`,
    );
    expect(fake.files.get("/srv/opscrew/cloudflared/shop/tunnel.env")).toBe(shopToken);
    expect(fake.files.get("/srv/opscrew/cloudflared/blog/tunnel.id")).toBe(`${other.tunnelId}\n`);
    expect(fake.containers.map((container) => container.project)).toEqual(
      expect.arrayContaining(["shop-tunnel", "blog-tunnel"]),
    );
    const facts = await inspectHost(fake);
    expect(facts.tunnels.map((item) => [item.app, item.tunnelId, item.running])).toEqual([
      ["blog", other.tunnelId, true],
      ["shop", TUNNEL_ID, true],
    ]);
  });

  it("refuses a tunnel connector whose Compose project is another app's name", async () => {
    const fake = new FakeHost();
    const other = { app: "shop-tunnel", projectId: "st-1", hostnames: ["st.example.com"] };
    await provision(fake, tunnelDesired(fake, other), { secrets: { tunnelToken: tunnelToken() } });
    deployApp(fake, "shop-tunnel", "tunnel");
    const plan = await planFor(fake, tunnelDesired(fake));
    expect(codes(plan)).toEqual(["tunnel-project-taken"]);
    expect(plan.findings[0]?.message).toContain('the OpsCrew app "shop-tunnel" on this server');
  });
});

describe("an app without a domain answers every name on port 80", () => {
  it("is refused next to another app, naming it", async () => {
    const fake = await withShop();
    const plan = await planFor(fake, blog(fake, { hostnames: [] }));
    expect(codes(plan)).toEqual(["no-domain-shared"]);
    expect(plan.findings[0]?.message).toBe(
      'This app has no domain, so it would answer every request on port 80 of this server, and the OpsCrew app "shop" is already served here. Only an app with its own domain can share a server.',
    );
    await expect(applyApproved(fake, plan)).rejects.toThrow(/cannot change this server yet/);
    expect(fake.files.has("/etc/opscrew/apps/blog.json")).toBe(false);
  });

  it("keeps a second app off a server whose app has no domain", async () => {
    const fake = new FakeHost();
    await provision(fake, desiredFor(fake, { hostnames: [] }));
    deployApp(fake, "shop");
    const plan = await planFor(fake, blog(fake));
    expect(codes(plan)).toEqual(["no-domain-shared"]);
    expect(plan.findings[0]?.message).toContain(
      'The OpsCrew app "shop" on this server has no domain',
    );
    // Alone on its server, an app without a domain is fine, and so is its own re-run.
    expect(codes(await planFor(fake, desiredFor(fake, { hostnames: [] })))).toEqual([]);
  });
});

describe("access modes: the apps on a server share its firewall", () => {
  const CF = { ipv4: ["173.245.48.0/20", "103.21.244.0/22"] };

  it("records how each app is served", async () => {
    const tunnelled = new FakeHost();
    await provision(tunnelled, tunnelDesired(tunnelled), {
      secrets: { tunnelToken: tunnelToken() },
    });
    expect(appRecord(tunnelled, "shop")?.access).toBe("tunnel");
    const filtered = new FakeHost();
    await provision(filtered, desiredFor(filtered, { webFilter: CF }));
    expect(appRecord(filtered, "shop")?.access).toBe("web-filter");
  });

  it("refuses a direct app next to one behind the web filter, and the other way round", async () => {
    const filtered = new FakeHost();
    await provision(filtered, desiredFor(filtered, { webFilter: CF }));
    const direct = await planFor(filtered, blog(filtered));
    expect(codes(direct)).toEqual(["access-mode-conflict"]);
    expect(direct.findings[0]?.message).toBe(
      `The OpsCrew app "shop" on this server is served behind Cloudflare's proxy, with the web ports open to Cloudflare's addresses only, and this app would be served directly on ports 80 and 443 (DNS only). The apps share the server's firewall: the filter that lets only Cloudflare reach the web ports would cut the direct app off, and without it the other app is open to everyone.`,
    );
    expect(direct.findings[0]?.hint).toMatch(/the same way as "shop"/);
    expect(direct.steps.find((step) => step.id === "app-record")?.state).toBe("blocked");

    const plain = await withShop();
    const behind = await planFor(plain, blog(plain, { webFilter: CF }));
    expect(codes(behind)).toEqual(["access-mode-conflict"]);
    expect(behind.findings[0]?.message).toContain('"shop" on this server is served directly');
  });

  it("refuses a tunnelled app next to a direct one: the open web ports would serve it too", async () => {
    const fake = await withShop();
    const plan = await planFor(fake, blogTunnel(fake));
    expect(codes(plan)).toEqual(["access-mode-conflict"]);
    expect(plan.findings[0]?.message).toContain("past its tunnel");
  });

  it("allows apps served the same way", async () => {
    const filtered = new FakeHost();
    await provision(filtered, desiredFor(filtered, { webFilter: CF }));
    const plan = await planFor(filtered, blog(filtered, { webFilter: CF }));
    expect(codes(plan)).toEqual([]);
    expect(changes(plan)).toEqual(["deploy-key", "app-dirs", "app-record"]);

    // Two tunnelled apps, each with its own connector.
    const tunnelled = new FakeHost();
    await provision(tunnelled, tunnelDesired(tunnelled), {
      secrets: { tunnelToken: tunnelToken() },
    });
    const second = await planFor(
      tunnelled,
      blogTunnel(tunnelled, "0a1b2c3d-2222-4e5f-8a9b-abcdefabcdef"),
    );
    expect(codes(second)).toEqual([]);
    expect(changes(second)).toEqual(["deploy-key", "app-dirs", "app-record", "tunnel-connector"]);
  });

  it("ignores the mode of an app removed with its data kept", async () => {
    const fake = await withShop();
    fake.volumes.set("shop", 1);
    await removeApp(fake, "shop", false);
    const plan = await planFor(fake, blogTunnel(fake));
    expect(codes(plan)).toEqual([]);
  });

  it("checks the mode again at apply time, before the first change", async () => {
    const fake = await withShop();
    const plan = await planFor(fake, blog(fake));
    const news = { ...appRecord(fake, "shop"), app: "news", projectId: "news-1" };
    fake.files.set(
      "/etc/opscrew/apps/news.json",
      JSON.stringify({
        ...news,
        access: "tunnel",
        hostnames: ["news.example.com"],
        composeProject: "news",
      }),
    );
    fake.calls.length = 0;
    const error = await rejection(applyApproved(fake, plan));
    expect(error.message).toContain('The OpsCrew app "news" on this server is served through');
    expect(fake.names()).toEqual(["privilege", "record.read", "apps.read"]);
  });
});

describe("conflicts are refused before any change, naming the other app", () => {
  it("a hostname another app holds", async () => {
    const fake = await withShop();
    const plan = await planFor(
      fake,
      blog(fake, { hostnames: ["blog.example.com", "www.shop.example.com"] }),
    );
    expect(codes(plan)).toEqual(["hostname-taken"]);
    expect(plan.findings[0]?.message).toBe(
      'The OpsCrew app "shop" on this server already serves www.shop.example.com, and a hostname belongs to one app.',
    );
    await expect(applyApproved(fake, plan)).rejects.toThrow(/cannot change this server yet/);
  });

  it("an app name another project uses on the server", async () => {
    const fake = await withShop();
    const plan = await planFor(
      fake,
      desiredFor(fake, { projectId: "shop-other", hostnames: ["shop2.example.com"] }),
    );
    expect(codes(plan)).toEqual(["app-name-taken"]);
    expect(plan.findings[0]?.message).toContain('the OpsCrew app "shop"');
    expect(plan.findings[0]?.message).toContain("shop-0123456789ab");
  });

  it("the reserved name opscrew-edge", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake, desiredFor(fake, { app: "opscrew-edge" }));
    expect(codes(plan)).toEqual(["reserved-app-name"]);
    expect(plan.findings[0]?.message).toContain('"opscrew-edge"');
  });

  it("checks again at apply time, before the first change", async () => {
    const fake = await withShop();
    const plan = await planFor(fake, blog(fake));
    // Meanwhile another run put "news" on the server with blog's hostname.
    const news = { ...appRecord(fake, "shop"), app: "news", projectId: "news-1" };
    fake.files.set(
      "/etc/opscrew/apps/news.json",
      JSON.stringify({ ...news, hostnames: ["blog.example.com"], composeProject: "news" }),
    );
    fake.calls.length = 0;
    const error = await rejection(applyApproved(fake, plan));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain('The OpsCrew app "news" on this server already serves');
    expect(fake.names()).toEqual(["privilege", "record.read", "apps.read"]);
    expect(fake.files.has("/etc/opscrew/apps/blog.json")).toBe(false);
  });

  it("a damaged record of another app (OpsCrew cannot see its hostnames)", async () => {
    const fake = await withShop();
    fake.files.set("/etc/opscrew/apps/news.json", "{");
    expect(codes(await planFor(fake, blog(fake)))).toEqual(["app-record-damaged"]);
  });
});

describe("removing an app", () => {
  it("removes only the first app's own parts while another app remains; the edge stays", async () => {
    const fake = await withTwo();
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(codes(plan)).toEqual([]);
    expect(plan.steps.map((step) => [step.id, step.state, step.scope])).toEqual([
      ["app-dirs", "change", "app"],
      ["deploy-key", "change", "app"],
      ["app-record", "change", "app"],
    ]);
    expect(plan.steps.find((step) => step.id === "deploy-key")?.params).toEqual({
      user: "deploy",
      keys: BLOG_KEY,
    });
    await applyApproved(fake, plan);
    expect(fake.containers.map((container) => container.project).sort()).toEqual([
      "blog",
      "opscrew-edge",
      "opscrew-edge",
    ]);
    expect(fake.dirs.has("/srv/apps/shop")).toBe(false);
    expect(fake.dirs.has("/srv/data/shop")).toBe(false);
    expect(fake.dirs.has("/srv/edge")).toBe(true);
    // Its site and kamal-proxy service leave the edge; the second app's stay.
    expect(fake.files.has("/srv/edge/sites/shop.caddy")).toBe(false);
    expect(fake.files.has("/srv/edge/sites/blog.caddy")).toBe(true);
    expect([...fake.proxyServices]).toEqual(["blog"]);
    expect(fake.files.has("/etc/opscrew/apps/shop.json")).toBe(false);
    expect(hostRecord(fake).apps).toEqual(["blog"]);
    expect(fake.users.get("deploy")?.keys).toEqual([BLOG_KEY]);
    // The second app's plan is still entirely in place.
    expect((await planFor(fake, blog(fake))).steps.every((s) => s.state === "in-place")).toBe(true);
  });

  it("starts a stopped kamal-proxy to remove the app's route; one that cannot start stops the teardown", async () => {
    const fake = await withTwo();
    const proxy = fake.containers.find((container) => container.name.includes("kamal-proxy"));
    if (proxy === undefined) throw new Error("no kamal-proxy");
    proxy.stopped = true;
    fake.edgeUpFails = true;
    const error = await rejection(removeApp(fake, "shop"));
    expect(error.message).toContain("kamal-proxy did not start");
    expect(fake.proxyServices.has("shop")).toBe(true);
    // Run again once the edge can start: the route goes, and kamal-proxy runs for the other app.
    fake.edgeUpFails = false;
    await removeApp(fake, "shop");
    expect([...fake.proxyServices]).toEqual(["blog"]);
    expect(proxy.stopped).toBe(false);
  });

  it("removes a tunnelled app's own connector; the other app's connector keeps running", async () => {
    const fake = new FakeHost();
    await provision(fake, tunnelDesired(fake), { secrets: { tunnelToken: tunnelToken() } });
    deployApp(fake, "shop", "tunnel");
    const blogId = "0a1b2c3d-2222-4e5f-8a9b-abcdefabcdef";
    await provision(fake, blogTunnel(fake, blogId), { secrets: { tunnelToken: tunnelToken() } });
    deployApp(fake, "blog", "tunnel");
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(plan.steps.map((step) => [step.id, step.scope])).toEqual([
      ["app-dirs", "app"],
      ["deploy-key", "app"],
      ["tunnel-connector", "app"],
      ["app-record", "app"],
    ]);
    expect(plan.steps.find((step) => step.id === "tunnel-connector")?.params).toEqual({
      remove: true,
      app: "shop",
    });
    await applyApproved(fake, plan, { command: "opscrew destroy" });
    expect(fake.files.has("/srv/opscrew/cloudflared/shop/tunnel.env")).toBe(false);
    expect(fake.files.has("/srv/opscrew/cloudflared/blog/tunnel.env")).toBe(true);
    expect(fake.containers.some((container) => container.project === "shop-tunnel")).toBe(false);
    expect(fake.containers.some((container) => container.project === "blog-tunnel")).toBe(true);
    const blogPlan = await planFor(fake, blogTunnel(fake, blogId));
    expect(blogPlan.steps.every((step) => step.state === "in-place")).toBe(true);
  });

  it("removes the edge with the last app: its containers, network, volumes and /srv/edge", async () => {
    const fake = await withShop();
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(plan.steps.map((step) => [step.id, step.scope])).toEqual([
      ["app-dirs", "app"],
      ["edge", "shared"],
      ["app-record", "app"],
    ]);
    await applyApproved(fake, plan);
    expect(fake.containers).toEqual([]);
    expect(fake.volumes.has("opscrew-edge")).toBe(false);
    expect(fake.networks.has("opscrew-edge")).toBe(false);
    expect(fake.dirs.has("/srv/edge")).toBe(false);
    expect([...fake.files.keys()].some((path) => path.startsWith("/srv/edge/"))).toBe(false);
    // The hardening stays (it goes only with --undo-host); the data was kept.
    expect(fake.users.get("deploy")?.keys).toEqual([DEPLOY_KEY]);
    expect(fake.ufwActive).toBe(true);
    expect(fake.dirs.get("/srv/data/shop")?.entries).toBe(1);
    expect(hostRecord(fake).apps).toEqual([]);
  });

  it("keeps a record of the kept data, so only the same project can take it again", async () => {
    const fake = await withShop();
    fake.volumes.set("shop", 2);
    await applyApproved(
      fake,
      planTeardown(
        await inspectHost(fake),
        { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
        "opscrew destroy",
      ),
    );
    expect(appRecord(fake, "shop")).toMatchObject({
      state: "data-kept",
      projectId: "shop-0123456789ab",
      hostnames: [],
      services: [],
      memoryMb: 0,
    });
    const again = await planFor(fake);
    expect(codes(again)).toEqual([]);
    expect(again.steps.find((step) => step.id === "app-record")?.params.ownProject).toBe(true);
    const other = await planFor(fake, desiredFor(fake, { projectId: "shop-other" }));
    expect(codes(other)).toEqual(["app-name-taken"]);
    // Its hostnames are free for another app.
    const taker = await planFor(fake, blog(fake, { hostnames: ["shop.example.com"] }));
    expect(codes(taker)).toEqual([]);
  });

  it("undoes the host only once no app is left, naming the apps still there", async () => {
    const fake = await withTwo();
    const plan = planUndo(await inspectHost(fake), "opscrew destroy --undo-host");
    expect(codes(plan)).toEqual(["app-still-deployed"]);
    expect(plan.findings[0]?.message).toContain('"blog" and "shop"');
  });
});

describe("inspection", () => {
  it("reports every OpsCrew app on the server with its record", async () => {
    const fake = await withTwo();
    const facts = await inspectHost(fake);
    expect(
      facts.apps.map((app) => [app.name, app.record?.hostnames, app.record?.memoryMb]),
    ).toEqual([
      ["blog", ["blog.example.com"], 768],
      ["shop", ["shop.example.com", "www.shop.example.com"], 512],
    ]);
    expect(facts.record?.apps).toEqual(["blog", "shop"]);
    expect(new Set(facts.runtimeFiles.map((file) => file.app))).toEqual(new Set(["blog", "shop"]));
    expect(
      facts.runtimeFiles.find((file) => file.app === "blog" && file.name === "compose.yaml"),
    ).toMatchObject({ kind: "file" });
    // Each app's site on the edge, by its checksum.
    expect(
      facts.runtimeFiles.find((file) => file.app === "blog" && file.name === "site"),
    ).toMatchObject({
      kind: "file",
      sha256: sha256Hex(fake.files.get("/srv/edge/sites/blog.caddy") ?? ""),
    });
    expect(facts.dirs.map((dir) => dir.path)).toEqual([
      "/srv/edge",
      "/srv/apps",
      "/srv/data",
      "/srv/apps/blog",
      "/srv/apps/shop",
      "/srv/data/blog",
      "/srv/data/shop",
    ]);
  });

  it("reads whether an x86 CPU has AVX (for MongoDB) and the architecture", async () => {
    const withAvx = new FakeHost();
    expect(await inspectHost(withAvx)).toMatchObject({ arch: "amd64", avx: true });
    const old = new FakeHost();
    old.cpuFlags = "fpu vme de pse tsc msr pae mce cx8 apic sep mtrr sse sse2 ssse3 sse4_1 sse4_2";
    expect((await inspectHost(old)).avx).toBe(false);
    const arm = new FakeHost({ arch: "arm64" });
    expect(await inspectHost(arm)).toMatchObject({ arch: "arm64", machine: "aarch64", avx: false });
  });
});

describe("planHost input", () => {
  it("refuses hostnames that are not lower-case domain names", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    for (const hostnames of [["Shop.Example.com"], ["shop example.com"], ["shop"]]) {
      expect(() => planHost(facts, desiredFor(fake, { hostnames }), "opscrew provision")).toThrow(
        /hostnames/,
      );
    }
  });
});

describe("a plan made for other apps than are on the server now", () => {
  const ROTATED =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIROTATEDROTATEDROTATEDROTATEDROTATEDROTATED opscrew-deploy";

  it("A: a last-app teardown is refused once another app joined, and the edge stays", async () => {
    const fake = await withShop();
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(teardown.otherApps).toEqual([]);
    expect(teardown.steps.some((step) => step.id === "edge")).toBe(true);
    await provision(fake, blog(fake));
    fake.calls.length = 0;
    const error = await rejection(applyApproved(fake, teardown, { command: "opscrew destroy" }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      'The OpsCrew apps on this server changed since this host plan was made (now "blog"), and its shared parts were planned for the apps as they were, so OpsCrew changes nothing.',
    );
    expect(error.hint).toBe(
      "Run opscrew destroy again to make a fresh host plan for the server as it is now, and approve that one.",
    );
    expect(fake.names()).toEqual(["privilege", "record.read", "apps.read"]);
    expect(fake.dirs.has("/srv/edge")).toBe(true);
    expect(fake.containers.some((container) => container.project === "opscrew-edge")).toBe(true);
    expect(appRecord(fake, "shop")?.state).toBe("active");
  });

  it("B: a deploy key rotation is refused once another app joined (its key would be revoked)", async () => {
    const fake = await withShop();
    const rotated = desiredFor(fake, { deploy: { user: "deploy", publicKey: ROTATED } });
    const rotation = await planFor(fake, rotated);
    expect(rotation.steps.find((step) => step.id === "deploy-key")?.params.keys).toBe(ROTATED);
    await provision(fake, blog(fake));
    const error = await rejection(applyApproved(fake, rotation));
    expect(error.message).toContain('changed since this host plan was made (now "blog")');
    expect(fake.users.get("deploy")?.keys.sort()).toEqual([BLOG_KEY, DEPLOY_KEY].sort());
    // Planned again, the rotation keeps blog's key.
    const fresh = await planFor(fake, rotated);
    expect(fresh.otherApps).toEqual([{ app: "blog", deployKey: BLOG_KEY }]);
    await applyApproved(fake, fresh);
    expect(fake.users.get("deploy")?.keys.sort()).toEqual([BLOG_KEY, ROTATED].sort());
  });

  it("an app that left changes the plan too (the shared parts were planned for it)", async () => {
    const fake = await withTwo();
    const plan = await planFor(fake, desiredFor(fake, { memoryMb: 640 }));
    expect(plan.otherApps).toEqual([{ app: "blog", deployKey: BLOG_KEY }]);
    await removeApp(fake, "blog");
    const error = await rejection(applyApproved(fake, plan));
    expect(error.message).toContain("(now none besides this one)");
  });
});

describe("removals leave what is not the app's own", () => {
  it("a /srv/edge of the user's own stays when the last app goes; only the edge's containers go", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake);
    // The user made /srv/edge between the plan and its apply: the record says it was there.
    fake.dirs.set("/srv/edge", { owner: "root", group: "root", mode: "755", entries: 1 });
    await applyApproved(fake, plan);
    const runtime = hostRecord(fake).changes.find((entry) => entry.step === "runtime-dirs");
    expect(runtime?.previous).toMatchObject({ edge: "present" });
    deployApp(fake, "shop");
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    const edge = teardown.steps.find((step) => step.id === "edge");
    expect(edge).toMatchObject({ params: { removeDir: false } });
    expect(edge?.reason).toContain("/srv/edge stays: it was there before OpsCrew.");
    await applyApproved(fake, teardown, { command: "opscrew destroy" });
    expect(fake.dirs.has("/srv/edge")).toBe(true);
    expect(fake.containers.some((container) => container.project === "opscrew-edge")).toBe(false);
    expect(fake.networks.has("opscrew-edge")).toBe(false);
  });

  it("refuses to remove an app whose record belongs to another project, naming it", async () => {
    const fake = await withShop();
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: "shop-other" },
      "opscrew destroy",
    );
    expect(codes(plan)).toEqual(["app-name-taken"]);
    expect(plan.findings[0]?.message).toContain("shop-0123456789ab");
    expect(plan.steps).toEqual([]);
  });

  it("deletes the Compose volumes of an app removed before with its data kept", async () => {
    const fake = await withShop();
    fake.volumes.set("shop", 2);
    await removeApp(fake, "shop", false);
    // Only its volumes are left: no containers, no folder, no data files.
    fake.dirs.delete("/srv/data/shop");
    expect(appRecord(fake, "shop")?.state).toBe("data-kept");
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(plan.steps.find((step) => step.id === "app-dirs")?.state).toBe("change");
    await applyApproved(fake, plan, { command: "opscrew destroy" });
    expect(fake.volumes.has("shop")).toBe(false);
    expect(fake.files.has("/etc/opscrew/apps/shop.json")).toBe(false);
  });

  it("counts an app the host record lists without a record file as damaged: the edge stays", async () => {
    const fake = await withShop();
    const host = hostRecord(fake);
    fake.files.set("/etc/opscrew/host.json", JSON.stringify({ ...host, apps: ["news", "shop"] }));
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(codes(plan)).toEqual(["app-record-damaged"]);
    expect(plan.findings[0]?.message).toContain('"news"');
    // Its own listing without a file is not damage: deleting its record frees the name.
    fake.files.delete("/etc/opscrew/apps/shop.json");
    fake.files.set("/etc/opscrew/host.json", JSON.stringify({ ...host, apps: ["shop"] }));
    const again = planTeardown(
      await inspectHost(fake),
      { deleteData: false, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(codes(again)).toEqual([]);
  });
});
