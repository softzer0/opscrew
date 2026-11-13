/**
 * The helpers of the hosting account live passes (`cpanel-support.ts`), offline: the pure ones, and
 * the cleanup on a fake cPanel account.
 */
import { type FakeCpanel, fakeCpanel } from "@opscrew/connector-cpanel";
import type { FetchLike } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import {
  type AccountInventory,
  accountMasks,
  appRootSuffixes,
  CpanelAccount,
  envNames,
  hostingAnswers,
  hostingRunProblem,
  inventoryProblems,
  legNames,
  namesRun,
  otherRunsObjects,
  PANEL_DEPLOY_JOB,
  panelUrl,
  runCertificates,
  runTag,
  SFTP_DEPLOY_JOB,
  type SwitchSample,
  selectorEnvNames,
  selectorRestore,
  switchVerdict,
  watchSwitch,
} from "./cpanel-support";

describe("the panel's access", () => {
  it("takes the address with https:// and port 2083 unless given", () => {
    expect(panelUrl("panel.example.com")).toBe("https://panel.example.com:2083");
    expect(panelUrl("https://panel.example.com/")).toBe("https://panel.example.com:2083");
    expect(panelUrl("https://panel.example.com:2087")).toBe("https://panel.example.com:2087");
    expect(() => panelUrl("http://panel.example.com")).toThrow("https://");
  });

  it("masks the user, the panel's host and the domains, also as certificate ids write them", () => {
    const masks = accountMasks({ url: "https://panel.example.com:2083", user: "acct" }, [
      "Example.org",
    ]);
    expect(masks).toEqual(
      expect.arrayContaining([
        { value: "panel.example.com", label: "account-panel-host" },
        { value: "panel_example_com", label: "account-panel-host" },
        { value: "acct", label: "account-user" },
        { value: "example.org", label: "account-domain" },
        { value: "example_org", label: "account-domain" },
      ]),
    );
  });

  it("masks the database prefix, which holds the user's first characters, as the user", () => {
    const access = { url: "https://panel.example.com:2083", user: "johnsmithers" };
    expect(accountMasks(access, [], "johnsmit_")).toContainEqual({
      value: "johnsmit",
      label: "account-user",
    });
    // Without the panel's answer, cPanel's own cut: the user's first 8 characters.
    expect(accountMasks(access, [])).toContainEqual({ value: "johnsmit", label: "account-user" });
  });
});

describe("the run's names", () => {
  it("takes a short tag and names each leg's app and hostname after it", () => {
    expect(runTag("mh2x9a1bc0ffee12")).toBe("ffee12");
    expect(legNames("ffee12", "php", "Example.org.")).toEqual({
      app: "e2e-ffee12-php",
      hostname: "e2e-ffee12-php.example.org",
    });
  });

  it("finds the run's objects as cPanel writes their names", () => {
    expect(namesRun("acct_e2e_ffee12_php", "ffee12")).toBe(true);
    expect(namesRun("E2E_FFEE12_PHP_EXAMPLE_ORG_abc", "ffee12")).toBe(true);
    expect(namesRun("e2e-ffee12-php.example.org", "ffee12")).toBe(true);
    expect(namesRun("e2e-aaaaaa-php.example.org", "ffee12")).toBe(false);
  });

  it("answers the interview for a hosting account at the hostname, DNS outside Cloudflare", () => {
    expect(hostingAnswers("e2e-ffee12-php.example.org", { "hosting.port": 22 })).toMatchObject({
      provider: "hosting",
      dnsProvider: "other",
      domain: "e2e-ffee12-php.example.org",
      "hosting.hostname": "e2e-ffee12-php.example.org",
      "hosting.port": 22,
    });
  });
});

describe("a hosting deploy run", () => {
  const job = (name: string, conclusion: string | null) => ({ name, conclusion, steps: [] });

  it("deployed when it succeeded with its wait job", () => {
    const run = {
      conclusion: "success",
      jobs: [
        job("Build the release", "success"),
        job("Wait for app.example.org to serve the release", "success"),
      ],
    };
    expect(hostingRunProblem(run, PANEL_DEPLOY_JOB)).toBeUndefined();
  });

  it("did not deploy without the job, or when the run failed", () => {
    expect(
      hostingRunProblem(
        { conclusion: "success", jobs: [job("Build", "success")] },
        PANEL_DEPLOY_JOB,
      ),
    ).toContain("has no job matching");
    const failed = {
      conclusion: "failure",
      jobs: [job("Upload the release over SFTP and switch app.example.org to it", "failure")],
    };
    expect(hostingRunProblem(failed, SFTP_DEPLOY_JOB)).toContain("it ended failure");
  });
});

describe("the answers around a switch (SC-2703)", () => {
  const sample = (at: number, release: string | undefined, page: SwitchSample["page"]) => ({
    at,
    ...(release === undefined ? {} : { release, status: 200 }),
    page,
  });

  it("passes when every answer from the first new one on is the new release's", () => {
    const verdict = switchVerdict(
      [sample(0, "1-1", "old"), sample(1000, "2-1", "new"), sample(2000, "2-1", "new")],
      "1-1",
    );
    expect(verdict).toEqual({
      switchedAt: 1000,
      release: "2-1",
      after: 2,
      others: 0,
      problems: [],
    });
  });

  it("finds the old release or its page after the switch, and counts errors apart", () => {
    const verdict = switchVerdict(
      [
        sample(0, "1-1", "old"),
        sample(1000, "2-1", "old"),
        sample(2000, "1-1", "new"),
        sample(3000, undefined, "other"),
      ],
      "1-1",
    );
    expect(verdict.problems).toEqual([
      "an answer 0 s after the first answer of 2-1 showed the old release's page",
      "an answer 1 s after the first answer of 2-1 named the old release 1-1",
    ]);
    expect(verdict.others).toBe(1);
  });

  it("counts only the answers from `from` on, and sees no switch without another release", () => {
    expect(
      switchVerdict([sample(0, "2-1", "old"), sample(5000, "2-1", "new")], "1-1", 4000).problems,
    ).toEqual([]);
    expect(switchVerdict([sample(0, "1-1", "old")], "1-1")).toEqual({
      after: 0,
      others: 0,
      problems: [],
    });
  });

  it("watches while the switch runs and for the settle time after the first new answer", async () => {
    let clock = 0;
    const answers = ["1-1", "1-1", "2-1", "2-1", "2-1", "2-1"];
    const watched = await watchSwitch({
      url: "https://app.example.org/marker",
      oldRelease: "1-1",
      pages: { isNew: (_s, body) => body === "two", isOld: (_s, body) => body === "one" },
      // The switch takes 2.5 s of the fake clock, which the watch's sleeps move on.
      during: async () => {
        while (clock < 2_500) await new Promise((resolve) => setImmediate(resolve));
      },
      request: async () => {
        const release = answers.shift() ?? "2-1";
        return {
          status: 200,
          headers: { "x-opscrew-release": release },
          body: release === "1-1" ? "one" : "two",
        };
      },
      settleMs: 2_000,
      intervalMs: 1_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    expect(watched.map((s) => s.page)).toEqual(["old", "old", "new", "new", "new"]);
    expect(switchVerdict(watched, "1-1").problems).toEqual([]);
  });

  it("stops watching when the switch fails", async () => {
    await expect(
      watchSwitch({
        url: "https://app.example.org/",
        oldRelease: "1-1",
        pages: { isNew: () => false, isOld: () => true },
        during: async () => {
          throw new Error("the deploy failed");
        },
        request: async () => ({ status: 200, headers: {}, body: "" }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("the deploy failed");
  });
});

describe("the account's inventory (SC-2702)", () => {
  const before = {
    home: ["opscrew|dir", "public_html|dir"],
    databases: ["acct_shop|acct_shop"],
    cron: [],
  };

  it("finds nothing when only the run's objects came and went", () => {
    expect(inventoryProblems(before, structuredClone(before), "ffee12")).toEqual({
      problems: [],
      observed: [],
    });
  });

  it("names what the run left, what else changed, and the traces apart", () => {
    const after = {
      home: ["opscrew|dir", ".lsphp_restart.txt|file"],
      databases: ["acct_shop|acct_shop", "acct_e2e_ffee12_php|acct_e2e_ffee12_php"],
      cron: ["* * * * * echo other"],
    };
    expect(inventoryProblems(before, after, "ffee12")).toEqual({
      problems: [
        "cron: * * * * * echo other appeared",
        "databases: the run's acct_e2e_ffee12_php|acct_e2e_ffee12_php is left",
        "home: public_html|dir is gone",
      ],
      observed: ["the home folder has .lsphp_restart.txt now, which it had not before"],
    });
  });

  it("observes an earlier run's entry that cPanel lists again or no longer (R10)", () => {
    const earlier = { ...before, databases: ["acct_e2e_8ec540_php|"] };
    const after = { ...before, databases: ["acct_e2e_0b18fd_php|"] };
    expect(inventoryProblems(earlier, after, "ffee12")).toEqual({
      problems: [],
      observed: [
        "databases: an earlier run's acct_e2e_0b18fd_php| is listed again (R10)",
        "databases: an earlier run's acct_e2e_8ec540_php| is no longer listed (R10)",
      ],
    });
  });

  const certificate = (id: string, domains: string[], publicKey: string) => ({
    id,
    domains,
    publicKey,
  });

  it("removes only the run's new, uninstalled certificates and the keys only they use", () => {
    const old = certificate("example_org_aa", ["example.org"], "k-old");
    const before: Pick<AccountInventory, "certificates" | "keys"> = {
      certificates: [old],
      keys: [{ id: "key-old", publicKey: "k-old" }],
    };
    const mine = certificate("e2e_ffee12_php_example_org_bb", ["e2e-ffee12-php.example.org"], "k1");
    const www = certificate(
      "www_e2e_ffee12_php_example_org_cc",
      ["www.e2e-ffee12-php.example.org"],
      "k2",
    );
    const shared = certificate(
      "e2e_ffee12_site_example_org_dd",
      ["e2e-ffee12-site.example.org"],
      "k3",
    );
    const other = certificate("other_example_org_ee", ["other.example.org"], "k3");
    const installed = certificate(
      "e2e_ffee12_node_example_org_ff",
      ["e2e-ffee12-node.example.org"],
      "k4",
    );
    const now = {
      certificates: [old, mine, www, shared, other, installed],
      keys: [
        { id: "key-old", publicKey: "k-old" },
        { id: "key-1", publicKey: "k1" },
        { id: "key-2", publicKey: "k2" },
        { id: "key-3", publicKey: "k3" },
        { id: "key-4", publicKey: "k4" },
      ],
      installed: [{ servername: "e2e-ffee12-node.example.org", certificate: installed.id }],
    };
    expect(runCertificates({ now, before, tag: "ffee12" })).toEqual({
      certificates: [mine.id, www.id, shared.id],
      keys: ["key-1", "key-2"],
      installed: [installed.id],
    });
  });
});

describe("other runs' objects", () => {
  it("names the e2e objects of other tags, never this run's or the account's own", () => {
    expect(
      otherRunsObjects(
        {
          databases: ["acct_e2e_aaaaaa_php|", "acct_e2e_ffee12_php|", "acct_shop|"],
          home: ["e2e-notes|dir"],
        },
        "ffee12",
      ),
    ).toEqual(["databases: acct_e2e_aaaaaa_php|"]);
  });
});

describe("the selector's files", () => {
  it("puts a file back only when one block naming the run was added to it", () => {
    const before = "a\nb\n";
    expect(
      selectorRestore(
        before,
        "a\nPassengerAppRoot /home/x/opscrew/e2e-ffee12-node-prod\nb\n",
        "ffee12",
      ),
    ).toBe(before);
    expect(selectorRestore(before, "a\nchanged\n", "ffee12")).toBeUndefined();
    expect(selectorRestore(before, "a\nb\nother app\n", "ffee12")).toBeUndefined();
    expect(selectorRestore(undefined, "e2e-ffee12", "ffee12")).toBeUndefined();
    expect(selectorRestore(before, before, "ffee12")).toBeUndefined();
    // The run's block plus a line of someone else's elsewhere: left for a fix by hand.
    expect(
      selectorRestore(before, "a\n# e2e-ffee12-node\nPassengerAppRoot x\nb\nforeign\n", "ffee12"),
    ).toBeUndefined();
  });

  it("shows where the selector placed the app's root, and the names of its variables", () => {
    const text =
      '{"/home/u/opscrew/e2e-ffee12-node-prod/current": {"app_root": "opscrew/e2e-ffee12-node-prod/current", "env_vars": {"PORT": "1", "SECRET": "x"}}}';
    expect(appRootSuffixes(text, "opscrew/e2e-ffee12-node-prod")).toEqual(["/current"]);
    expect(
      appRootSuffixes("opscrew/e2e-ffee12-node-prod/releases/12-1", "opscrew/e2e-ffee12-node-prod"),
    ).toEqual(["/releases/12-1"]);
    expect(selectorEnvNames(text, "ffee12")).toEqual(["PORT", "SECRET"]);
    expect(selectorEnvNames("not json", "ffee12")).toEqual([]);
    // Never the variables of the account's own apps.
    const theirs =
      '{"/home/u/shop": {"app_root": "shop", "env_vars": {"SHOP_KEY": "x"}}, "/home/u/opscrew/e2e-ffee12-node-prod/current": {"env_vars": {"PORT": "1"}}}';
    expect(selectorEnvNames(theirs, "ffee12")).toEqual(["PORT"]);
    expect(
      envNames(
        '# BEGIN\nSetEnv DB_HOST "localhost"\n  PassengerEnvVar PORT 3000\nHeader set X 1\n',
      ),
    ).toEqual(["DB_HOST", "PORT"]);
  });
});

describe("the cleanup on the account", () => {
  const user = "acct";
  const token = "T".repeat(32);
  const tag = "ffee12";
  const home = `/home/${user}`;

  /**
   * The fake account's fetch, with what the fake doesn't answer: SSH keys, API tokens and the
   * zone's records, `list_files`' `nicemode` from the fake's own modes, and the home folder asked
   * as "." (as the live account takes it) passed on by its path.
   */
  function withRest(fake: FakeCpanel): FetchLike {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    return async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/execute/Tokens/list") {
        return json({ result: { status: 1, data: [{ name: "founder" }], errors: null } });
      }
      if (url.pathname === "/execute/DNS/parse_zone") {
        const record = (name: string, type: string) => ({
          type: "record",
          record_type: type,
          dname_b64: Buffer.from(name).toString("base64"),
        });
        const data = [record("example.com.", "SOA"), record("example.com.", "A")];
        return json({ result: { status: 1, data, errors: null } });
      }
      if (typeof init?.body === "string" && init.body.includes("cpanel_jsonapi_module=SSH")) {
        return json({ cpanelresult: { data: [], event: { result: 1 } } });
      }
      if (url.pathname === "/execute/Fileman/list_files" && url.searchParams.get("dir") === ".") {
        url.searchParams.set("dir", home);
      }
      const answer = await fake.fetch(url.toString(), init);
      if (url.pathname !== "/execute/Fileman/list_files") return answer;
      const body = (await answer.json()) as {
        result: { data: { fullpath: string; nicemode?: string }[] | null };
      };
      for (const item of body.result.data ?? []) {
        const entry = fake.state.files.get(item.fullpath.slice(home.length + 1));
        if (entry?.kind === "file") item.nicemode = `0${entry.mode.toString(8)}`;
      }
      return json(body);
    };
  }

  it("removes only the run's objects and AutoSSL's certificates of its hostnames", async () => {
    const fake = fakeCpanel({ user, token, mainDomain: "example.com" });
    const account = new CpanelAccount(
      { url: "https://panel.example.com:2083", user, token },
      "example.com",
      withRest(fake),
    );
    const { panel } = account;
    // The founder's own: a parked domain, a subdomain, a database, a cron line, an earlier app in
    // ~/opscrew and ~/nodevenv/opscrew, and the selector's files.
    fake.state.domains.push({ name: "parked.example.org", kind: "parked" });
    await panel.addHostname("blog.example.com", "blog");
    await panel.addDatabase({ name: "acct_shop", user: "acct_shop", password: "p".repeat(16) });
    await panel.addCron({ schedule: "0 * * * *", command: "php ~/blog/cron.php" });
    fake.writeText("opscrew/other-prod/agent.sh", "#!/bin/bash\n");
    fake.writeText("nodevenv/opscrew/other-prod/current/24/bin/node", "");
    fake.writeText(".cl.selector/htaccess_cache", "a\nb\n", 0o600);
    fake.writeText(".cl.selector/selector.json", "{}\n");
    const before = await account.inventory();
    expect(before.fields.domains).toEqual([
      "main_domain|example.com|/home/acct/public_html",
      "parked_domain|parked.example.org|",
      "sub_domain|blog.example.com|/home/acct/blog",
    ]);
    expect(before.fields.zone).toEqual(["example.com.|A"]);
    expect(before.fields.opscrewFolder).toEqual(["other-prod|dir"]);

    // What the run made.
    const app = "opscrew/e2e-ffee12-php-prod";
    await panel.addHostname("e2e-ffee12-php.example.com", `${app}/current/public`);
    await panel.removeHostname("e2e-ffee12-php.example.com");
    await panel.addHostname("e2e-ffee12-site.example.com", "opscrew/e2e-ffee12-site-prod/current");
    await panel.addDatabase({
      name: "acct_e2e_ffee12_php",
      user: "acct_e2e_ffee12_php",
      password: "q".repeat(16),
    });
    await panel.addCron({ schedule: "* * * * *", command: `/bin/bash $HOME/${app}/agent.sh` });
    fake.writeText(`${app}/agent.sh`, "#!/bin/bash\n");
    fake.writeText("nodevenv/opscrew/e2e-ffee12-node-prod/current/24/bin/node", "");
    fake.writeText(".lsphp_restart.txt", "");
    fake.state.folders.add(".npm");
    fake.writeText(
      ".cl.selector/htaccess_cache",
      "a\n# opscrew/e2e-ffee12-node-prod/current\nPassengerAppType node\nb\n",
      0o600,
    );
    fake.writeText(".cl.selector/selector.json", '{"e2e-ffee12-node": 1, "shop": 2}\n');
    const founderCertificates = fake.state.certificates.filter(
      (certificate) => !certificate.id.startsWith("e2e_"),
    );

    const { problems } = await account.cleanUp({ tag, before }, () => undefined);

    expect(problems).toEqual([
      "~/.cl.selector/selector.json changed beyond one added section of the run's, so it was left: remove the run's lines in cPanel's File Manager",
    ]);
    expect(fake.state.domains.map((domain) => domain.name).sort()).toEqual([
      "blog.example.com",
      "example.com",
      "parked.example.org",
    ]);
    expect([...fake.state.databases.keys()]).toEqual(["acct_shop"]);
    expect([...fake.state.databaseUsers]).toEqual(["acct_shop"]);
    expect(fake.state.cron.map((line) => line.command)).toEqual(["php ~/blog/cron.php"]);
    expect(await panel.list("opscrew")).toEqual(["other-prod"]);
    expect(await panel.list("nodevenv/opscrew")).toEqual(["other-prod"]);
    expect(await panel.list(".npm")).toBeUndefined();
    expect(fake.readText(".lsphp_restart.txt")).toBeUndefined();
    expect(fake.readText(".cl.selector/htaccess_cache")).toBe("a\nb\n");
    const selector = fake.state.files.get(".cl.selector/htaccess_cache");
    expect(selector?.kind === "file" && selector.mode, "the file's own mode").toBe(0o600);
    expect(fake.readText(".cl.selector/selector.json")).toBe('{"e2e-ffee12-node": 1, "shop": 2}\n');
    expect(fake.state.certificates).toEqual(founderCertificates);
    expect(fake.state.keys.map((key) => key.modulus).sort()).toEqual(
      founderCertificates.map((certificate) => certificate.modulus).sort(),
    );
  });
});
