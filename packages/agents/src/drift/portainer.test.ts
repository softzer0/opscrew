import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type SelfHostedServiceKind,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  bucketChanges,
  bucketEngine,
  RootEngine,
  withBucket,
} from "../provision/__fixtures__/storage";
import { portainerValueKeyFile } from "../provision/portainer";
import { STORAGE_KEY_VARS, storageStateFile } from "../provision/storage";
import { generatedValuesFile } from "../shared/app-secrets";
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

/** `plan` with a service of `kind` at the catalog's defaults besides its own. */
function withService(plan: DeployPlan, kind: SelfHostedServiceKind): DeployPlan {
  const spec = serviceSpec(kind);
  return DeployPlanSchema.parse({
    ...plan,
    services: [
      ...plan.services,
      {
        kind,
        version: spec.defaultVersion,
        memoryMb: spec.memory.defaultMb,
        options: {},
        reason: "The app uses it.",
        licence: spec.licence.id,
      },
    ],
  });
}
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

  it("follows a staging environment's own deploy branch, opscrew-deploy-staging", async () => {
    const base = portainerPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, name: `${base.app.name}-staging` },
      environment: { name: "staging" },
    });
    const s = await deployed({ plan });
    // Provision started the environment's own branch, and its stack follows it.
    expect(s.github.branches.map((item) => item.branch)).toEqual(["opscrew-deploy-staging"]);
    const app = s.fake.stacks.find((stack) => stack.Name === `opscrew-${plan.app.name}`);
    expect(app?.GitConfig?.ReferenceName).toBe("refs/heads/opscrew-deploy-staging");
    let report = await drift(s);
    expect(report.portainer?.differences).toEqual([]);
    expect(report.clean).toBe(true);

    await s.git(s.bare, "update-ref", "-d", "refs/heads/opscrew-deploy-staging");
    report = await drift(s);
    expect(titles(report)).toEqual([
      "The opscrew-deploy-staging branch of acme/shop is missing, but the app's stack in Portainer deploys from it",
    ]);
  });

  it("checks a further app's deploy branch against its own image, ghcr.io/<owner>/<repo>/<key>", async () => {
    const base = portainerPlan();
    const { dir: _dir, ...infra } = base.infra;
    const { workflowPath: _workflowPath, ...cicd } = base.cicd;
    const plan = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, key: "docs", name: "docs" },
      dns: { ...base.dns, domain: "docs.example.com" },
      infra,
      cicd,
    });
    const s = await deployed({ plan });
    await deployImage(s, `ghcr.io/acme/shop/docs@sha256:${"ab".repeat(32)}`);
    let report = await drift(s);
    expect(report.portainer?.differences).toEqual([]);

    // The first app's image is not this app's.
    await deployImage(s, APP_IMAGE);
    report = await drift(s);
    expect(titles(report)[0]).toContain(`runs ${APP_IMAGE}, which is not the app's image`);
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
    expect(report.notes?.join("\n") ?? "").not.toContain("generated_values.json");
    await expect(stat(generated)).rejects.toThrow();
  });

  it("compares each service's secrets from provision's record, by name only", async () => {
    const s = await deployed({ plan: withService(portainerPlan(), "mysql") });
    expect((await drift(s)).clean).toBe(true);
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    if (app === undefined) throw new Error("no app stack");
    const changed = fakeSecret("generic-password", "mysql password changed in Portainer");
    app.Env = app.Env.map((pair) =>
      pair.name === "OPSCREW_SVC_MYSQL_PASSWORD" ? { ...pair, value: changed } : pair,
    );
    const report = await drift(s);
    expect(titles(report)[0]).toContain("the value of OPSCREW_SVC_MYSQL_PASSWORD");
    expect(JSON.stringify(report)).not.toContain(changed);
    await expectNothingLeaked(s, report);
  });

  it("checks the app's R2 bucket in its own root and state, and the key the app's stack holds", async () => {
    const key = {
      [STORAGE_KEY_VARS.accessKeyId]: fakeSecret("aws-access-key-id", "drift"),
      [STORAGE_KEY_VARS.secretAccessKey]: fakeSecret("aws-secret-access-key", "drift"),
    };
    const s = await portainerProject({
      plan: withBucket(portainerPlan({ web: { mode: "proxy", port: 8080 } }), "r2"),
      env: key,
    });
    const storage = bucketEngine("r2");
    const engine = s.engine;
    s.services.engine = async () => new RootEngine(engine, storage);
    await provisionPortainerProject(s);
    await deployImage(s);
    await writeFile(storageStateFile(s.deps.paths), plainState([]));
    storage.scenario.changes = [];
    const clean = await drift(s);
    expect(clean.clean).toBe(true);
    expect(clean.notes ?? []).toEqual([expect.stringContaining("manages no Cloudflare resources")]);
    expect(storage.initOptions?.backendConfig?.path).toBe(storageStateFile(s.deps.paths));

    // The bucket deleted in the dashboard: its root plans it again.
    storage.scenario.changes = bucketChanges("r2");
    const report = await drift(s);
    expect(report.clean).toBe(false);
    expect(report.pending.map((change) => change.address)).toContain("cloudflare_r2_bucket.this");
    // The key in the app's stack, changed in Portainer, by name only.
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    if (app === undefined) throw new Error("no app stack");
    const other = fakeSecret("aws-secret-access-key", "another");
    app.Env = app.Env.map((pair) =>
      pair.name === "AWS_SECRET_ACCESS_KEY" ? { ...pair, value: other } : pair,
    );
    storage.scenario.changes = [];
    const changed = await drift(s);
    expect(titles(changed)[0]).toContain("the value of AWS_SECRET_ACCESS_KEY");
    const text = JSON.stringify(changed);
    expect(text).not.toContain(other);
    expect(text).not.toContain(key[STORAGE_KEY_VARS.secretAccessKey]);
  });

  it("compares Laravel's APP_KEY as Portainer has it when provision's record is missing", async () => {
    const base = portainerPlan();
    const plan = {
      ...base,
      app: {
        ...base.app,
        env: [
          ...base.app.env,
          { name: "APP_ENV", secret: false, source: "derived" as const },
          { name: "APP_KEY", secret: true, source: "generated" as const },
        ],
      },
    };
    const s = await deployed({ plan });
    expect((await drift(s)).clean).toBe(true);
    // Another computer, or the record lost: a key provision would generate now is unknown here.
    await rm(generatedValuesFile(s.deps));
    const report = await drift(s);
    expect(titles(report)).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("says when provision's record of the generated values is damaged, and compares them as Portainer has them", async () => {
    const s = await deployed();
    const generated = generatedValuesFile(s.deps);
    const note =
      "OpsCrew did not compare the values it generated for the app's stack (such as the database password): its record of them, generated_values.json in OpsCrew's folder for this project, is damaged, so they compare as Portainer has them.";
    // Not JSON, and JSON that is not a record of generated values.
    for (const damaged of ["{ not json", JSON.stringify({ dbPassword: "" })]) {
      await writeFile(generated, damaged);
      const report = await drift(s);
      expect(report.clean).toBe(true);
      expect(report.notes).toContain(note);
      expect(await readFile(generated, "utf8")).toBe(damaged);
    }
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
    const error = await drift(s).then(
      () => undefined,
      (e: unknown) => e as { code: string; message: string; hint: string },
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "OpsCrew cannot check your Portainer, so it compared nothing there:\n  - Portainer rejected the access token (HTTP 401).",
    });
    expect(error?.hint).toContain("set PORTAINER_API_KEY to it");
    expect(error?.hint).toMatch(/ Then run `opscrew drift` again\.$/);
  });
});
