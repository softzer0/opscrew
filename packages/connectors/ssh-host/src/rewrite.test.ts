// A change of secrets only reaches the server: the step's `rewrite` parameter (T2022).
import { canonicalJson } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  ALLOY_FILES,
  addonSecrets,
  applyApproved,
  BESZEL_AGENT_FILES,
  cloudServer,
  monitoringSecrets,
  provision,
  SH_AVAILABLE,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { HostApplyError } from "./apply";
import type { GrantParams } from "./grant";
import { inspectHost } from "./inspect";
import { type AddonEnable, planAddon, planGrant } from "./plan";
import { stepScripts } from "./steps";
import type { HostPlan, HostStep } from "./types";

function onlyStep(plan: HostPlan): HostStep {
  const [step] = plan.steps;
  if (step === undefined || plan.steps.length !== 1) throw new Error("expected one step");
  return step;
}

function scriptsOf(plan: HostPlan) {
  return stepScripts(plan, onlyStep(plan));
}

/** The plan with its step's parameters `params`. */
function withParams(plan: HostPlan, params: HostStep["params"]): HostPlan {
  return { ...plan, steps: [{ ...onlyStep(plan), params }] };
}

/** A server the user owns with "shop" set up on it. */
async function ownServer(): Promise<FakeHost> {
  const fake = new FakeHost();
  await provision(fake);
  return fake;
}

/** The facts of a server the user owns with "shop" on it, for the plans of the monitoring login. */
const FACTS = await inspectHost(await ownServer());

/** The monitoring login on the app's Postgres. */
const MONITOR: GrantParams = {
  service: "db",
  kind: "postgres",
  login: "opscrew_monitor",
  access: "monitor",
  remove: false,
};

/** Alloy on Postgres's server, sending to the stack and to Grafana Cloud: both of its secrets. */
const ALLOY_BOTH: AddonEnable<"alloy"> = {
  files: ALLOY_FILES,
  server: "app",
  destinations: ["grafanaCloud", "monitoring"],
  postgresHost: "db",
};

/** Each add-on step a secret of which can change, planned without and with a new secret. */
function addonPlans(secretsChanged: boolean) {
  const options = { app: "shop", runAs: "login", secretsChanged } as const;
  return {
    "Grafana Cloud's Alloy": planAddon("alloy", { ...options, enable: { files: ALLOY_FILES } }),
    "Alloy with destinations": planAddon("alloy", { ...options, enable: ALLOY_BOTH }),
    "Beszel's agent": planAddon("beszel", {
      ...options,
      enable: { mode: "agent", files: BESZEL_AGENT_FILES },
    }),
  };
}

/** Every command the fake ran (stdin aside) and the plan's hash input. */
function everythingButStdin(fake: FakeHost, plan: HostPlan): string {
  return [canonicalJson(plan), ...fake.calls.map((call) => call.command)].join("\n");
}

async function rejection(promise: Promise<unknown>): Promise<Error & { hint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { hint?: string };
  }
  throw new Error("expected a rejection");
}

describe("planning a new secret", () => {
  it("gives Beszel's and Alloy's step only the rewrite parameter, bound into the plan's hash", () => {
    const before = addonPlans(false);
    const after = addonPlans(true);
    for (const [what, plan] of Object.entries(after)) {
      const step = onlyStep(plan);
      const { rewrite, ...rest } = step.params;
      expect(rewrite, what).toBe(true);
      expect(step.state, what).toBe("change");
      // The plan's text is the same but for the parameter, so its hash differs.
      const without = before[what as keyof typeof before];
      expect(onlyStep(without).params, what).not.toHaveProperty("rewrite");
      expect(withParams(plan, rest), what).toEqual(without);
      expect(canonicalJson(plan), what).not.toBe(canonicalJson(without));
      // Only the check changes: it prints state=change. The apply and the verify stay.
      const [old, rewritten] = [scriptsOf(without), scriptsOf(plan)];
      expect(rewritten.apply, what).toBe(old.apply);
      expect(rewritten.verify, what).toBe(old.verify);
      expect(rewritten.check, what).toContain("REWRITE='true'");
      expect(rewritten.check.trimEnd().split("\n").at(-1), what).toBe("echo state=change");
      expect(old.check, what).not.toContain("REWRITE");
    }
  });

  it("makes the monitoring login a change with the rewrite parameter, though the server reads it in place", () => {
    const input = { app: "shop", grant: MONITOR, inPlace: true } as const;
    const kept = planGrant(FACTS, input, "opscrew provision");
    expect(onlyStep(kept).state).toBe("in-place");
    expect(onlyStep(kept).params).not.toHaveProperty("rewrite");
    const fresh = planGrant(FACTS, { ...input, secretsChanged: true }, "opscrew provision");
    expect(onlyStep(fresh)).toMatchObject({ state: "change", params: { rewrite: true } });
    const { rewrite: _, ...rest } = onlyStep(fresh).params;
    expect(rest).toEqual(onlyStep(kept).params);
    expect(canonicalJson(fresh)).not.toBe(canonicalJson(kept));
    const [old, rewritten] = [scriptsOf(kept), scriptsOf(fresh)];
    expect(rewritten.apply).toBe(old.apply);
    expect(rewritten.verify).toBe(old.verify);
    expect(rewritten.check).toContain("REWRITE='true'");
    expect(old.check).not.toContain("REWRITE");
  });

  it("refuses a rewrite parameter that is not true", () => {
    const { "Alloy with destinations": alloy } = addonPlans(false);
    const grant = planGrant(FACTS, { app: "shop", grant: MONITOR }, "opscrew provision");
    for (const plan of [alloy, grant]) {
      for (const value of [false, "true"]) {
        const odd = withParams(plan, { ...onlyStep(plan).params, rewrite: value });
        expect(() => scriptsOf(odd)).toThrow(/invalid parameters \(rewrite/);
      }
    }
  });
});

describe("applying a new secret on the fake host", () => {
  it("sets the monitoring login's new password, though the login is there as planned", async () => {
    const fake = await ownServer();
    const facts = await inspectHost(fake);
    const [one, two] = [monitoringSecrets(), monitoringSecrets()];
    const first = planGrant(facts, { app: "shop", grant: MONITOR }, "opscrew provision");
    await applyApproved(fake, first, {
      secrets: { monitoringPostgresPassword: one.monitoringPostgresPassword },
    });
    // Without rewrite the server's check finds the login as planned: nothing is applied.
    const again = await applyApproved(fake, first, {
      secrets: { monitoringPostgresPassword: two.monitoringPostgresPassword },
    });
    expect(again.applied).toEqual([]);

    const pw = two.monitoringPostgresPassword;
    const plan = planGrant(
      facts,
      { app: "shop", grant: MONITOR, inPlace: true, secretsChanged: true },
      "opscrew provision",
    );
    fake.calls.length = 0;
    const result = await applyApproved(fake, plan, { secrets: { monitoringPostgresPassword: pw } });
    expect(result.applied).toEqual(["grant"]);
    expect(fake.calls.find((call) => call.name === "grant.apply")?.input).toBe(`${pw}\n`);
    expect(fake.grantLog.at(-1)).toBe("update shop/db/opscrew_monitor");
    expect(everythingButStdin(fake, plan)).not.toContain(pw);

    // A failing apply that echoes its stdin: the error shows no password.
    fake.echoStdinOn = "grant.apply";
    const error = await rejection(
      applyApproved(fake, plan, { secrets: { monitoringPostgresPassword: pw } }),
    );
    expect(error).toBeInstanceOf(HostApplyError);
    expect(`${error.message} ${error.hint}`).not.toContain(pw);
  });

  it("writes Alloy's new token and data source, though Alloy runs as planned", async () => {
    const fake = cloudServer();
    const dir = "/home/deploy/opscrew/addons/alloy";
    const [one, two] = [addonSecrets().secrets, addonSecrets().secrets];
    const [pg1, pg2] = [monitoringSecrets(), monitoringSecrets()];
    const plan = (secretsChanged: boolean) =>
      planAddon("alloy", { app: "shop", runAs: "login", enable: ALLOY_BOTH, secretsChanged });
    await applyApproved(fake, plan(false), {
      secrets: {
        grafanaCloudToken: one.grafanaCloudToken,
        monitoringPostgresPassword: pg1.monitoringPostgresPassword,
      },
    });
    const secrets = {
      grafanaCloudToken: two.grafanaCloudToken,
      monitoringPostgresPassword: pg2.monitoringPostgresPassword,
    };
    expect((await applyApproved(fake, plan(false), { secrets })).applied).toEqual([]);
    expect(fake.files.get(`${dir}/grafana_cloud_credential`)).toBe(one.grafanaCloudToken);

    fake.calls.length = 0;
    const rewrite = plan(true);
    expect((await applyApproved(fake, rewrite, { secrets })).applied).toEqual(["alloy"]);
    expect(fake.files.get(`${dir}/grafana_cloud_credential`)).toBe(two.grafanaCloudToken);
    expect(fake.files.get(`${dir}/postgres_monitor_credential`)).toContain(
      `:${pg2.monitoringPostgresPassword}@db:5432/`,
    );
    // The containers are recreated: they read the secrets only when they start.
    expect(fake.composeUps.at(-1)).toMatchObject({ recreate: true });
    const seen = everythingButStdin(fake, rewrite);
    for (const secret of Object.values(secrets)) expect(seen).not.toContain(secret);
  });
});

/** Docker as the add-ons' scripts use it: one service, running once `up` ran. */
const COMPOSE_STUB = `case "$*" in
  *" config --services"*) echo main ;;
  *" ps --services --status running"*) if [ -e "$S/up" ]; then echo main; fi ;;
  *" up "*) touch "$S/up" ;;
esac
exit 0`;

describe.skipIf(!SH_AVAILABLE)("a new secret in a real shell", () => {
  /** A harness whose docker, getent and id are stubs, for the add-ons' scripts. */
  function addonHarness(): ShellHarness {
    const h = new ShellHarness();
    h.stub("docker", COMPOSE_STUB);
    h.stub("getent", "exit 0", { log: false });
    h.stub("id", "echo 1000", { log: false });
    return h;
  }

  it("writes Alloy's new Grafana Cloud token and Postgres data source only with rewrite", () => {
    const h = addonHarness();
    try {
      const dir = "/home/deploy/opscrew/addons/alloy";
      const plan = (secretsChanged: boolean) =>
        planAddon("alloy", { app: "shop", runAs: "login", enable: ALLOY_BOTH, secretsChanged });
      const [plain, rewrite] = [scriptsOf(plan(false)), scriptsOf(plan(true))];
      const [one, two] = [addonSecrets().secrets, addonSecrets().secrets];
      const [pg1, pg2] = [monitoringSecrets(), monitoringSecrets()];
      const first = h.run(
        plain.apply,
        `${one.grafanaCloudToken}\n${pg1.monitoringPostgresPassword}\n`,
      );
      expect(first.stderr).toBe("");
      expect(first.status).toBe(0);
      // Unchanged, the step stays in place; with rewrite it is a change.
      expect(h.run(plain.check).stdout).toContain("state=in-place");
      expect(h.run(rewrite.check).stdout).toContain("state=change");

      const run = h.run(
        rewrite.apply,
        `${two.grafanaCloudToken}\n${pg2.monitoringPostgresPassword}\n`,
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(h.read(`${dir}/grafana_cloud_credential`)).toBe(two.grafanaCloudToken);
      expect(h.read(`${dir}/postgres_monitor_credential`)).toBe(
        `postgresql://opscrew_monitor:${pg2.monitoringPostgresPassword}@db:5432/postgres?sslmode=disable`,
      );
      expect(h.run(rewrite.verify).status).toBe(0);
      expect(h.run(plain.check).stdout).toContain("state=in-place");
      const calls = h.calls().join("\n");
      for (const secret of [two.grafanaCloudToken, pg2.monitoringPostgresPassword]) {
        expect(calls).not.toContain(secret);
      }
    } finally {
      h.dispose();
    }
  });

  it("writes Beszel's new agent token only with rewrite", () => {
    const h = addonHarness();
    try {
      const plan = (secretsChanged: boolean) =>
        planAddon("beszel", {
          app: "shop",
          runAs: "login",
          enable: { mode: "agent", files: BESZEL_AGENT_FILES },
          secretsChanged,
        });
      const [plain, rewrite] = [scriptsOf(plan(false)), scriptsOf(plan(true))];
      const [one, two] = [addonSecrets().secrets.beszelToken, addonSecrets().secrets.beszelToken];
      expect(h.run(plain.apply, `${one}\n`).status).toBe(0);
      expect(h.run(plain.check).stdout).toContain("state=in-place");
      expect(h.run(rewrite.check).stdout).toContain("state=change");

      const run = h.run(rewrite.apply, `${two}\n`);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(h.read("/home/deploy/opscrew/addons/beszel/agent.env")).toBe(`TOKEN=${two}\n`);
      expect(h.run(rewrite.verify).status).toBe(0);
      expect(h.calls().join("\n")).not.toContain(two);
    } finally {
      h.dispose();
    }
  });

  it("sets the monitoring login's new password through the grant's statements only with rewrite", () => {
    const h = new ShellHarness();
    try {
      h.stub(
        "docker",
        `stdin=$(cat)
printf '%s\\n---\\n' "$stdin" >> "$S/stdin"
case "$stdin" in *opscrew-*) echo opscrew-read; cat "$S/state" 2>/dev/null ;; esac
exit 0`,
      );
      // The login is there with the planned access.
      h.write("/state/state", "opscrew-login=monitor\n");
      const plan = (secretsChanged: boolean) =>
        planGrant(FACTS, { app: "shop", grant: MONITOR, secretsChanged }, "x");
      const [plain, rewrite] = [scriptsOf(plan(false)), scriptsOf(plan(true))];
      expect(h.run(plain.check).stdout).toContain("state=in-place");
      expect(h.run(rewrite.check).stdout).toContain("state=change");

      const pw = monitoringSecrets().monitoringPostgresPassword;
      const run = h.run(rewrite.apply, `${pw}\n`);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const sent = (h.read("/state/stdin") ?? "").split("\n---\n").filter(Boolean);
      expect(sent.at(-1)).toBe(
        [
          "SET client_min_messages = error;",
          `ALTER ROLE "opscrew_monitor" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 3 PASSWORD '${pw}';`,
          `GRANT pg_monitor TO "opscrew_monitor";`,
        ].join("\n"),
      );
      expect(h.run(rewrite.verify).status).toBe(0);
      expect(h.calls().join("\n")).not.toContain(pw);
    } finally {
      h.dispose();
    }
  });
});
