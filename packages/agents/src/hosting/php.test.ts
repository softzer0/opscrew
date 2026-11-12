// Feature 027 (T2711): the PHP a hostname gets on a hosting account (plan 5), and its cron lines.
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  agentCronCommand,
  appCronCommand,
  choosePhp,
  constraintAllows,
  type PhpBinary,
  type PhpChoiceInput,
  phpRefusal,
} from "./php";

/** The base extensions alt-php loads through a handler line (research R11). */
const BASE = ["core", "ctype", "curl", "json", "openssl", "pdo", "pdo_mysql", "zend-opcache"];
const ALL = [...BASE, "mbstring", "fileinfo", "intl"];

const bin = (path: string, version: string, modules = ALL): PhpBinary => ({
  path,
  version,
  modules,
});

/** The founder's test account (R11): the account's 7.0, alt-php 8.0 to 8.5 with base modules. */
const CLOUDLINUX: PhpBinary[] = [
  bin("/usr/local/bin/php", "7.0.33"),
  ...["80", "81", "82", "83", "84", "85"].map((v) =>
    bin(`/opt/alt/php${v}/usr/bin/php`, `${v[0]}.${v.slice(1)}.4`, BASE),
  ),
];

const PLAIN = { php: ">=8.3", extensions: ["pdo_mysql"], websockets: [] };
const LARAVEL = { php: "^8.4", extensions: ["mbstring", "fileinfo"], websockets: [] };

function input(over: Partial<PhpChoiceInput>): PhpChoiceInput {
  return {
    needs: PLAIN,
    binaries: CLOUDLINUX,
    panel: "cpanel",
    phpPerHostname: [],
    webServer: "LiteSpeed",
    ...over,
  };
}

describe("choosePhp, in plan 5's order", () => {
  it("1. takes the account's own version when it runs the app", () => {
    const binaries = [bin("/usr/local/bin/php", "8.3.20"), ...CLOUDLINUX.slice(1)];
    expect(choosePhp(input({ binaries }))).toEqual({
      version: "8.3",
      via: "account",
      cli: "/usr/local/bin/php",
    });
  });

  it("2. on cPanel, the oldest MultiPHP version that runs the app", () => {
    const binaries = [
      bin("/usr/local/bin/php", "7.0.33"),
      bin("/opt/cpanel/ea-php82/root/usr/bin/php", "8.2.30"),
      bin("/opt/cpanel/ea-php84/root/usr/bin/php", "8.4.10"),
      bin("/opt/cpanel/ea-php85/root/usr/bin/php", "8.5.1"),
    ];
    expect(choosePhp(input({ binaries, phpPerHostname: ["8.2", "8.4", "8.5"] }))).toEqual({
      version: "8.4",
      via: "multiphp",
      cli: "/opt/cpanel/ea-php84/root/usr/bin/php",
    });
    // MultiPHP offers no version for one hostname: the version isn't the hostname's to have.
    expect(choosePhp(input({ binaries, phpPerHostname: [], webServer: "Apache" }))).toBeUndefined();
  });

  it("2. on Plesk and DirectAdmin, the oldest per-domain version, set as a step in the panel", () => {
    expect(
      choosePhp(
        input({
          panel: "plesk",
          binaries: [
            bin("/usr/local/bin/php", "7.4.33"),
            bin("/opt/plesk/php/8.3/bin/php", "8.3.9"),
            bin("/opt/plesk/php/8.4/bin/php", "8.4.2"),
          ],
          webServer: "Apache",
        }),
      ),
    ).toEqual({
      version: "8.3",
      via: "multiphp",
      cli: "/opt/plesk/php/8.3/bin/php",
      panelStep: true,
    });
    expect(
      choosePhp(
        input({
          panel: "directadmin",
          binaries: [bin("/usr/local/php83/bin/php", "8.3.9")],
          webServer: "Apache",
        }),
      ),
    ).toMatchObject({ version: "8.3", via: "multiphp", panelStep: true });
  });

  it("3. on CloudLinux behind LiteSpeed, alt-php through the handler line when its defaults cover the app", () => {
    expect(choosePhp(input({}))).toEqual({
      version: "8.3",
      via: "handler",
      cli: "/opt/alt/php83/usr/bin/php",
      handler: "application/x-httpd-alt-php83___lsphp",
    });
    // Not behind LiteSpeed: no handler line.
    expect(choosePhp(input({ webServer: "Apache" }))).toBeUndefined();
  });

  it("4. stops when nothing runs the app: Laravel's mbstring is no base extension (R11)", () => {
    const options = input({ needs: LARAVEL });
    expect(choosePhp(options)).toBeUndefined();
    const error = phpRefusal(options);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error.message).toBe(
      "The app needs PHP ^8.4 with mbstring and fileinfo, and the account runs PHP 7.0.33. The other versions the agent found (8.0, 8.1, 8.2, 8.3, 8.4 and 8.5) don't run it for one hostname: each lacks the version or an extension the app needs, or the account can't give it to one hostname. OpsCrew never changes the account's PHP version, so it stopped before making the hostname or the database.",
    );
    expect(error.hint).toContain(
      "cPanel's PHP selector (every site on the account changes with it)",
    );
    expect(error.hint).toContain("CloudLinux Isolates");
  });

  it("never picks a version the deploy workflow can't build with", () => {
    const binaries = [bin("/usr/local/bin/php", "7.0.33")];
    expect(choosePhp(input({ binaries, needs: { extensions: [], websockets: [] } }))).toBe(
      undefined,
    );
  });
});

describe("constraintAllows", () => {
  it.each([
    [">=8.3", "8.3.0", true],
    [">=8.3", "8.2.9", false],
    ["^8.1", "8.5.1", true],
    ["^8.1", "9.0.0", false],
    ["^7.4|^8.0", "8.2.1", true],
    ["^7.4 || ^8.0", "7.3.0", false],
    [">=7.4,<8.3", "8.2.0", true],
    [">=7.4 <8.3", "8.3.0", false],
    ["8.2.*", "8.2.7", true],
    ["8.2.*", "8.3.0", false],
    ["dev-main", "8.3.0", true],
  ])("%s with PHP %s: %s", (constraint, version, allowed) => {
    expect(constraintAllows(constraint, version)).toBe(allowed);
  });
});

describe("the cron lines", () => {
  it("runs the app's command in the running release with the chosen PHP and its settings", () => {
    expect(
      appCronCommand({
        folder: "opscrew/notes-prod",
        command: "php bin/cron.php",
        cli: "/opt/alt/php85/usr/bin/php",
        envPhp: true,
      }),
    ).toBe(
      'cd "$HOME/opscrew/notes-prod/current" && /opt/alt/php85/usr/bin/php -d auto_prepend_file="$HOME/opscrew/notes-prod/shared/env.php" bin/cron.php >> "$HOME/opscrew/notes-prod/state/cron.log" 2>&1',
    );
    // Laravel reads its own .env: no prepended settings.
    expect(
      appCronCommand({
        folder: "opscrew/shop-staging",
        command: "php artisan schedule:run",
        cli: "/usr/local/bin/php",
        envPhp: false,
      }),
    ).toBe(
      'cd "$HOME/opscrew/shop-staging/current" && /usr/local/bin/php artisan schedule:run >> "$HOME/opscrew/shop-staging/state/cron.log" 2>&1',
    );
  });

  it("runs the agent every minute, its output into state/agent.log", () => {
    expect(agentCronCommand("opscrew/notes-prod")).toBe(
      '/bin/bash "$HOME/opscrew/notes-prod/agent.sh" >> "$HOME/opscrew/notes-prod/state/agent.log" 2>&1',
    );
  });
});
