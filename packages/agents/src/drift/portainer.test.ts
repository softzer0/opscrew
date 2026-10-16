import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { portainerValueKeyFile } from "../provision/portainer";
import { generatedValuesFile } from "../provision/secrets";
import { DATA_ZONE, encryptedState, MANAGED_TUNNEL, plainState, withStateList } from "../testing";
import {
  APP_IMAGE,
  deployImage,
  everythingShown,
  forbiddenIn,
  type PortainerProject,
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
  writeBranch,
} from "./__fixtures__/portainer-project";
import { renderDriftReport } from "./render";
import { runDrift } from "./run";

async function deployed(o: Parameters<typeof portainerProject>[0] = {}) {
  const s = await portainerProject(o);
  await provisionPortainerProject(s);
  await deployImage(s);
  return s;
}

const drift = (s: PortainerProject) => runDrift(s.deps, { services: s.services });
const titles = (report: Awaited<ReturnType<typeof drift>>) =>
  (report.portainer?.differences ?? []).map((item) => item.title);

async function expectNothingLeaked(s: PortainerProject, report: unknown) {
  const text = `${await everythingShown(s)}\n${JSON.stringify(report)}`;
  for (const secret of forbiddenIn(s)) expect(text).not.toContain(secret);
}

describe.skipIf(!findExecutable("git"))("opscrew drift for the user's Portainer", () => {
  it("is clean right after a deploy, changes nothing in Portainer and leaves no plan file", async () => {
    const s = await deployed();
    const mutations = s.fake.mutations().length;
    const generated = generatedValuesFile(s.deps);
    const before = {
      text: await readFile(generated, "utf8"),
      mtime: (await stat(generated)).mtimeMs,
    };
    const refs = await s.git(s.root, "for-each-ref");
    const report = await drift(s);

    // Drift writes nothing: not the generated values, not a ref.
    expect(await readFile(generated, "utf8")).toBe(before.text);
    expect((await stat(generated)).mtimeMs).toBe(before.mtime);
    expect(await s.git(s.root, "for-each-ref")).toBe(refs);
    expect(s.deps.reporter.text()).not.toContain("no production value");
    expect(report.portainer?.differences).toEqual([]);
    expect(report).toMatchObject({ clean: true, provider: "portainer", drift: [], pending: [] });
    expect(report.files).toEqual({ changed: [], created: [] });
    expect(s.fake.mutations()).toHaveLength(mutations);
    // Values were compared by keyed fingerprints (the client got the value key).
    expect(s.clients.at(-1)?.valueKey).toHaveLength(32);
    expect(report.notes ?? []).toEqual([]);
    expect(
      (await readdir(s.deps.paths.files.plansDir)).filter((f) => f.startsWith("drift-")),
    ).toEqual([]);
    expect(renderDriftReport(report)).toContain("OpsCrew's stacks in your Portainer");
    expect(s.deps.audit.entries.map((entry) => entry.action)).toContain(
      "inspect Portainer (read-only)",
    );
    await expectNothingLeaked(s, report);
  });

  it("audits its read-only inspection as drift, never as provision", async () => {
    const s = await deployed();
    const before = s.deps.audit.entries.length;
    await drift(s);
    const entries = s.deps.audit.entries.slice(before);
    expect(entries.map((entry) => entry.action)).toEqual([
      "inspect Portainer (read-only)",
      "drift-check",
    ]);
    expect(entries.map((entry) => entry.phase)).toEqual([undefined, undefined]);
  });

  it("reports changed variables, values, the webhook and polling, by key name only", async () => {
    const s = await deployed();
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    if (app === undefined) throw new Error("no app stack");
    const changed = fakeSecret("stripe-live-key", "changed in Portainer");
    app.Env = [
      ...app.Env.map((pair) =>
        pair.name === "STRIPE_SECRET_KEY" ? { ...pair, value: changed } : pair,
      ),
      { name: "DEBUG", value: "1" },
    ];
    app.AutoUpdate = {
      Webhook: "",
      ForcePullImage: false,
      ForceUpdate: false,
      ...{ Interval: "5m" },
    };
    const updater = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop-updater");
    if (updater === undefined) throw new Error("no updater stack");
    updater.file = `${updater.file}# edited\n`;
    const mutations = s.fake.mutations().length;

    const report = await drift(s);
    expect(report.clean).toBe(false);
    const [appChange, updaterChange] = titles(report);
    expect(appChange).toContain("Update the Git stack opscrew-shop");
    expect(appChange).toContain("the environment variables");
    expect(appChange).toContain("the value of STRIPE_SECRET_KEY");
    expect(appChange).toContain("the webhook");
    expect(appChange).toContain("scheduled Git polling");
    expect(updaterChange).toContain("Update the updater stack opscrew-shop-updater");
    expect(updaterChange).toContain("its stack file");
    expect(s.fake.mutations()).toHaveLength(mutations);

    const text = renderDriftReport(report);
    expect(text).toContain('Your Portainer (environment "local") or the deploy branch differs');
    expect(text).not.toContain(changed);
    expect(JSON.stringify(report)).not.toContain(changed);
    await expectNothingLeaked(s, report);
  });

  it("reports a registry entry no longer granted on the environment", async () => {
    const s = await deployed();
    const entry = s.fake.registries[0];
    if (entry === undefined) throw new Error("no registry entry");
    entry.RegistryAccesses = {};
    const report = await drift(s);
    expect(report.portainer?.differences).toEqual([
      expect.objectContaining({
        area: "registry",
        title: expect.stringContaining("use the registry entry opscrew-shop on environment local"),
      }),
    ]);
  });

  it("reports the deploy branch: deleted while the app's stack exists, edited by hand, the placeholder", async () => {
    const s = await deployed();
    await s.git(s.bare, "update-ref", "-d", "refs/heads/opscrew-deploy");
    let report = await drift(s);
    expect(report.portainer?.differences).toEqual([
      expect.objectContaining({
        area: "deploy-branch",
        title:
          "The opscrew-deploy branch of acme/shop is missing, but the app's stack in Portainer deploys from it",
      }),
    ]);

    const content = await deployImage(s);
    await writeBranch(
      s.bare,
      "opscrew-deploy",
      content.replace("restart:", "# hand edit\n    restart:"),
    );
    report = await drift(s);
    expect(titles(report)).toEqual([
      `compose.yaml on the opscrew-deploy branch of acme/shop differs from OpsCrew's template with the image ${APP_IMAGE}`,
    ]);

    await writeBranch(
      s.bare,
      "opscrew-deploy",
      content.replaceAll(APP_IMAGE, `ghcr.io/someone/else@sha256:${"cd".repeat(32)}`),
    );
    report = await drift(s);
    expect(titles(report)[0]).toContain("which is not the app's image");

    const placeholder = s.github.branches[0]?.content as string;
    await writeBranch(s.bare, "opscrew-deploy", placeholder);
    report = await drift(s);
    expect(titles(report)).toEqual([
      "The opscrew-deploy branch of acme/shop still holds the placeholder OpsCrew created",
    ]);
  });

  it("without the value key compares names only, says so, and creates no key", async () => {
    const s = await deployed();
    await rm(portainerValueKeyFile(s.deps.paths));
    const report = await drift(s);
    expect(report.clean).toBe(true);
    expect(report.notes?.join("\n")).toContain("not their values");
    expect(s.clients.at(-1)?.valueKey).toBeUndefined();
    await expect(readdir(s.deps.paths.projectHomeDir)).resolves.not.toContain("portainer-env.key");
  });

  it("compares generated values from provision's record; one missing from it compares as Portainer has it", async () => {
    const s = await deployed();
    const generated = generatedValuesFile(s.deps);
    const record = JSON.parse(await readFile(generated, "utf8")) as {
      dbPassword?: string;
      env?: Record<string, string>;
    };
    expect(record.env?.SESSION_SECRET).toBeDefined();

    // A different generated value is drift, named by its key only.
    const changed = fakeSecret("generic-password", "another session secret");
    await writeFile(generated, JSON.stringify({ ...record, env: { SESSION_SECRET: changed } }));
    let report = await drift(s);
    expect(titles(report)[0]).toContain("the value of SESSION_SECRET");
    expect(JSON.stringify(report)).not.toContain(changed);

    // Missing from the record (or no record at all): unknown here, never invented, never written.
    await writeFile(generated, JSON.stringify({ dbPassword: record.dbPassword }));
    report = await drift(s);
    expect(report.clean).toBe(true);
    await rm(generated);
    report = await drift(s);
    expect(report.clean).toBe(true);
    await expect(stat(generated)).rejects.toThrow();
  });

  it("without the production values file compares the app's values as Portainer has them, and says so", async () => {
    const s = await deployed();
    delete s.deps.env.OPSCREW_APP_ENV_FILE;
    const report = await drift(s);
    expect(report.clean).toBe(true);
    expect(report.notes?.join("\n")).toContain("OPSCREW_APP_ENV_FILE");
  });

  it("a proxy setup without Cloudflare needs no state, and an earlier setup's Cloudflare state shows", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    let report = await drift(s);
    expect(report.clean).toBe(true);
    expect(report.notes?.join("\n")).toContain("OpsCrew manages no Cloudflare resources");
    expect(s.engine.calls).not.toContain("plan");

    const { writeFakeState } = await import("../testing");
    await writeFakeState(s.deps.paths);
    report = await drift(s);
    expect(report.portainer?.differences).toEqual([
      expect.objectContaining({ area: "cloudflare" }),
    ]);
  });

  it("an earlier setup's state counts only while the engine lists managed resources, encrypted or not", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    const statePath = join(s.deps.paths.files.tfstateDir, "prod.tfstate");
    await mkdir(s.deps.paths.files.tfstateDir, { recursive: true });
    const passphrase = randomBytes(24).toString("base64url");
    await mkdir(dirname(s.deps.paths.files.statePassphrase), { recursive: true });
    await writeFile(
      s.deps.paths.files.statePassphrase,
      `${passphrase}
`,
    );
    let inside: string[] = [];
    const engine = withStateList(s.engine, () => inside);
    const tunnel = "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this";
    const cases: [string, string, string[], boolean][] = [
      ["removed (outputs only)", plainState([]), [], false],
      ["only a data source", plainState([DATA_ZONE]), [], false],
      ["removed, encrypted", encryptedState(), [], false],
      ["a tunnel", plainState([MANAGED_TUNNEL]), [], true],
      ["a tunnel, encrypted", encryptedState(), [tunnel], true],
    ];
    for (const [what, content, listed, leftover] of cases) {
      await writeFile(statePath, content);
      inside = listed;
      const report = await drift(s);
      expect(
        report.portainer?.differences.map((d) => d.area),
        what,
      ).toEqual(leftover ? ["cloudflare"] : []);
      expect(report.clean, what).toBe(!leftover);
      expect(`${JSON.stringify(report)}${await everythingShown(s)}`, what).not.toContain(
        passphrase,
      );
    }
    expect(engine.stateCalls.map((call) => call.encryption !== undefined)).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it("stops plainly when Portainer rejects the token, with nothing compared", async () => {
    const s = await deployed();
    s.deps.env.PORTAINER_API_KEY = fakeSecret("generic-password", "wrong token");
    await expect(drift(s)).rejects.toThrow(/OpsCrew cannot check your Portainer/);
  });
});
