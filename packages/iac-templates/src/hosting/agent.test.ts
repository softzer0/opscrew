import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { agentSkipReason } from "./__fixtures__/account";
import { AGENT_SH, type AgentSettings, renderAgentSettings } from "./agent";

const LARAVEL: AgentSettings = {
  app: "notes",
  environment: "prod",
  hostname: "notes.example.com",
  repository: "acme/notes",
  releaseBranch: "opscrew/release/prod",
  webRoot: "public",
  healthPath: "/up",
  appKind: "php",
  phpCli: "/opt/alt/php85/usr/bin/php",
  phpHandler: "application/x-httpd-alt-php85___lsphp",
  releaseCommand: "php artisan migrate --force",
  sharedPaths: [".env", "storage"],
  keep: 3,
  snapshots: false,
  database: "acct_notes",
};

const STATIC_SITE: AgentSettings = {
  app: "site",
  environment: "staging",
  hostname: "staging.example.org",
  repository: "acme/site",
  releaseBranch: "opscrew/release/site-staging",
  webRoot: ".",
  healthPath: "/",
  appKind: "static",
  sharedPaths: [],
  keep: 3,
  snapshots: true,
};

const bash = agentSkipReason() === undefined;

describe("AGENT_SH", () => {
  it("is one bash function run on its last line", () => {
    expect(AGENT_SH.startsWith("#!/bin/bash\n")).toBe(true);
    expect(AGENT_SH).toContain("\nset -eu\n");
    expect(AGENT_SH).toContain("\nmain() {\n");
    expect(AGENT_SH.endsWith('\nmain "$@"; exit\n')).toBe(true);
  });

  it("never sources or evaluates what a request or a release holds", () => {
    const sourced = AGENT_SH.split("\n").filter((line) => /^\s*(?:\.|source|eval)\s/.test(line));
    expect(sourced).toEqual(["  . ./settings.sh"]);
  });

  it("sends the security headers and the release's on every answer", () => {
    expect(AGENT_SH).toContain(`'Header always set X-Content-Type-Options "nosniff"'`);
    expect(AGENT_SH).toContain(`Strict-Transport-Security "max-age=31536000; includeSubDomains"`);
  });

  it.skipIf(!bash)("is valid bash", () => {
    const result = spawnSync("bash", ["-n"], { input: AGENT_SH, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("renderAgentSettings", () => {
  it("renders a PHP app's settings, one quoted assignment per line", () => {
    expect(renderAgentSettings(LARAVEL)).toMatchSnapshot();
  });

  it("renders a static site's, with no PHP and no database", () => {
    expect(renderAgentSettings(STATIC_SITE)).toMatchSnapshot();
  });

  it.skipIf(!bash)("gives bash back each value as it was, quotes included", () => {
    const settings = {
      ...LARAVEL,
      releaseCommand: `php artisan migrate --force && echo 'it''s "done" $HOME'`,
    };
    const result = spawnSync(
      "bash",
      ["-c", 'eval "$(cat)"; printf "%s\\n" "$RELEASE_COMMAND" "$SHARED_PATHS"'],
      {
        input: renderAgentSettings(settings),
        encoding: "utf8",
      },
    );
    expect(result.stdout).toBe(`${settings.releaseCommand}\n.env storage\n`);
  });

  it.each<[keyof AgentSettings, unknown]>([
    ["app", "Notes"],
    ["environment", "production"],
    ["hostname", "notes.example.com;rm"],
    ["repository", "acme"],
    ["releaseBranch", "main"],
    ["webRoot", "../public"],
    ["webRoot", "/home/acct/public"],
    ["healthPath", "health"],
    ["healthPath", "/'"],
    ["appKind", "ruby"],
    ["phpCli", "php"],
    ["phpCli", "/opt/../bin/php"],
    ["phpHandler", "x-httpd-php85"],
    ["releaseCommand", "php artisan migrate\nrm -rf ~"],
    ["sharedPaths", [".env", ".env"]],
    ["sharedPaths", ["storage dir"]],
    ["keep", 0],
    ["keep", 1.5],
    ["database", "notes-db"],
  ])("refuses %s %j, naming the field", (field, value) => {
    expect(() => renderAgentSettings({ ...LARAVEL, [field]: value })).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringContaining(` ${field} `),
      }),
    );
  });

  it("takes a PHP app without its CLI until provision chooses the version (T2711)", () => {
    const { phpCli: _cli, ...unchosen } = LARAVEL;
    expect(renderAgentSettings(unchosen)).toContain("\nPHP_CLI=''\n");
  });

  it("refuses PHP settings for an app that isn't PHP", () => {
    expect(() => renderAgentSettings({ ...STATIC_SITE, phpCli: "/usr/local/bin/php" })).toThrow(
      /phpCli/,
    );
    expect(() =>
      renderAgentSettings({ ...STATIC_SITE, phpHandler: "application/x-httpd-alt-php85___lsphp" }),
    ).toThrow(/phpHandler/);
  });
});
