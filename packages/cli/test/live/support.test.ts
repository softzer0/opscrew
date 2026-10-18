/**
 * Offline checks of the live tests' safety and leak helpers (the scrubber and the leak searches,
 * OpsCrew's shared Cloudflare rules and the cleanup's leftover decision, the firewall and listener
 * checks, the rollback's outcome) and of the Portainer test's step selection. No network.
 */
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GitHubRepo } from "./cloud";
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
  requiredLeakLabels,
  rollbackOutcome,
  shortHostMentions,
  stepNumber,
  valueShape,
} from "./portainer-support";
import {
  addressLinesOutsidePurpose,
  appRules,
  blockedByCloudflare,
  cloudflareRecordProblems,
  deployJobFailed,
  expectedSharedHosts,
  ipv6PrefixForms,
  leakedLabels,
  rulesCleanup,
  runHostname,
  Scrubber,
  seededDescription,
  sharedRuleHosts,
  ufwRulesBeyondSsh,
  userRules,
  webListenersBeyondIpv4,
  type ZoneRule,
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

describe("OpsCrew's shared Cloudflare rules in the zone (feature 011)", () => {
  const quoted = (hosts: readonly string[]) => hosts.map((host) => `"${host}"`).join(" ");
  const block = (hosts: readonly string[]): ZoneRule => ({
    id: "rule-block",
    ref: "opscrew-block-probes",
    description: "OpsCrew: block probes for secrets and admin panels",
    expression: `(http.host in {${quoted(hosts)}}) and (http.request.uri.path contains "/.env" or starts_with(http.request.uri.path, "/.git"))`,
    action: "block",
    enabled: true,
  });
  const tls = (hosts: readonly string[]): ZoneRule => ({
    id: "rule-tls",
    ref: "opscrew-strict-tls",
    description: "OpsCrew: verify the origin certificate (Full (strict) TLS)",
    expression: `(http.host in {${quoted(hosts)}})`,
    action: "set_config",
    action_parameters: { ssl: "strict" },
    enabled: true,
  });
  const mine: ZoneRule = {
    id: "user-1",
    ref: "user-1",
    description: "My own rule",
    expression: '(http.host in {"shop.example.com" "e2e-abc.example.com"})',
    action: "block",
    enabled: true,
  };
  const seeded: ZoneRule = {
    id: "user-2",
    ref: "user-2",
    description: seededDescription("abc"),
    expression: '(http.host eq "opscrew-e2e-seeded.e2e-abc.example.com")',
    action: "set_config",
    action_parameters: { automatic_https_rewrites: true },
    enabled: true,
  };
  const zone = (custom: ZoneRule[] | undefined, config: ZoneRule[] | undefined) => ({
    http_request_firewall_custom: custom && { id: "ruleset-custom", rules: custom },
    http_config_settings: config && { id: "ruleset-config", rules: config },
  });

  it("reads the hostnames of OpsCrew's rules by ref, never of the user's rules", () => {
    const now = zone([mine, block(["E2E-abc.example.com", "a.example.com"])], [seeded]);
    expect(sharedRuleHosts(now)).toEqual({
      "opscrew-block-probes": ["a.example.com", "e2e-abc.example.com"],
      "opscrew-strict-tls": undefined,
    });
    expect(sharedRuleHosts(zone(undefined, [tls(["a.example.com"])]))).toEqual({
      "opscrew-block-probes": undefined,
      "opscrew-strict-tls": ["a.example.com"],
    });
    // Only OpsCrew's `http.host in {…}` form lists hostnames.
    const single = { ...tls([]), expression: '(http.host eq "a.example.com")' };
    expect(sharedRuleHosts(zone(undefined, [single]))["opscrew-strict-tls"]).toEqual([]);
  });

  it("compares the rules OpsCrew did not create byte for byte and in their order", () => {
    const before = userRules(zone([mine], [seeded]));
    expect(before.http_request_firewall_custom).toHaveLength(1);
    expect(before.http_config_settings).toHaveLength(1);
    // OpsCrew's own rules and what Cloudflare changes on its own (versions, times) do not count.
    const withOpsCrew = zone(
      [
        { ...mine, version: "2" },
        { ...block(["e2e-abc.example.com"]), version: "3" },
      ],
      [{ ...seeded, last_updated: "2026-10-17T10:00:00Z" }, tls(["x.example.com"])],
    );
    expect(userRules(withOpsCrew)).toEqual(before);
    // Every other field of the whole rule, and the order, count.
    const other = { ...mine, id: "user-3", ref: "user-3" };
    const changed = [
      zone([{ ...mine, enabled: false }], [seeded]),
      zone([{ ...mine, expression: '(http.host eq "shop.example.com")' }], [seeded]),
      zone([mine], [{ ...seeded, action_parameters: { automatic_https_rewrites: false } }]),
      zone([{ ...mine, ref: "my-ref" }], [seeded]),
      zone([{ ...mine, description: "My rule" }], [seeded]),
      zone([{ ...mine, logging: { enabled: false } } as ZoneRule], [seeded]),
      zone([mine], undefined),
    ];
    for (const entrypoints of changed) expect(userRules(entrypoints)).not.toEqual(before);
    expect(userRules(zone([mine, other], [seeded]))).not.toEqual(
      userRules(zone([other, mine], [seeded])),
    );
  });

  it("expects OpsCrew's rules to list what they listed before the run plus each live app's hostnames", () => {
    const before = {
      "opscrew-block-probes": ["shop.example.com"],
      "opscrew-strict-tls": undefined,
    };
    const a = { "opscrew-block-probes": ["e2e-abc.example.com"] };
    const b = { "opscrew-block-probes": ["e2e-abc-b.example.com"] };
    expect(expectedSharedHosts(before, [a, b])).toEqual({
      "opscrew-block-probes": ["e2e-abc-b.example.com", "e2e-abc.example.com", "shop.example.com"],
      "opscrew-strict-tls": undefined,
    });
    // After the last destroy: as before the run, so a rule is gone only when it listed nothing.
    expect(expectedSharedHosts(before, [{}, {}])).toEqual(before);
    expect(
      expectedSharedHosts({ "opscrew-block-probes": undefined, "opscrew-strict-tls": undefined }, [
        {
          "opscrew-block-probes": ["E2E-abc.example.com"],
          "opscrew-strict-tls": ["e2e-abc.example.com"],
        },
      ]),
    ).toEqual({
      "opscrew-block-probes": ["e2e-abc.example.com"],
      "opscrew-strict-tls": ["e2e-abc.example.com"],
    });
  });

  it("puts an app's hostnames into the rules the guide names for its target", () => {
    const dns = { provider: "cloudflare", domain: "e2e-abc.example.com", www: false };
    const both = {
      "opscrew-block-probes": ["e2e-abc.example.com"],
      "opscrew-strict-tls": ["e2e-abc.example.com"],
    };
    const blockOnly = { "opscrew-block-probes": ["e2e-abc.example.com"] };
    expect(appRules({ target: { provider: "hetzner" }, dns })).toEqual(both);
    expect(appRules({ target: { provider: "own", access: "public" }, dns })).toEqual(both);
    expect(appRules({ target: { provider: "own", access: "tunnel" }, dns })).toEqual(blockOnly);
    expect(appRules({ target: { provider: "portainer", web: { mode: "tunnel" } }, dns })).toEqual(
      blockOnly,
    );
    for (const mode of ["caddy", "proxy"]) {
      expect(appRules({ target: { provider: "portainer", web: { mode } }, dns })).toEqual({});
    }
    expect(
      appRules({
        target: { provider: "hetzner" },
        dns: { ...dns, domain: "example.com", www: true },
      }),
    ).toEqual({
      "opscrew-block-probes": ["example.com", "www.example.com"],
      "opscrew-strict-tls": ["example.com", "www.example.com"],
    });
    expect(
      appRules({ target: { provider: "hetzner" }, dns: { provider: "none", www: false } }),
    ).toEqual({});
  });

  it("cleans up only what the run left: its seeded rules and OpsCrew's rules holding only its hostnames", () => {
    const run = {
      hostnames: ["e2e-abc.example.com", "e2e-abc-b.example.com"],
      seeded: seededDescription("abc"),
      createdByRun: false,
    };
    const left = rulesCleanup([mine, seeded, block(["e2e-abc.example.com"])], run);
    expect(left.deletes.map((item) => item.id)).toEqual(["user-2", "rule-block"]);
    expect(left.problems).toEqual([]);
    expect(left.deleteEntrypoint).toBe(false);
    // Next to another app's hostname the run's is reported, and the rule stays.
    const mixed = rulesCleanup([block(["E2E-abc-b.example.com", "shop.example.com"])], run);
    expect(mixed.deletes).toEqual([]);
    expect(mixed.problems).toHaveLength(1);
    expect(mixed.problems[0]).toContain("e2e-abc-b.example.com");
    expect(mixed.problems[0]).not.toContain("shop.example.com");
    // Another app's rule, a rule of another run, the user's own rules: never touched.
    const others = rulesCleanup(
      [mine, tls(["shop.example.com"]), { ...seeded, description: seededDescription("other") }],
      run,
    );
    expect(others).toEqual({ deletes: [], problems: [], deleteEntrypoint: false });
    // An entrypoint the run created goes once nothing else is left in it.
    expect(
      rulesCleanup([seeded, tls(["e2e-abc.example.com"])], { ...run, createdByRun: true })
        .deleteEntrypoint,
    ).toBe(true);
    expect(rulesCleanup([], { ...run, createdByRun: true }).deleteEntrypoint).toBe(true);
    expect(rulesCleanup([mine, seeded], { ...run, createdByRun: true }).deleteEntrypoint).toBe(
      false,
    );
    expect(rulesCleanup([seeded], { ...run, createdByRun: false }).deleteEntrypoint).toBe(false);
    // A run that seeded nothing (the Hetzner pass) deletes no user rule.
    const unseeded = { hostnames: run.hostnames, createdByRun: false };
    expect(rulesCleanup([seeded, block(["e2e-abc.example.com"])], unseeded).deletes).toEqual([
      expect.objectContaining({ id: "rule-block" }),
    ]);
  });

  it("recognises Cloudflare's block page", () => {
    const page =
      "<title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1>";
    const ray = { "cf-ray": "8d1f0c0a1b2c3d4e-FRA", server: "cloudflare" };
    expect(blockedByCloudflare({ status: 403, headers: ray, body: page })).toBe(true);
    for (const body of [
      "<title>Access denied | e2e-abc.example.com used Cloudflare to restrict access</title>",
      "<span>Error code: 1020</span>",
      "error code 1020",
    ]) {
      expect(blockedByCloudflare({ status: 403, headers: ray, body }), body).toBe(true);
    }
    expect(blockedByCloudflare({ status: 404, headers: ray, body: "Not Found" })).toBe(false);
    expect(blockedByCloudflare({ status: 403, headers: ray, body: "Forbidden" })).toBe(false);
    expect(blockedByCloudflare({ status: 403, headers: {}, body: page })).toBe(false);
    expect(blockedByCloudflare({ status: 200, headers: ray, body: "ok" })).toBe(false);
  });

  it("allows only hostnames and ids in .opscrew/cloudflare.json", () => {
    const token = fakeSecret("cloudflare-token", "record");
    const known = [{ label: "cloudflare-token", value: token }];
    const record = {
      zoneId: "0123456789abcdef0123456789abcdef",
      hostnames: { "opscrew-block-probes": ["e2e-abc.example.com"] },
      createdEntrypoints: ["http_request_firewall_custom"],
    };
    expect(cloudflareRecordProblems(JSON.stringify(record), known)).toEqual([]);
    const leaked = cloudflareRecordProblems(JSON.stringify({ ...record, token }), known);
    expect(leaked).toHaveLength(2);
    expect(leaked.join("\n")).toContain("cloudflare-token");
    expect(leaked.join("\n")).not.toContain(token);
    expect(cloudflareRecordProblems("{ not json", known)).toHaveLength(1);
  });

  it("gives the second app its own hostname directly below the zone", () => {
    expect(runHostname("e2e.example.com", "abc")).toBe("e2e-abc.example.com");
    expect(runHostname("e2e.example.com", "abc", "b")).toBe("e2e-abc-b.example.com");
    expect(runHostname("example.com", "ABC-1", "b")).toBe("e2e-abc1-b.example.com");
  });
});

describe("the safety helpers", () => {
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
    expect(CORE_STEPS).toEqual(["1", "1b", "2a", "2", "3", "7b", "8", "9", "9b", "12"]);
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
      "7b",
      "8",
      "9",
      "9b",
      "10",
      "11",
      "12",
    ]);
  });

  it("destroys the second app after the first one whenever it is set up", () => {
    for (const value of ["7b", "9b", "7b,9b"]) {
      expect(portainerSteps(value), value).toEqual(["1", "1b", "2a", "2", "7b", "8", "9b", "12"]);
    }
    expect(portainerSteps("7,7b")).toEqual(["1", "1b", "2a", "2", "7", "7b", "8", "9b", "12"]);
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

  it("requires the webhook id in the leak search only after a step that set the app up", () => {
    const tokens = ["PORTAINER_API_KEY", "OPSCREW_GHCR_READ_TOKEN"];
    for (const value of ["11,12", "core", "full", "10", "3b"]) {
      expect(requiredLeakLabels(portainerSteps(value) ?? [], false), value).toEqual([
        ...tokens,
        "portainer-webhook",
      ]);
    }
    for (const value of ["2a", "1", "12", "1b"]) {
      expect(requiredLeakLabels(portainerSteps(value) ?? [], false), value).toEqual(tokens);
    }
    expect(requiredLeakLabels(portainerSteps("11,12") ?? [], true)).toEqual([
      ...tokens,
      "portainer-webhook",
      "OPSCREW_REPO_READ_TOKEN",
    ]);
  });

  it("refuses an unknown step", () => {
    for (const value of ["all", "13", "2b", "8b", "11,x", "11,"]) {
      expect(portainerSteps(value), value).toBeUndefined();
    }
  });
});

describe("deployJobFailed", () => {
  const ok = { conclusion: "success" };
  it("judges a finished job by its conclusion", () => {
    expect(deployJobFailed({ name: "deploy", conclusion: "success", steps: [] }, "success")).toBe(
      false,
    );
    expect(deployJobFailed({ name: "deploy", conclusion: "skipped", steps: [ok] }, "success")).toBe(
      true,
    );
    expect(deployJobFailed({ name: "deploy", conclusion: "failure", steps: [ok] }, "failure")).toBe(
      true,
    );
  });

  it("takes a job GitHub still lists as running from its steps, only when the run succeeded", () => {
    const steps = [ok, { conclusion: "skipped" }, ok];
    expect(deployJobFailed({ name: "deploy", conclusion: null, steps }, "success")).toBe(false);
    expect(deployJobFailed({ name: "deploy", conclusion: null, steps }, "failure")).toBe(true);
    expect(deployJobFailed({ name: "deploy", conclusion: null, steps: [] }, "success")).toBe(true);
    expect(
      deployJobFailed(
        { name: "deploy", conclusion: null, steps: [ok, { conclusion: null }] },
        "success",
      ),
    ).toBe(true);
  });
});
