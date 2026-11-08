// Feature 025 (T2519): Grafana's and Beszel's values set at their first start only, rotated in the
// running add-on by their host steps, before the files that hold them; only in a rotation.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addonSecrets,
  BESZEL_HUB,
  ed25519PublicKey,
  MONITORING_FILES,
  monitoringSecrets,
  ownServer,
  SH_AVAILABLE,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { inspectHost } from "./inspect";
import { planAddon } from "./plan";
import { stepScripts } from "./steps";
import type { HostPlan } from "./types";

const scriptsOf = (plan: HostPlan) => {
  const [step] = plan.steps;
  if (step === undefined) throw new Error("no step");
  return stepScripts(plan, step);
};

/** The PATH line of OpsCrew's host scripts, which the harness points at its stubs. */
const SCRIPT_PATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

describe.skipIf(!SH_AVAILABLE)("Grafana's admin password in a real shell (docker stubbed)", () => {
  const DIR = "/srv/opscrew/addons/monitoring";
  const CREDENTIAL = `${DIR}/grafana_admin_credential`;

  /** docker: `up` starts the stack; `exec` into Grafana keeps its stdin, failing on `$S/refuse`. */
  function harness(): ShellHarness {
    const h = new ShellHarness();
    h.stub(
      "docker",
      `case "$*" in
  *" exec -T grafana grafana cli admin reset-admin-password --password-from-stdin") cat > "$S/grafana-stdin"; [ ! -e "$S/refuse" ] ;;
  *" config --services"*) printf '%s\\n' front grafana loki prometheus ;;
  *" ps --services --status running"*) if [ -e "$S/up" ]; then printf '%s\\n' front grafana loki prometheus; fi ;;
  *" up "*) touch "$S/up" ;;
esac`,
    );
    h.stub("getent", "exit 0", { log: false });
    h.stub("id", "echo 1000", { log: false });
    h.stub("stat", "echo 0:0:640", { log: false });
    const chmod = spawnSync("bash", ["-c", "command -v chmod"], { encoding: "utf8" }).stdout.trim();
    h.stub("chmod", `exec '${chmod}' "$@"`);
    return h;
  }

  /** The stack's scripts, as provision plans them or (`rotating`) as a rotation does. */
  async function stack(rotating: boolean) {
    return scriptsOf(
      planAddon("monitoring", {
        app: "shop",
        runAs: "root",
        facts: await inspectHost(await ownServer()),
        enable: { files: MONITORING_FILES },
        secretsChanged: rotating,
      }),
    );
  }

  const apply = (h: ShellHarness, scripts: ReturnType<typeof scriptsOf>, pw: string) =>
    h.run(scripts.apply, `${pw}\n${scripts.payload}`);

  it("in a rotation sets a new one in the running Grafana first, on its CLI's stdin, then the file; never in provision", async () => {
    const plain = await stack(false);
    const rotation = await stack(true);
    const h = harness();
    try {
      // Provision: Grafana makes its admin from the file; a password the file does not hold is
      // only written there, as before (provision never rotates).
      const first = monitoringSecrets().grafanaAdminPassword;
      expect(apply(h, plain, first).status).toBe(0);
      expect(apply(h, plain, monitoringSecrets().grafanaAdminPassword).status).toBe(0);
      expect(h.exists("/state/grafana-stdin")).toBe(false);
      // Rotated even though the stack runs as planned.
      expect(h.run(rotation.check).stdout).toContain("state=change");

      const next = randomBytes(24).toString("base64url");
      const rotated = apply(h, rotation, next);
      expect(rotated.stderr).toBe("");
      expect(rotated.status).toBe(0);
      expect(h.read("/state/grafana-stdin")).toBe(`${next}\n`);
      expect(h.read(CREDENTIAL)).toBe(next);
      expect(h.calls()).toContain(
        `docker compose -p opscrew-monitoring -f ${h.root}${DIR}/compose.yaml exec -T grafana grafana cli admin reset-admin-password --password-from-stdin`,
      );
      for (const pw of [first, next]) expect(h.calls().join("\n")).not.toContain(pw);
    } finally {
      h.dispose();
    }
  });

  it("in a rotation leaves the file when Grafana refuses, asks nothing when the file has it, and sets it without a file", async () => {
    const rotation = await stack(true);
    const h = harness();
    try {
      const next = randomBytes(24).toString("base64url");
      h.write(CREDENTIAL, next);
      // Grafana refuses: the file keeps the password Grafana has, so a re-run sets it again.
      h.write("/state/refuse", "");
      const third = randomBytes(24).toString("base64url");
      const refused = apply(h, rotation, third);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("The running Grafana did not take its new admin password");
      expect(refused.stderr).not.toContain(third);
      expect(h.read(CREDENTIAL)).toBe(next);
      rmSync(h.native("/state/refuse"));

      // The file holds the password already: Grafana is not asked.
      h.clearCalls();
      expect(apply(h, rotation, next).status).toBe(0);
      expect(h.calls().some((call) => call.includes(" exec "))).toBe(false);
      // No file: a rotation still sets the password in Grafana first.
      rmSync(h.native(CREDENTIAL));
      const fourth = randomBytes(24).toString("base64url");
      expect(apply(h, rotation, fourth).status).toBe(0);
      expect(h.read("/state/grafana-stdin")).toBe(`${fourth}\n`);
      for (const pw of [next, third, fourth]) expect(h.calls().join("\n")).not.toContain(pw);
    } finally {
      h.dispose();
    }
  });
});

describe.skipIf(!SH_AVAILABLE)(
  "Beszel's hub password in a real shell (docker and curl stubbed)",
  () => {
    const DIR = "/home/deploy/opscrew/addons/beszel";
    const SUPERUSER = "sup1234567890ab";
    const USER = "usr1234567890ab";
    const TOKEN = `ey${randomBytes(12).toString("hex")}.x`;

    /**
     * docker as in a deploy (the hub runs once `up` ran, until `$S/up` goes); curl (unless
     * `curl: false`) as Beszel's hub on its loopback (PocketBase's API): its whole configuration on
     * stdin (kept in `$S/curl`), the superuser signed in with the hub's password (`$S/hub`), and
     * each account's new password kept.
     */
    function harness(o: { curl?: boolean } = {}): ShellHarness {
      const h = new ShellHarness();
      h.stub("getent", `echo "deploy:x:1000:1000::${h.root}/home/deploy:/bin/sh"`, { log: false });
      h.stub("id", "echo 1000", { log: false });
      h.stub(
        "docker",
        `case "$*" in
  *" config --services") printf 'hub\\nagent\\nproxy\\n' ;;
  *" ps --services --status running") if [ -f "$S/up" ]; then printf 'proxy\\nhub\\nagent\\n'; fi ;;
  *" up -d "*) touch "$S/up" ;;
esac`,
      );
      if (o.curl === false) return h;
      h.stub(
        "curl",
        `cfg=$(cat)
printf '%s\\n---\\n' "$cfg" >> "$S/curl"
field() { printf '%s' "$cfg" | sed -n "s/.*\\"$1\\":\\"\\([^\\"]*\\)\\".*/\\1/p"; }
case "$cfg" in *"url = http://127.0.0.1:8090/"*) ;; *) exit 7 ;; esac
case "$cfg" in
  *auth-with-password*)
    [ "$(field identity)" = ops@example.com ] || exit 22
    [ "$(field password)" = "$(cat "$S/hub")" ] || exit 22
    printf '{"record":{"collectionId":"pbc_3142635823","email":"ops@example.com","id":"${SUPERUSER}"},"token":"${TOKEN}"}' ;;
  *"Authorization: ${TOKEN}"*"records/${USER}"*|*"records/${USER}"*"Authorization: ${TOKEN}"*) field password > "$S/user" ;;
  *"Authorization: ${TOKEN}"*"_superusers/records/${SUPERUSER}"*|*"_superusers/records/${SUPERUSER}"*"Authorization: ${TOKEN}"*) field password > "$S/hub" ;;
  *"users/records"*"Authorization: ${TOKEN}"*)
    case "$cfg" in *'filter=email="ops@example.com"'*) printf '{"items":[{"id":"${USER}"}],"page":1}' ;; *) exit 22 ;; esac ;;
  *) exit 22 ;;
esac`,
      );
      return h;
    }

    /** Beszel's hub mode with `hubKey` as the agent's key: as `addon enable` plans it, or a rotation. */
    const scripts = (rotating: boolean, hubKey = BESZEL_HUB.hubKey) =>
      scriptsOf(
        planAddon("beszel", {
          app: "shop",
          runAs: "login",
          enable: { ...BESZEL_HUB, hubKey },
          secretsChanged: rotating,
        }),
      );

    const input = (secrets: ReturnType<typeof addonSecrets>["secrets"]) =>
      `${[secrets.beszelPassword, secrets.beszelToken, Buffer.from(secrets.beszelHubKey).toString("base64")].join("\n")}\n`;

    /** The hub running with the password `old`, from a first start as `addon enable` makes it. */
    function started(h: ShellHarness) {
      const old = addonSecrets().secrets;
      const first = h.run(scripts(false).apply, input(old));
      expect(first.status, first.stderr).toBe(0);
      h.write("/state/hub", old.beszelPassword);
      return old;
    }

    it("in a rotation changes the running hub's user and superuser first, every value on curl's stdin, then its files", () => {
      const h = harness();
      try {
        const old = started(h);
        // Outside a rotation (`addon enable` again with other values) the hub is not asked.
        const other = addonSecrets().secrets;
        expect(h.run(scripts(false).apply, input(other)).status).toBe(0);
        expect(h.exists("/state/curl")).toBe(false);
        h.run(scripts(false).apply, input(old));

        const next = addonSecrets().secrets;
        const hubKey = ed25519PublicKey();
        const rotation = scripts(true, hubKey);
        expect(h.run(rotation.check).stdout).toContain("state=change");
        h.clearCalls();
        const rotated = h.run(rotation.apply, input(next));
        expect(rotated.stderr).toBe("");
        expect(rotated.status).toBe(0);
        expect(h.read("/state/hub")).toBe(next.beszelPassword);
        expect(h.read("/state/user")).toBe(next.beszelPassword);
        expect(h.read(`${DIR}/hub.env`)).toBe(
          `USER_EMAIL=ops@example.com\nUSER_PASSWORD=${next.beszelPassword}\n`,
        );
        expect(h.read(`${DIR}/agent.env`)).toBe(`TOKEN=${next.beszelToken}\nKEY=${hubKey}\n`);
        expect(h.read(`${DIR}/data/id_ed25519`)).toBe(next.beszelHubKey);
        // The hub and the agent start again on the new key and token.
        expect(h.calls().find((call) => call.includes(" up "))).toContain("--force-recreate");
        // Signed in with the new password first (a run that set it already), then hub.env's.
        const configs = (h.read("/state/curl") ?? "").split("\n---\n").filter(Boolean);
        expect(configs.map((cfg) => /url = \S+/.exec(cfg)?.[0])).toEqual([
          "url = http://127.0.0.1:8090/api/collections/_superusers/auth-with-password",
          "url = http://127.0.0.1:8090/api/collections/_superusers/auth-with-password",
          "url = http://127.0.0.1:8090/api/collections/users/records",
          `url = http://127.0.0.1:8090/api/collections/users/records/${USER}`,
          `url = http://127.0.0.1:8090/api/collections/_superusers/records/${SUPERUSER}`,
        ]);
        // No value on a command line: the stubs log their arguments.
        const calls = h.calls().join("\n");
        for (const value of [...Object.values(old), ...Object.values(next), TOKEN]) {
          expect(calls).not.toContain(value);
        }

        // Applied again: hub.env has the new password, so the hub is not asked.
        h.write("/state/curl", "");
        expect(h.run(rotation.apply, input(next)).status).toBe(0);
        expect(h.read("/state/curl")).toBe("");
      } finally {
        h.dispose();
      }
    });

    it("goes on when the hub has the new password already, and stops with the files as they were when it has neither", () => {
      const h = harness();
      try {
        started(h);
        // A run that stopped after the hub took the new password, before hub.env.
        const next = addonSecrets().secrets;
        h.write("/state/hub", next.beszelPassword);
        const resumed = h.run(scripts(true).apply, input(next));
        expect(resumed.status, resumed.stderr).toBe(0);
        expect(h.read("/state/user")).toBe(next.beszelPassword);
        expect(h.read(`${DIR}/hub.env`)).toContain(`USER_PASSWORD=${next.beszelPassword}\n`);

        // Changed by hand in the dashboard: neither password signs in.
        h.write("/state/hub", "changed-by-hand");
        const third = addonSecrets().secrets;
        const refused = h.run(scripts(true).apply, input(third));
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain(
          "Beszel's hub accepts neither the dashboard password OpsCrew keeps nor the new one",
        );
        expect(h.read(`${DIR}/hub.env`)).toContain(`USER_PASSWORD=${next.beszelPassword}\n`);
        for (const value of Object.values(third)) expect(refused.stderr).not.toContain(value);

        // No hub.env: only the new password is tried, and the hub with another is refused.
        rmSync(h.native(`${DIR}/hub.env`));
        h.write("/state/curl", "");
        expect(h.run(scripts(true).apply, input(third)).status).not.toBe(0);
        expect((h.read("/state/curl") ?? "").split("\n---\n").filter(Boolean)).toHaveLength(1);
        expect(h.exists(`${DIR}/hub.env`)).toBe(false);
        h.write("/state/hub", third.beszelPassword);
        expect(h.run(scripts(true).apply, input(third)).status).toBe(0);
        expect(h.read(`${DIR}/hub.env`)).toContain(`USER_PASSWORD=${third.beszelPassword}\n`);
      } finally {
        h.dispose();
      }
    });

    it("stops before any change when the hub does not run or curl is missing", () => {
      const h = harness();
      try {
        const old = started(h);
        rmSync(h.native("/state/up"));
        const next = addonSecrets().secrets;
        const stopped = h.run(scripts(true).apply, input(next));
        expect(stopped.status).not.toBe(0);
        expect(stopped.stderr).toContain(
          "Beszel's hub does not run on the server, so OpsCrew could not change the password of its dashboard; check docker compose -p opscrew-beszel ps.",
        );
        expect(h.exists("/state/curl")).toBe(false);
        expect(h.read(`${DIR}/hub.env`)).toContain(`USER_PASSWORD=${old.beszelPassword}\n`);
      } finally {
        h.dispose();
      }

      const bare = harness({ curl: false });
      try {
        const old = started(bare);
        // No curl on the script's PATH: the stubs, then the system's tools without curl.
        const system = spawnSync("sh", ["-c", "PATH=/usr/bin:/bin command -v curl"]).status === 0;
        if (system) {
          spawnSync("bash", [
            "-c",
            'mkdir -p "$1/tools"; for f in /usr/bin/* /bin/*; do n=$(basename "$f"); [ "$n" = curl ] || [ -e "$1/tools/$n" ] || ln -s "$f" "$1/tools/$n"; done',
            "_",
            bare.root,
          ]);
        }
        const apply = scripts(true).apply;
        const script = system
          ? apply.replaceAll(SCRIPT_PATH, `PATH=${bare.root}/bin:${bare.root}/tools`)
          : apply;
        const missing = bare.run(script, input(addonSecrets().secrets));
        expect(missing.status).not.toBe(0);
        expect(missing.stderr).toContain(
          "curl is missing on the server, so OpsCrew could not change the password of Beszel's dashboard.",
        );
        expect(bare.read(`${DIR}/hub.env`)).toContain(`USER_PASSWORD=${old.beszelPassword}\n`);
      } finally {
        bare.dispose();
      }
    });
  },
);
