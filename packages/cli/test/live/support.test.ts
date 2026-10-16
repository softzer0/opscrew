/**
 * Offline checks of the live tests' safety and leak helpers (the scrubber and the leak searches,
 * the cleanup's ruleset filter, the firewall and listener checks, the rollback's outcome) and of
 * the Portainer test's step selection. No network.
 */
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GitHubRepo, rulesetOfRun } from "./cloud";
import {
  CORE_STEPS,
  envNames,
  firewallRules,
  isEncryptedPlan,
  logErrors,
  PORTAINER_PORT,
  PORTAINER_STEPS,
  PROXY_PORT,
  portainerSteps,
  rollbackOutcome,
  shortHostMentions,
  stepNumber,
  valueShape,
} from "./portainer-support";
import {
  addressLinesOutsidePurpose,
  ipv6PrefixForms,
  leakedLabels,
  Scrubber,
  ufwRulesBeyondSsh,
  webListenersBeyondIpv4,
} from "./support";

describe("the leak helpers", () => {
  it("masks the server's address and known secrets, also short ones, and names leaks by label", () => {
    const scrubber = new Scrubber();
    scrubber.add("5.6.7.8", "server-ipv4");
    for (const prefix of ipv6PrefixForms("2001:db8:1:2::/64")) scrubber.add(prefix, "server-ipv6");
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXktanVzdC1hLXRlc3Q=\n-----END";
    scrubber.add(key, "test-private-key");
    scrubber.add("", "ignored");
    const text =
      "ssh deploy@5.6.7.8 and [2001:db8:1:2::1]:22, key line bm90LWEtcmVhbC1rZXktanVzdC1hLXRlc3Q=";
    const masked = scrubber.scrub(text);
    expect(masked).not.toContain("5.6.7.8");
    expect(masked).not.toContain("2001:db8:1:2:");
    expect(masked).not.toContain("bm90LWEtcmVhbC1rZXktanVzdC1hLXRlc3Q=");
    expect(masked).toContain("deploy@[server-ipv4]");
    expect(leakedLabels(text, scrubber.entries())).toEqual([
      "server-ipv4",
      "server-ipv6",
      "test-private-key",
    ]);
    expect(leakedLabels("nothing here", scrubber.entries())).toEqual([]);
    expect(leakedLabels("version 15.6.7.80", scrubber.entries())).toEqual([]);
    expect(scrubber.value("server-ipv4")).toBe("5.6.7.8");
  });

  it("allows the server's address only in the tunnel command and 'your server at' messages", () => {
    const addresses = ["5.6.7.8", "2001:db8:1:2::1", "2001:db8:1:2::", "2001:db8:1:2:"];
    const output = [
      'ssh -i "/k/deploy_key" -o UserKnownHostsFile="/k/known_hosts" -N -L 9443:127.0.0.1:9443 deploy@5.6.7.8',
      '  "tunnelCommand": "ssh -i \\"/k\\" -N -L 9443:127.0.0.1:9443 deploy@5.6.7.8",',
      "This is OpsCrew's first connection to your server at 5.6.7.8, and its SSH host key must be confirmed.",
      "OpsCrew could not reach SSH on your server at [2001:db8:1:2::1]:22.",
      "Prepared your server (12 changes applied).",
      "version 15.6.7.80",
    ].join("\n");
    expect(addressLinesOutsidePurpose(output, addresses)).toBe(0);
    const leaked = `${output}\nCreated or updated the server at the address 5.6.7.8.\nssh deploy@5.6.7.8`;
    expect(addressLinesOutsidePurpose(leaked, addresses)).toBe(2);
    // An allowed mention does not excuse another one on the same line.
    expect(addressLinesOutsidePurpose("server at 5.6.7.8, also 5.6.7.8", addresses)).toBe(1);
    expect(addressLinesOutsidePurpose("deploy@5.6.7.8 without a tunnel", addresses)).toBe(1);
    expect(
      addressLinesOutsidePurpose(
        "your server at [2001:db8:1:2::1]:22 in 2001:db8:1:2:0:0:0:9",
        addresses,
      ),
    ).toBe(1);
  });

  it("counts a short host name only where it is a host name", () => {
    const leaks = [
      "Could not reach https://nas:9443 in time.",
      "your Portainer at nas.",
      "connect to //nas/api",
      "host nas answered",
    ];
    for (const text of leaks) expect(shortHostMentions(text, "nas"), text).toBe(1);
    const fine = [
      "opscrew-shop-nas-tunnel",
      "nasal nasty canasta",
      "nas.local",
      "NAS",
      "portainer.url and the NAS",
      "path/to/nas_backup",
    ];
    for (const text of fine) expect(shortHostMentions(text, "nas"), text).toBe(0);
    expect(shortHostMentions("https://portainer:9443/api", "portainer")).toBe(1);
  });

  it("skips only OpenTofu's encrypted plan files", () => {
    const meta = { "key_provider.pbkdf2.opscrew": "eyJ9" };
    expect(isEncryptedPlan(JSON.stringify({ meta, encrypted_data: "+nas/" }))).toBe(true);
    expect(isEncryptedPlan("PK\u0003\u0004 tfplan https://nas:9443")).toBe(false);
    expect(isEncryptedPlan(JSON.stringify({ meta }))).toBe(false);
  });

  it("describes values and a container's variables without any of their contents", () => {
    const secret = fakeSecret("generic-password", "webhook");
    const shape = valueShape({
      DeploymentStatus: [{ Status: 1, Message: "", Time: 1 }],
      AutoUpdate: { Webhook: secret, ForcePullImage: false, Interval: "" },
      GitConfig: null,
    });
    expect(shape).toBe(
      "{ AutoUpdate: { ForcePullImage: boolean, Interval: string, Webhook: string }, DeploymentStatus: 1 × { Message: string, Status: number, Time: number }, GitConfig: null }",
    );
    expect(shape).not.toContain(secret);
    const env = JSON.stringify(["PATH=/bin", `PROBE_SET=${secret}`, "PROBE_EMPTY=", "PROBE_BARE"]);
    const names = envNames(env, "PROBE_");
    expect(names).toEqual([
      { name: "PROBE_BARE", empty: true },
      { name: "PROBE_EMPTY", empty: true },
      { name: "PROBE_SET", empty: false },
    ]);
    expect(JSON.stringify(names)).not.toContain(secret);
  });

  it("reads a job log through its redirect without sending the token to the log's host", async () => {
    const token = fakeSecret("github-token", "e2e");
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("authorization") });
      if (String(url).startsWith("https://api.github.com/")) {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://logs.example.net/job/7?sig=abc" },
        });
      }
      return new Response("2026-10-16T09:12:02.0000001Z ##[error]boom\n", { status: 200 });
    }) as typeof fetch;
    const github = new GitHubRepo(token, "owner/repo");
    const read = await github.redirectedText("/repos/owner/repo/actions/jobs/7/logs", fetchImpl);
    expect(read.status).toBe(200);
    expect(logErrors(read.text)).toEqual(["boom"]);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/owner/repo/actions/jobs/7/logs",
        auth: `Bearer ${token}`,
      },
      { url: "https://logs.example.net/job/7?sig=abc", auth: null },
    ]);
    const denied = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    expect(await github.redirectedText("/x", denied)).toEqual({ status: 403, text: "" });
  });
});

describe("the safety helpers", () => {
  it("treats a zone ruleset as this run's only when it is OpsCrew's and names only the run's hostnames", () => {
    const hostnames = ["e2e.example.com", "www.e2e.example.com", "ssh-shop.example.com"];
    const config = {
      name: "OpsCrew configuration rules",
      kind: "zone",
      phase: "http_config_settings",
      rules: [{ expression: '(http.host in {"e2e.example.com" "www.e2e.example.com"})' }],
    };
    const waf = {
      name: "OpsCrew custom rules",
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [
        {
          expression:
            '(http.host in {"e2e.example.com"}) and (http.request.uri.path contains "/.env" or starts_with(http.request.uri.path, "/.git") or http.request.uri.path contains "/wp-login.php")',
        },
      ],
    };
    expect(rulesetOfRun(config, hostnames)).toBe(true);
    expect(rulesetOfRun(waf, hostnames)).toBe(true);
    expect(
      rulesetOfRun(
        { ...config, rules: [{ expression: 'http.host eq "E2E.example.com"' }] },
        hostnames,
      ),
    ).toBe(true);
    // Another app's hostname, alone or next to the run's, is never this run's.
    expect(
      rulesetOfRun(
        {
          ...config,
          rules: [{ expression: '(http.host in {"e2e.example.com" "shop.example.com"})' }],
        },
        hostnames,
      ),
    ).toBe(false);
    expect(
      rulesetOfRun(
        { ...waf, rules: [...waf.rules, { expression: '(http.host in {"shop.example.com"})' }] },
        hostnames,
      ),
    ).toBe(false);
    // A rule that names no hostname (it applies to the whole zone), no rules, the user's name.
    expect(
      rulesetOfRun(
        { ...waf, rules: [{ expression: 'http.request.uri.path contains "/.env"' }] },
        hostnames,
      ),
    ).toBe(false);
    expect(rulesetOfRun({ ...config, rules: [] }, hostnames)).toBe(false);
    expect(rulesetOfRun({ ...config, rules: undefined }, hostnames)).toBe(false);
    expect(rulesetOfRun({ ...config, name: "My configuration rules" }, hostnames)).toBe(false);
    // Only zone entrypoints of the phases OpsCrew uses.
    expect(rulesetOfRun({ ...config, kind: "managed" }, hostnames)).toBe(false);
    expect(rulesetOfRun({ ...config, phase: "http_request_cache_settings" }, hostnames)).toBe(
      false,
    );
  });

  it("opens Portainer and the proxy port only to the test computer", () => {
    const rules = firewallRules("192.0.2.44");
    expect(rules.find((rule) => rule.port === String(PORTAINER_PORT))?.source_ips).toEqual([
      "192.0.2.44/32",
    ]);
    expect(rules.find((rule) => rule.port === String(PROXY_PORT))?.source_ips).toEqual([
      "192.0.2.44/32",
    ]);
    expect(rules.map((rule) => rule.port)).not.toContain("9000");
    expect(rules.map((rule) => rule.port)).not.toContain("8000");
  });

  it("reads ufw rules beyond SSH", () => {
    const sshOnly = [
      "Status: active",
      "",
      "To                         Action      From",
      "--                         ------      ----",
      "22/tcp                     ALLOW IN    Anywhere                   # opscrew ssh",
      "22/tcp (v6)                ALLOW IN    Anywhere (v6)              # opscrew ssh",
    ].join("\n");
    expect(ufwRulesBeyondSsh(sshOnly)).toEqual({ active: true, rules: 2, others: [] });
    const web = `${sshOnly}\n80/tcp                     ALLOW IN    Anywhere\n443 (v6)                   ALLOW IN    Anywhere (v6)`;
    expect(ufwRulesBeyondSsh(web).others).toHaveLength(2);
    expect(ufwRulesBeyondSsh("Status: inactive").active).toBe(false);
    expect(ufwRulesBeyondSsh(sshOnly.replaceAll("22/tcp", "2222/tcp"), 2222).others).toEqual([]);
  });

  it("finds web listeners on IPv6 or every address in ss output", () => {
    const ss = [
      "tcp   LISTEN 0      4096         0.0.0.0:80        0.0.0.0:*",
      "tcp   LISTEN 0      4096         0.0.0.0:443       0.0.0.0:*",
      "udp   UNCONN 0      0            0.0.0.0:443       0.0.0.0:*",
      "tcp   LISTEN 0      4096            [::]:22           [::]:*",
      "tcp   LISTEN 0      4096       127.0.0.1:9443      0.0.0.0:*",
    ].join("\n");
    expect(webListenersBeyondIpv4(ss)).toEqual([]);
    const open = `${ss}\ntcp   LISTEN 0      4096            [::]:443          [::]:*\ntcp   LISTEN 0 511 *:80 *:*`;
    expect(webListenersBeyondIpv4(open)).toEqual(["[::]:443", "*:80"]);
  });

  it("reads the rollback's outcome from the error lines of the failed job's log", () => {
    const branch = "opscrew-deploy";
    const exit = "Process completed with exit code 1.";
    const wrote = `The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch, and Portainer's updater deploys it within about a minute.`;
    const log = [
      '\uFEFF2026-10-16T09:12:01.1234567Z ##[group]Run echo "::error::The deploy failed; ..."',
      `2026-10-16T09:12:01.1234568Z echo "::error::${wrote}"`,
      "2026-10-16T09:12:01.1234569Z ##[endgroup]",
      `2026-10-16T09:12:02.0000001Z ##[error]${wrote}\r`,
      "2026-10-16T09:12:02.0000002Z PORTAINER_TOKEN: ***",
      `2026-10-16T09:12:03.0000003Z ##[error]${exit}`,
      "##[error]An error line without a timestamp",
      "",
    ].join("\n");
    expect(logErrors(log)).toEqual([wrote, exit, "An error line without a timestamp"]);
    expect(rollbackOutcome(logErrors(log))).toEqual({ ok: true, message: wrote });
    expect(rollbackOutcome([exit, wrote])).toEqual({ ok: true, message: wrote });
    for (const message of [
      `The deploy failed and OpsCrew could not write the previous version back to the ${branch} branch. Write it back by hand.`,
      `The deploy failed and the ${branch} branch had no earlier version to restore. Fix the problem and push again.`,
      `The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch, but Portainer did not confirm the redeploy (HTTP 500). Redeploy the stack in Portainer.`,
    ]) {
      const outcome = rollbackOutcome([exit, message]);
      expect(outcome.ok, message).toBe(false);
      expect(outcome.message).toContain(message);
    }
    expect(rollbackOutcome([exit]).ok).toBe(false);
    expect(rollbackOutcome([]).message).toContain("no error lines");
  });
});

describe("OPSCREW_E2E_PORTAINER_STEPS", () => {
  const all = PORTAINER_STEPS.map((step) => step.id);

  it("takes the core pass by default and every step in the full pass", () => {
    for (const value of [undefined, "", " ", "core", "CORE"]) {
      expect(portainerSteps(value), String(value)).toEqual([...CORE_STEPS]);
    }
    expect(CORE_STEPS).toEqual(["1", "1b", "2a", "2", "3", "8", "9", "12"]);
    expect(portainerSteps("full")).toEqual(all);
    expect(all).toEqual([
      "1",
      "1b",
      "2a",
      "2",
      "3",
      "3b",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
    ]);
  });

  it("reruns the short host step on a fresh setup: the server, the prepared project, 11 and 12", () => {
    expect(portainerSteps("11,12")).toEqual(["1", "1b", "2a", "11", "12"]);
    expect(portainerSteps(" 11 , 12 ")).toEqual(["1", "1b", "2a", "11", "12"]);
    // The leak search always runs.
    expect(portainerSteps("11")).toEqual(["1", "1b", "2a", "11", "12"]);
  });

  it("adds what each chosen step needs", () => {
    expect(portainerSteps("3b")).toEqual(["1", "1b", "2a", "2", "3b", "12"]);
    expect(portainerSteps("9")).toEqual(["1", "1b", "2a", "2", "8", "9", "12"]);
    expect(portainerSteps("5,6")).toEqual(["1", "1b", "2a", "2", "5", "6", "12"]);
    expect(portainerSteps("10")).toEqual(["1", "1b", "2a", "10", "12"]);
  });

  it("empties OpsCrew's record before a fresh setup when step 2 set the app up", () => {
    expect(portainerSteps("2,10")).toEqual(["1", "1b", "2a", "2", "8", "9", "10", "12"]);
    expect(portainerSteps("4,11")).toEqual(["1", "1b", "2a", "2", "4", "8", "9", "11", "12"]);
  });

  it("names a need only on an earlier step", () => {
    for (const [index, step] of PORTAINER_STEPS.entries()) {
      for (const need of step.needs)
        expect(all.indexOf(need), `${step.id} needs ${need}`).toBeLessThan(index);
    }
  });

  it("finds each step by the number its title starts with", () => {
    expect(stepNumber("2a. prepares the project")).toBe("2a");
    expect(stepNumber("3b. a failing change rolls back")).toBe("3b");
    expect(stepNumber("12. no token")).toBe("12");
    expect(stepNumber("no number")).toBe("");
  });

  it("refuses an unknown step", () => {
    for (const value of ["all", "13", "2b", "11,x", "11,"]) {
      expect(portainerSteps(value), value).toBeUndefined();
    }
  });
});
