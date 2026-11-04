// Feature 020: the monitoring step and Alloy on any server (T2008); the monitoring login's step
// is in grant.test.ts.
import { spawnSync } from "node:child_process";
import { sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import type { FakeHost } from "./__fixtures__/fake-host";
import {
  ALLOY_FILES,
  addBlog,
  addonSecrets,
  applyApproved,
  BESZEL_AGENT_FILES,
  cloudServer,
  everythingButStdin,
  hostRecord,
  MONITOR_GRANT,
  MONITORING_FILES,
  monitoringSecrets,
  onlyStep,
  ownServer,
  rejection,
  SH_AVAILABLE,
  SHOP_PROJECT,
  SHOP_REPOSITORY,
  scriptsFor,
  shSyntax,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { HostApplyError } from "./apply";
import { MAX_SCRIPT_BYTES } from "./constants";
import { inspectHost, MONITORING_SNIPPET, readGrant } from "./inspect";
import { parseMonitoring } from "./parse";
import { planAddon, planGrant, planTeardown } from "./plan";
import { dockerRootCommand } from "./privilege";
import { stepScripts } from "./steps";
import type { HostPlan } from "./types";

const IMAGE = `caddy:2.11.7-alpine@sha256:${"0".repeat(63)}1`;
const STACK_DIR = "/srv/opscrew/addons/monitoring";
const CLOUD_STACK_DIR = "/home/deploy/opscrew/addons/monitoring";
const CREDENTIAL = `${STACK_DIR}/grafana_admin_credential`;

/** The monitoring stack turned on for `app` on a server the user owns. */
async function stackPlan(
  fake: FakeHost,
  files: Record<string, string> = MONITORING_FILES,
  app = "shop",
) {
  return planAddon("monitoring", {
    app,
    runAs: "root",
    facts: await inspectHost(fake),
    enable: { files },
  });
}

describe("Grafana Cloud's Alloy without monitoring", () => {
  it("keeps today's plan text, on a server the user owns and on one OpsCrew created", async () => {
    const fake = await ownServer();
    const own = planAddon("alloy", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: { files: ALLOY_FILES },
    });
    const created = planAddon("alloy", {
      app: "shop",
      runAs: "login",
      enable: { files: ALLOY_FILES },
    });
    const off = planAddon("alloy", { app: "shop", runAs: "login", disable: {} });
    expect({ own, created, off }).toMatchSnapshot();
  });
});

describe("the monitoring step on a server the user owns", () => {
  it("writes the files and Grafana's root-only password, starts the stack, records its owner, and re-applies as a no-op", async () => {
    const fake = await ownServer();
    const secrets = monitoringSecrets();
    const plan = await stackPlan(fake);
    const step = onlyStep(plan);
    expect(step).toMatchObject({ id: "monitoring", state: "change", scope: "shared" });
    expect(step.title).toBe(
      "Run the monitoring stack: Prometheus, Loki and Grafana, behind a front that takes only the servers' pushes",
    );
    expect(step.reason).toContain(`Compose project opscrew-monitoring in ${STACK_DIR}`);
    expect(step.params).toMatchObject({
      runAs: "root",
      "file:grafana/dashboards/servers.json": MONITORING_FILES["grafana/dashboards/servers.json"],
    });
    expect(plan.deleteData).toBeUndefined();

    const result = await applyApproved(fake, plan, {
      secrets: { grafanaAdminPassword: secrets.grafanaAdminPassword },
    });
    expect(result.applied).toEqual(["monitoring"]);
    for (const [path, content] of Object.entries(MONITORING_FILES)) {
      expect(fake.files.get(`${STACK_DIR}/${path}`)).toBe(content);
    }
    expect(fake.files.get(CREDENTIAL)).toBe(secrets.grafanaAdminPassword);
    expect(fake.fileModes.get(CREDENTIAL)).toBe("0:0:640");
    for (const dir of ["grafana", "grafana/dashboards", "grafana/provisioning/datasources"]) {
      expect(fake.madeDirs.has(`${STACK_DIR}/${dir}`)).toBe(true);
    }
    expect(fake.addonUps.get("opscrew-monitoring")).toBe(1);
    expect(hostRecord(fake).addons).toEqual({ monitoring: "shop" });
    const calls = fake.calls.filter((call) => call.name.startsWith("monitoring"));
    expect(calls.map((call) => call.name)).toEqual([
      "monitoring.check",
      "monitoring.apply",
      "monitoring.verify",
    ]);
    // As root: the password file is root's.
    expect(calls.every((call) => call.asUser === undefined)).toBe(true);
    // The password, then each file's base64 in the order of the paths, on stdin only.
    const paths = Object.keys(MONITORING_FILES).sort((a, b) => a.localeCompare(b));
    expect(calls[1]?.input).toBe(
      [
        secrets.grafanaAdminPassword,
        ...paths.map((path) =>
          Buffer.from(MONITORING_FILES[path as keyof typeof MONITORING_FILES]).toString("base64"),
        ),
        "",
      ].join("\n"),
    );
    expect(everythingButStdin(fake, plan)).not.toContain(secrets.grafanaAdminPassword);

    const again = await applyApproved(fake, plan, {
      secrets: { grafanaAdminPassword: secrets.grafanaAdminPassword },
    });
    expect(again).toEqual({ applied: [], skipped: ["monitoring"] });
    expect(fake.addonUps.get("opscrew-monitoring")).toBe(1);
  });

  it("runs as root through Docker on a server OpsCrew created, in the deploy user's folder, and records its owner there", async () => {
    const fake = cloudServer();
    fake.dockerAccess = true;
    const secrets = { grafanaAdminPassword: monitoringSecrets().grafanaAdminPassword };
    const plan = planAddon("monitoring", {
      app: "shop-staging",
      runAs: "login",
      facts: await inspectHost(fake, { rootImage: IMAGE }),
      enable: { files: MONITORING_FILES },
    });
    expect(onlyStep(plan).reason).toContain(CLOUD_STACK_DIR);
    const result = await applyApproved(fake, plan, { secrets, rootImage: IMAGE });
    expect(result.applied).toEqual(["monitoring"]);
    const apply = fake.calls.find((call) => call.name === "monitoring.apply");
    expect(apply?.command).toBe(dockerRootCommand(IMAGE));
    expect(apply?.docker?.stdin).toContain(secrets.grafanaAdminPassword);
    expect(fake.files.get(`${CLOUD_STACK_DIR}/compose.yaml`)).toBe(
      MONITORING_FILES["compose.yaml"],
    );
    expect(fake.fileModes.get(`${CLOUD_STACK_DIR}/grafana_admin_credential`)).toBe("0:0:640");
    // The host plan's app names the environment, so the record says whose stack it is.
    expect(hostRecord(fake).addons).toEqual({ monitoring: "shop-staging" });
    // Without the image, root through Docker is refused before anything changes.
    const refused = await rejection(applyApproved(fake, plan, { secrets }));
    expect(refused.message).toContain("only through Docker");
  });

  it("stays its owner's on a monitoring server, where no app is set up: another plan may not even turn it off", async () => {
    const fake = cloudServer();
    fake.dockerAccess = true;
    const secrets = { grafanaAdminPassword: monitoringSecrets().grafanaAdminPassword };
    const before = await inspectHost(fake, { rootImage: IMAGE });
    const late = planAddon("monitoring", {
      app: "blog",
      runAs: "login",
      facts: before,
      disable: { removeData: true },
    });
    await applyApproved(
      fake,
      planAddon("monitoring", {
        app: "shop",
        runAs: "login",
        facts: before,
        enable: { files: MONITORING_FILES },
      }),
      { secrets, rootImage: IMAGE },
    );
    expect(hostRecord(fake)).toMatchObject({ apps: [], addons: { monitoring: "shop" } });
    const facts = await inspectHost(fake, { rootImage: IMAGE });
    let error: (Error & { hint?: string }) | undefined;
    try {
      planAddon("monitoring", { app: "blog", runAs: "login", facts, disable: {} });
    } catch (caught) {
      error = caught as Error & { hint?: string };
    }
    expect(error?.message).toContain('for the app "shop"');
    expect(error?.hint).toContain('in the project of "shop" first');
    const refused = await rejection(applyApproved(fake, late, { rootImage: IMAGE }));
    expect(refused.message).toContain('for the app "shop"');
    expect(fake.volumes.has("opscrew-monitoring")).toBe(true);
    expect(fake.files.has(`${CLOUD_STACK_DIR}/compose.yaml`)).toBe(true);
  });

  it("is refused for another app on the server, naming the app that has it, at plan and at apply time", async () => {
    const fake = await ownServer();
    await addBlog(fake);
    const secrets = { grafanaAdminPassword: monitoringSecrets().grafanaAdminPassword };
    const late = await stackPlan(fake, MONITORING_FILES, "blog");
    await applyApproved(fake, await stackPlan(fake), { secrets });
    const facts = await inspectHost(fake);
    for (const change of [{ enable: { files: MONITORING_FILES } }, { disable: {} }]) {
      let error: (Error & { code?: string; hint?: string }) | undefined;
      try {
        planAddon("monitoring", { app: "blog", runAs: "root", facts, ...change });
      } catch (caught) {
        error = caught as Error & { code?: string; hint?: string };
      }
      expect(error?.code).toBe("PHASE_PRECONDITION");
      expect(error?.message).toBe(
        `OpsCrew's monitoring is already on this server for the app "shop", and a server has only one, so OpsCrew changes nothing.`,
      );
      expect(error?.hint).toContain(
        'run `opscrew addon disable monitoring` in the project of "shop" first',
      );
    }
    fake.calls.length = 0;
    const refused = await rejection(applyApproved(fake, late, { secrets }));
    expect(refused.message).toContain('for the app "shop"');
    expect(fake.names().some((name) => name.startsWith("monitoring"))).toBe(false);
  });

  it("needs the server's facts and Grafana's password, and refuses odd files and options", async () => {
    const fake = await ownServer();
    expect(() =>
      planAddon("monitoring", { app: "shop", runAs: "login", enable: { files: MONITORING_FILES } }),
    ).toThrow(/inspected facts/);
    const plan = await stackPlan(fake);
    fake.calls.length = 0;
    expect((await rejection(applyApproved(fake, plan))).message).toBe(
      "Applying this plan needs Grafana's admin password, and none was supplied.",
    );
    const bad = await rejection(
      applyApproved(fake, plan, { secrets: { grafanaAdminPassword: "short pass'word" } }),
    );
    expect(bad.code).toBe("INVALID_INPUT");
    expect(bad.message).toContain("Grafana's admin password must be 16 to 128");
    expect(fake.calls).toEqual([]);

    const facts = await inspectHost(fake);
    const { "compose.yaml": _, ...noCompose } = MONITORING_FILES;
    for (const files of <Record<string, string>[]>[
      { ...MONITORING_FILES, "../escape": "x" },
      { ...MONITORING_FILES, "grafana/../x": "x" },
      { ...MONITORING_FILES, ".hidden": "x" },
      { ...MONITORING_FILES, grafana_admin_credential: "x" },
      { ...MONITORING_FILES, "grafana/dashboards/big.json": "x".repeat(256 * 1024 + 1) },
      { ...MONITORING_FILES, "loki.yaml": "a\0b" },
      noCompose,
    ]) {
      expect(() =>
        planAddon("monitoring", { app: "shop", runAs: "root", facts, enable: { files } }),
      ).toThrow(/invalid parameters/);
    }
    expect(() =>
      planAddon("monitoring", { app: "shop", runAs: "root", facts, disable: { keepData: true } }),
    ).toThrow(/Only Beszel keeps data/);
    expect(() =>
      planAddon("alloy", { app: "shop", runAs: "login", disable: { removeData: true } }),
    ).toThrow(/Only the monitoring stack's data/);
  });
});

describe("turning the monitoring stack off", () => {
  it("keeps its volumes without removeData, still its owner's, and removes them only in a plan that deletes data", async () => {
    const fake = await ownServer();
    const secrets = { grafanaAdminPassword: monitoringSecrets().grafanaAdminPassword };
    await applyApproved(fake, await stackPlan(fake), { secrets });
    const off = planAddon("monitoring", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      disable: {},
    });
    expect(off.deleteData).toBeUndefined();
    expect(onlyStep(off)).toMatchObject({
      title: "Remove the monitoring stack (its data stays in its Docker volumes)",
      params: { remove: true, runAs: "root", removeData: false },
    });
    expect((await applyApproved(fake, off)).applied).toEqual(["monitoring"]);
    expect([...fake.files.keys()].some((path) => path.startsWith(`${STACK_DIR}/`))).toBe(false);
    expect(fake.containers.some((c) => c.project === "opscrew-monitoring")).toBe(false);
    expect(fake.volumes.has("opscrew-monitoring")).toBe(true);
    // The figures, the logs and Grafana's admin stay the owner's (the record keeps it), so no
    // other app takes them over or deletes them.
    expect(hostRecord(fake).addons).toEqual({ monitoring: "shop" });

    await applyApproved(fake, await stackPlan(fake), { secrets });
    const gone = planAddon("monitoring", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      disable: { removeData: true },
    });
    // Deleting the figures and logs is a destroying plan: allowDestroy and the typed name.
    expect(gone.deleteData).toBe(true);
    expect(onlyStep(gone).title).toBe(
      "Remove the monitoring stack and its data: the figures, the logs and Grafana's own",
    );
    await applyApproved(fake, gone);
    expect(fake.volumes.has("opscrew-monitoring")).toBe(false);
    expect(hostRecord(fake).addons).toEqual({});

    // removeData in a plan that does not delete data is refused before anything changes.
    const { deleteData: _, ...sneaky } = gone;
    fake.calls.length = 0;
    const refused = await rejection(applyApproved(fake, sneaky));
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.message).toContain("removeData");
    expect(fake.calls).toEqual([]);
  });

  it("goes with the app that owns it in a teardown, its data only with the app's", async () => {
    const teardown = async (fake: FakeHost, deleteData: boolean) =>
      planTeardown(
        await inspectHost(fake),
        { deleteData, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
        "opscrew destroy",
      );
    const secrets = { grafanaAdminPassword: monitoringSecrets().grafanaAdminPassword };
    for (const deleteData of [false, true]) {
      const fake = await ownServer();
      await applyApproved(fake, await stackPlan(fake), { secrets });
      const plan = await teardown(fake, deleteData);
      expect(plan.steps.find((step) => step.id === "monitoring")?.params).toEqual({
        remove: true,
        runAs: "root",
        removeData: deleteData,
      });
      await applyApproved(fake, plan, { command: "opscrew destroy" });
      expect(fake.containers.some((c) => c.project === "opscrew-monitoring")).toBe(false);
      expect(fake.volumes.has("opscrew-monitoring")).toBe(!deleteData);
      // Kept data stays the owner's until its project removes it with the data.
      expect(hostRecord(fake).addons).toEqual(deleteData ? {} : { monitoring: "shop" });
      if (!deleteData) {
        await applyApproved(fake, await teardown(fake, true), { command: "opscrew destroy" });
        expect(fake.volumes.has("opscrew-monitoring")).toBe(false);
        expect(hostRecord(fake).addons).toEqual({});
      }
    }
  });
});

describe("the monitoring stack's inspection facts", () => {
  it("are its containers and its files' hashes, never its password file; and Alloy's destinations", async () => {
    const fake = await ownServer();
    expect((await inspectHost(fake)).monitoring).toBeUndefined();
    const secrets = { grafanaAdminPassword: monitoringSecrets().grafanaAdminPassword };
    await applyApproved(fake, await stackPlan(fake), { secrets });
    const facts = await inspectHost(fake);
    expect(facts.monitoring).toEqual({
      containers: ["front", "grafana", "loki", "prometheus"].map((service) => ({
        name: `opscrew-monitoring-${service}-1`,
        running: true,
      })),
      files: Object.fromEntries(
        Object.entries(MONITORING_FILES).map(([path, content]) => [path, sha256Hex(content)]),
      ),
      credential: true,
    });
    expect(facts.addons.monitoring).toMatchObject({ installed: true, running: true });
    expect(facts.alloy).toBeUndefined();
    await applyApproved(
      fake,
      planAddon("alloy", { app: "shop", runAs: "root", facts, enable: { files: ALLOY_FILES } }),
      { secrets: { grafanaCloudToken: addonSecrets().secrets.grafanaCloudToken } },
    );
    // Feature 017's Alloy names no destinations: it sends to Grafana Cloud only.
    expect((await inspectHost(fake)).alloy).toEqual({
      destinations: ["grafanaCloud"],
      files: Object.fromEntries(
        Object.entries(ALLOY_FILES).map(([name, content]) => [name, sha256Hex(content)]),
      ),
    });
  });

  it("parse only the lines they expect", () => {
    const sum = sha256Hex("x");
    expect(
      parseMonitoring(
        [
          "stack",
          `file compose.yaml ${sum}`,
          `file grafana/dashboards/servers.json ${sum}`,
          `file ../etc/shadow ${sum}`,
          "file loki.yaml not-a-hash",
          "credential",
          "alloy monitoring nonsense grafanaCloud",
          `alloyfile config.alloy ${sum}`,
          `alloyfile ../config.alloy ${sum}`,
          "alloyfile compose.yaml not-a-hash",
          "alloypg db",
          "alloypg Not/A/Host",
          "odd line",
        ].join("\n"),
      ),
    ).toEqual({
      stack: true,
      files: { "compose.yaml": sum, "grafana/dashboards/servers.json": sum },
      credential: true,
      alloy: {
        destinations: ["grafanaCloud", "monitoring"],
        files: { "config.alloy": sum },
        postgresHost: "db",
      },
    });
    expect(parseMonitoring("")).toEqual({ stack: false, files: {}, credential: false });
  });

  it.skipIf(!SH_AVAILABLE)(
    "are read in a real shell from the folder of either kind of server",
    () => {
      const h = new ShellHarness();
      try {
        h.write(`${CLOUD_STACK_DIR}/compose.yaml`, "services: {}\n");
        h.write(`${CLOUD_STACK_DIR}/grafana/dashboards/servers.json`, "{}\n");
        h.write(`${CLOUD_STACK_DIR}/grafana_admin_credential`, "not to be read");
        h.write(`${CLOUD_STACK_DIR}/.opscrew-files`, "compose.yaml:x\n");
        h.write("/srv/opscrew/addons/alloy/compose.yaml", "services: {}\n");
        h.write("/srv/opscrew/addons/alloy/.opscrew-destinations", "grafanaCloud monitoring\n");
        const token = addonSecrets().secrets.grafanaCloudToken as string;
        const password = monitoringSecrets().monitoringPostgresPassword;
        h.write("/srv/opscrew/addons/alloy/grafana_cloud_credential", token);
        h.write(
          "/srv/opscrew/addons/alloy/postgres_monitor_credential",
          `postgresql://opscrew_monitor:${password}@other:5432/postgres?sslmode=disable`,
        );
        h.write("/srv/opscrew/addons/alloy/.opscrew-postgres-host", "db\n");
        const path = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        const out = h.run(`${path}\n${MONITORING_SNIPPET}`);
        expect(out.stderr).toBe("");
        // The secret files are never read: the host comes from the step's own file.
        expect(out.stdout).not.toContain(password);
        expect(out.stdout).not.toContain(sha256Hex(token));
        expect(parseMonitoring(out.stdout)).toEqual({
          stack: true,
          files: {
            "compose.yaml": sha256Hex("services: {}\n"),
            "grafana/dashboards/servers.json": sha256Hex("{}\n"),
          },
          credential: true,
          alloy: {
            destinations: ["grafanaCloud", "monitoring"],
            files: { "compose.yaml": sha256Hex("services: {}\n") },
            postgresHost: "db",
          },
        });
      } finally {
        h.dispose();
      }
    },
  );
});

describe.skipIf(!SH_AVAILABLE)(
  "the monitoring stack's scripts in a real shell (docker stubbed)",
  () => {
    /** docker: logged by the harness; `up` starts the four services, `down` stops them. */
    const DOCKER = `case "$*" in
  "volume ls "*) if [ -e "$S/volumes" ]; then echo opscrew-monitoring_prometheus; fi ;;
  "volume rm "*) rm -f "$S/volumes" ;;
  *" config --services"*) printf '%s\\n' front grafana loki prometheus ;;
  *" ps --services --status running"*) if [ -e "$S/up" ]; then printf '%s\\n' front grafana loki prometheus; fi ;;
  *" up "*) touch "$S/up" ;;
  *" down"*) rm -f "$S/up" ;;
esac
exit 0`;

    function harness(): ShellHarness {
      const h = new ShellHarness();
      h.stub("docker", DOCKER);
      h.stub("getent", "exit 0", { log: false });
      h.stub("id", "echo 1000", { log: false });
      h.stub("systemctl", "exit 0", { log: false });
      // The harness cannot give a file to root: stat answers what chown and chmod would have made.
      h.stub("stat", "echo 0:0:640", { log: false });
      const chmod = spawnSync("bash", ["-c", "command -v chmod"], {
        encoding: "utf8",
      }).stdout.trim();
      h.stub("chmod", `exec '${chmod}' "$@"`);
      return h;
    }

    function stack(files: Record<string, string>) {
      const params = Object.entries(files).map(([path, text]) => [`file:${path}`, text]);
      return scriptsFor({
        id: "monitoring",
        params: { runAs: "root", ...Object.fromEntries(params) },
      });
    }

    /** The stack's removal, its volumes too with `removeData` (in a plan that deletes data). */
    function removal(removeData: boolean, runAs = "root") {
      const params = { remove: true, runAs, removeData };
      return scriptsFor({ id: "monitoring", params }, { deleteData: removeData });
    }

    it("writes every file from stdin and the password as root's 0640, then brings the stack up and waits", () => {
      const h = harness();
      try {
        // Dashboards larger than one script could hold reach the server on stdin.
        const big = `{"uid":"opscrew-logs","pad":"${"x".repeat(140 * 1024)}"}\n`;
        const files = { ...MONITORING_FILES, "grafana/dashboards/logs.json": big };
        const scripts = stack(files);
        expect(scripts.apply.length).toBeLessThan(MAX_SCRIPT_BYTES);
        expect(scripts.payload?.length).toBeGreaterThan(MAX_SCRIPT_BYTES);
        for (const script of [scripts.check, scripts.apply, scripts.verify]) {
          expect(shSyntax(script)?.ok).not.toBe(false);
        }
        expect(h.run(scripts.check).stdout).toContain("state=change");
        const pw = monitoringSecrets().grafanaAdminPassword;
        const run = h.run(scripts.apply, `${pw}\n${scripts.payload}`);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        for (const [path, content] of Object.entries(files)) {
          expect(h.read(`${STACK_DIR}/${path}`)).toBe(content);
        }
        expect(h.read(CREDENTIAL)).toBe(pw);
        // The password file: root's, read by Grafana's group 0 only.
        const calls = h.calls();
        const owned = calls
          .find((call) => call.startsWith("chown 0:0 "))
          ?.slice("chown 0:0 ".length);
        expect(owned).toMatch(/\/srv\/opscrew\/addons\/monitoring\/\.opscrew\./);
        expect(calls).toContain(`chmod 0640 ${owned}`);
        expect(
          calls.filter((call) => call.startsWith("docker compose") && call.includes(" up ")),
        ).toEqual([
          `docker compose -p opscrew-monitoring -f ${h.root}${STACK_DIR}/compose.yaml up -d --wait --wait-timeout 300 --remove-orphans --quiet-pull --force-recreate`,
        ]);
        expect(calls.join("\n")).not.toContain(pw);
        expect(h.run(scripts.verify).status).toBe(0);
        expect(h.run(scripts.check).stdout).toContain("state=in-place");
        // Applied again with the same files: no recreate.
        h.clearCalls();
        expect(h.run(scripts.apply, `${pw}\n${scripts.payload}`).status).toBe(0);
        expect(h.calls().find((call) => call.includes(" up "))).not.toContain("--force-recreate");
        // A file edited on the server is written back, and the services are recreated to see it.
        h.write(`${STACK_DIR}/prometheus.yml`, "edited on the server\n");
        h.clearCalls();
        expect(h.run(scripts.apply, `${pw}\n${scripts.payload}`).status).toBe(0);
        expect(h.calls().find((call) => call.includes(" up "))).toContain("--force-recreate");
        expect(h.read(`${STACK_DIR}/prometheus.yml`)).toBe(MONITORING_FILES["prometheus.yml"]);
      } finally {
        h.dispose();
      }
    });

    it("stops before starting anything without the password or a file on stdin", () => {
      const h = harness();
      try {
        const scripts = stack(MONITORING_FILES);
        const none = h.run(scripts.apply, "");
        expect(none.status).not.toBe(0);
        expect(none.stderr).toContain(
          "No valid Grafana admin password arrived on standard input, so the monitoring stack was not set up.",
        );
        const pw = monitoringSecrets().grafanaAdminPassword;
        const short = h.run(scripts.apply, `${pw}\n${scripts.payload?.split("\n")[0]}\n`);
        expect(short.status).not.toBe(0);
        expect(short.stderr).toContain("did not arrive on standard input, so OpsCrew stopped.");
        expect(h.calls().some((call) => call.includes(" up "))).toBe(false);
      } finally {
        h.dispose();
      }
    });

    it("removes the stack and its folder, and its volumes only with removeData", () => {
      const h = harness();
      try {
        for (const removeData of [false, true]) {
          h.write(`${STACK_DIR}/compose.yaml`, "services: {}\n");
          h.write(`${STACK_DIR}/grafana_admin_credential`, "x");
          h.write("/state/volumes", "");
          h.clearCalls();
          const scripts = removal(removeData);
          const check = h.run(scripts.check).stdout;
          expect(check).toContain("state=change");
          // Volumes that stay are still the owner's: the check says so, and the record keeps it.
          expect(check.includes("addon.history=kept")).toBe(!removeData);
          expect(h.run(scripts.apply).status).toBe(0);
          expect(h.exists("/state/volumes")).toBe(!removeData);
          const down = h.calls().find((call) => call.includes(" down "));
          expect(
            down?.endsWith(removeData ? "--remove-orphans --volumes" : "--remove-orphans"),
          ).toBe(true);
          expect(h.exists(STACK_DIR)).toBe(false);
          expect(h.run(scripts.verify).status).toBe(0);
        }
      } finally {
        h.dispose();
      }
    });

    it("match their snapshot", () => {
      const setup = stack(MONITORING_FILES);
      const remove = removal(true, "login");
      expect({
        check: setup.check,
        apply: setup.apply,
        verify: setup.verify,
        "remove apply": remove.apply,
        "remove verify": remove.verify,
      }).toMatchSnapshot();
    });
  },
);

describe("planning the monitoring add-ons again", () => {
  it("puts the stack in place when it runs as planned, and plans a changed file", async () => {
    const fake = cloudServer();
    fake.dockerAccess = true;
    fake.dockerRunning = true;
    const plan = async (files: Record<string, string>) =>
      planAddon("monitoring", {
        app: "shop",
        runAs: "login",
        facts: await inspectHost(fake, { rootImage: IMAGE }),
        enable: { files },
      });
    const { grafanaAdminPassword } = monitoringSecrets();
    expect(onlyStep(await plan(MONITORING_FILES)).state).toBe("change");
    await applyApproved(fake, await plan(MONITORING_FILES), {
      secrets: { grafanaAdminPassword },
      rootImage: IMAGE,
    });

    expect(onlyStep(await plan(MONITORING_FILES))).toMatchObject({ state: "in-place" });
    const changed = { ...MONITORING_FILES, "prometheus.yml": "global: {}\n" };
    expect(onlyStep(await plan(changed)).state).toBe("change");
    // A stopped container, or a missing password file, is a change too.
    const [first] = fake.containers.filter((c) => c.project === "opscrew-monitoring");
    if (first !== undefined) first.stopped = true;
    expect(onlyStep(await plan(MONITORING_FILES)).state).toBe("change");
    if (first !== undefined) first.stopped = false;
    fake.files.delete("/home/deploy/opscrew/addons/monitoring/grafana_admin_credential");
    expect(onlyStep(await plan(MONITORING_FILES)).state).toBe("change");
  });

  it("puts Alloy with destinations in place when it runs as planned, unless a secret is new", async () => {
    const fake = await ownServer();
    const enable = {
      files: ALLOY_FILES,
      server: "data",
      destinations: ["monitoring"] as const,
      postgresHost: "db",
    };
    const plan = async (options: { secretsChanged?: boolean; postgresHost?: string } = {}) =>
      planAddon("alloy", {
        app: "shop",
        runAs: "root",
        facts: await inspectHost(fake),
        enable: {
          ...enable,
          destinations: ["monitoring"],
          postgresHost: options.postgresHost ?? "db",
        },
        ...(options.secretsChanged === undefined ? {} : { secretsChanged: options.secretsChanged }),
      });
    const { monitoringPostgresPassword } = monitoringSecrets();
    await applyApproved(fake, await plan(), { secrets: { monitoringPostgresPassword } });

    expect(onlyStep(await plan()).state).toBe("in-place");
    expect(onlyStep(await plan({ secretsChanged: true })).state).toBe("change");
    expect(onlyStep(await plan({ postgresHost: "postgres" })).state).toBe("change");
    // Feature 017's Alloy (no destinations) is always planned as a change.
    const cloud = planAddon("alloy", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: { files: ALLOY_FILES },
    });
    expect(onlyStep(cloud).state).toBe("change");
  });

  it("puts the monitoring login in place once the server reads it so", async () => {
    const fake = await ownServer();
    const facts = await inspectHost(fake);
    const grant = MONITOR_GRANT;
    const read = () => readGrant(fake, { app: "shop", grant }, facts.privilege);
    expect(await read()).toBe(false);
    const plan = planGrant(facts, { app: "shop", grant, inPlace: await read() }, "x");
    expect(onlyStep(plan).state).toBe("change");
    const { monitoringPostgresPassword } = monitoringSecrets();
    await applyApproved(fake, plan, { secrets: { monitoringPostgresPassword } });

    expect(await read()).toBe(true);
    const again = planGrant(facts, { app: "shop", grant, inPlace: await read() }, "x");
    expect(onlyStep(again).state).toBe("in-place");
    // Its removal reads the other way round.
    const removal = { ...grant, remove: true };
    expect(await readGrant(fake, { app: "shop", grant: removal }, facts.privilege)).toBe(false);
    // A login that cannot become root reads nothing.
    expect(await readGrant(fake, { app: "shop", grant }, "none")).toBe(false);
  });
});

describe("Alloy on any server of the app", () => {
  it("sends to the monitoring stack only: no Grafana Cloud token, its destinations on the server, an old token removed", async () => {
    const fake = cloudServer();
    const dir = "/home/deploy/opscrew/addons/alloy";
    fake.files.set(`${dir}/grafana_cloud_credential`, "an old token");
    const plan = planAddon("alloy", {
      app: "shop",
      runAs: "login",
      enable: { files: ALLOY_FILES, server: "monitoring", destinations: ["monitoring"] },
    });
    const step = onlyStep(plan);
    expect(step.title).toBe(
      'Run Grafana Alloy as the deploy user on the server "monitoring", sending its figures, and the logs of "shop" (masked), to OpsCrew\'s monitoring',
    );
    expect(step.reason).toContain("It needs no secret.");
    expect(step.params).toMatchObject({ server: "monitoring", destinations: "monitoring" });
    const result = await applyApproved(fake, plan);
    expect(result.applied).toEqual(["alloy"]);
    expect(fake.calls.find((call) => call.name === "alloy.apply")?.input).toBeUndefined();
    expect(fake.files.has(`${dir}/grafana_cloud_credential`)).toBe(false);
    expect(fake.files.get(`${dir}/.opscrew-destinations`)).toBe("monitoring\n");
    expect((await applyApproved(fake, plan)).applied).toEqual([]);
    expect((await inspectHost(fake)).alloy).toMatchObject({ destinations: ["monitoring"] });
  });

  it("on Postgres's server writes the monitoring login's whole data source from stdin, never in the plan", async () => {
    const fake = await ownServer();
    const { grafanaCloudToken } = addonSecrets().secrets;
    const { monitoringPostgresPassword } = monitoringSecrets();
    const plan = planAddon("alloy", {
      app: "shop",
      runAs: "root",
      facts: await inspectHost(fake),
      enable: {
        files: ALLOY_FILES,
        server: "app",
        destinations: ["monitoring", "grafanaCloud", "monitoring"],
        postgresHost: "db",
      },
    });
    const step = onlyStep(plan);
    expect(step.params).toMatchObject({
      destinations: "grafanaCloud monitoring",
      postgresHost: "db",
    });
    expect(step.title).toBe(
      `Run Grafana Alloy as the deploy user on the server "app", sending its figures and Postgres's (db), and the logs of "shop" (masked), to OpsCrew's monitoring and your Grafana Cloud stack`,
    );
    expect(step.reason).toContain(
      "Its Grafana Cloud token and the monitoring login's password to Postgres, inside its data source, are written at apply time to files only the deploy user can read",
    );
    expect(
      (await rejection(applyApproved(fake, plan, { secrets: { grafanaCloudToken } }))).message,
    ).toBe(
      "Applying this plan needs the password of the monitoring login to Postgres, and none was supplied.",
    );
    await applyApproved(fake, plan, { secrets: { grafanaCloudToken, monitoringPostgresPassword } });
    const dir = "/srv/opscrew/addons/alloy";
    expect(fake.files.get(`${dir}/postgres_monitor_credential`)).toBe(
      `postgresql://opscrew_monitor:${monitoringPostgresPassword}@db:5432/postgres?sslmode=disable`,
    );
    // The host apart from the secret, for inspection, which never reads the data source.
    expect(fake.files.get(`${dir}/.opscrew-postgres-host`)).toBe("db\n");
    expect((await inspectHost(fake)).alloy?.postgresHost).toBe("db");
    expect(fake.calls.find((call) => call.name === "alloy.apply")?.input).toBe(
      `${grafanaCloudToken}\n${monitoringPostgresPassword}\n`,
    );
    const seen = everythingButStdin(fake, plan);
    expect(seen).not.toContain(monitoringPostgresPassword);
    expect(seen).not.toContain(grafanaCloudToken);
    expect(hostRecord(fake).addons).toEqual({ alloy: "shop" });
  });

  it("refuses destinations without the server, Postgres without the monitoring stack, and either for Beszel", () => {
    const options = { app: "shop", runAs: "login" } as const;
    for (const enable of [
      { files: ALLOY_FILES, destinations: ["monitoring" as const] },
      { files: ALLOY_FILES, server: "app" },
      {
        files: ALLOY_FILES,
        server: "app",
        destinations: ["grafanaCloud" as const],
        postgresHost: "db",
      },
    ]) {
      expect(() => planAddon("alloy", { ...options, enable })).toThrow(/invalid parameters/);
    }
    expect(() =>
      planAddon("alloy", {
        ...options,
        enable: { files: ALLOY_FILES, server: "Bad Name", destinations: ["monitoring"] },
      }),
    ).toThrow(/server: must be a server's name/);
    const params = {
      runAs: "login",
      mode: "agent",
      server: "app",
      destinations: "monitoring",
      "file:compose.yaml": "services: {}\n",
    };
    expect(() => scriptsFor({ id: "beszel", params })).toThrow(
      /invalid parameters \(destinations\)/,
    );
  });

  it.skipIf(!SH_AVAILABLE)(
    "writes the data source without a trailing newline, only through builtins, in a real shell",
    () => {
      const h = new ShellHarness();
      try {
        h.stub(
          "docker",
          `case "$*" in *" config --services"*|*" ps --services"*) echo alloy ;; esac`,
        );
        h.stub("getent", "exit 0", { log: false });
        h.stub("id", "echo 1000", { log: false });
        const plan = planAddon("alloy", {
          app: "shop",
          runAs: "login",
          enable: {
            files: ALLOY_FILES,
            server: "db-server",
            destinations: ["monitoring"],
            postgresHost: "db",
          },
        });
        const scripts = stepScripts(plan, onlyStep(plan));
        expect(scripts.secrets).toEqual({ names: ["monitoringPostgresPassword"], required: true });
        const dir = "/home/deploy/opscrew/addons/alloy";
        h.write(`${dir}/grafana_cloud_credential`, "an old token");
        const pw = monitoringSecrets().monitoringPostgresPassword;
        const run = h.run(scripts.apply, `${pw}\n`);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(h.read(`${dir}/postgres_monitor_credential`)).toBe(
          `postgresql://opscrew_monitor:${pw}@db:5432/postgres?sslmode=disable`,
        );
        expect(h.exists(`${dir}/grafana_cloud_credential`)).toBe(false);
        expect(h.read(`${dir}/.opscrew-destinations`)).toBe("monitoring\n");
        expect(h.calls().join("\n")).not.toContain(pw);
        const uses = scripts.apply.split("\n").filter((line) => /\$pgpw\b/.test(line));
        expect(uses.map((line) => line.trim().split(" ")[0])).toEqual(["case", "printf"]);
        expect(h.run(scripts.verify).status).toBe(0);
        // A renamed Postgres service is noticed: the host file names another host.
        const renamed = planAddon("alloy", {
          app: "shop",
          runAs: "login",
          enable: {
            files: ALLOY_FILES,
            server: "db-server",
            destinations: ["monitoring"],
            postgresHost: "pg",
          },
        });
        expect(h.run(stepScripts(renamed, onlyStep(renamed)).check).stdout).toContain(
          "state=change",
        );
        expect(h.run(scripts.apply, "not a password!\n").stderr).toContain(
          "No valid password of the monitoring login arrived on standard input",
        );
      } finally {
        h.dispose();
      }
    },
  );
});

describe.skipIf(!SH_AVAILABLE)(
  "Alloy's and Beszel's containers in a real shell (docker stubbed)",
  () => {
    it("are recreated when a file they read changed, the config or a secret, and only then", () => {
      const [one, two] = [addonSecrets().secrets, addonSecrets().secrets];
      const kinds: {
        kind: string;
        plan: (files: Record<string, string>) => HostPlan;
        files: Record<string, string>;
        config: string;
        tokens: [string, string];
      }[] = [
        {
          kind: "alloy",
          plan: (files) => planAddon("alloy", { app: "shop", runAs: "login", enable: { files } }),
          files: ALLOY_FILES,
          config: "config.alloy",
          tokens: [one.grafanaCloudToken, two.grafanaCloudToken],
        },
        {
          kind: "beszel",
          plan: (files) =>
            planAddon("beszel", { app: "shop", runAs: "login", enable: { mode: "agent", files } }),
          files: BESZEL_AGENT_FILES,
          config: "Caddyfile",
          tokens: [one.beszelToken, two.beszelToken],
        },
      ];
      for (const { kind, plan, files, config, tokens } of kinds) {
        const h = new ShellHarness();
        try {
          h.stub(
            "docker",
            `case "$*" in
  *" config --services"*) echo main ;;
  *" ps --services --status running"*) if [ -e "$S/up" ]; then echo main; fi ;;
  *" up "*) touch "$S/up" ;;
esac
exit 0`,
          );
          h.stub("getent", "exit 0", { log: false });
          h.stub("id", "echo 1000", { log: false });
          const scriptsOf = (of: Record<string, string>) => {
            const planned = plan(of);
            return stepScripts(planned, onlyStep(planned));
          };
          const same = scriptsOf(files);
          const changed = scriptsOf({ ...files, [config]: `${files[config]}# edited\n` });
          /** Applies `scripts` with `token`, the container stopped first; true when it recreated. */
          const recreated = (scripts: typeof same, token: string) => {
            h.run(`rm -f '${h.root}/state/up'`);
            h.clearCalls();
            const run = h.run(scripts.apply, `${token}\n`);
            expect(run.stderr, kind).toBe("");
            const up = h
              .calls()
              .filter((call) => call.startsWith("docker compose") && call.includes(" up "));
            expect(up, kind).toHaveLength(1);
            return up[0]?.endsWith(" --force-recreate");
          };
          expect(recreated(same, tokens[0]), `${kind}: first start`).toBe(true);
          expect(recreated(same, tokens[0]), `${kind}: nothing changed`).toBe(false);
          expect(recreated(changed, tokens[0]), `${kind}: ${config} changed`).toBe(true);
          expect(recreated(changed, tokens[0]), `${kind}: nothing changed again`).toBe(false);
          expect(recreated(changed, tokens[1]), `${kind}: its secret changed`).toBe(true);
          expect(h.run(changed.verify).status, kind).toBe(0);
        } finally {
          h.dispose();
        }
      }
    });
  },
);

describe("the monitoring secrets never leak (SC-2008)", () => {
  it("stay out of errors from a failing apply that echoes its stdin", async () => {
    const fake = await ownServer();
    const secrets = monitoringSecrets();
    const plan = await stackPlan(fake);
    fake.echoStdinOn = "monitoring.apply";
    const error = await rejection(
      applyApproved(fake, plan, {
        secrets: { grafanaAdminPassword: secrets.grafanaAdminPassword },
      }),
    );
    expect(error).toBeInstanceOf(HostApplyError);
    expect(`${error.message} ${error.hint}`).not.toContain(secrets.grafanaAdminPassword);
  });
});
