import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { sshArgs } from "../shared";
import { ScriptedRunner } from "../testing";
import {
  PRISMA_P3018,
  RELEASE_OUTPUT_FRAGMENTS,
  SQLALCHEMY_ERROR,
} from "./__fixtures__/release-output";
import {
  copyDump,
  DUMP_PATH,
  databaseSize,
  dumpDatabase,
  hasReleaseService,
  isAppHealthy,
  moveTimeoutMs,
  recreateDatabase,
  removeDump,
  restoreDatabase,
  runRelease,
  startService,
  stopService,
  verifyDump,
  waitAppHealthy,
} from "./server-ops";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): CommandResult => ({ exitCode: 1, stdout, stderr });

class FakeRemote implements RemoteExec {
  readonly calls: { command: string; timeoutMs?: number }[] = [];
  constructor(
    readonly host: string,
    private readonly script: (command: string) => CommandResult | Promise<CommandResult> = () =>
      ok(),
  ) {}
  async run(command: string, options: { timeoutMs?: number } = {}): Promise<CommandResult> {
    this.calls.push({ command, ...(options.timeoutMs !== undefined ? options : {}) });
    return this.script(command);
  }
}

const identity = (text: string) => text;
const MIN = 60_000;
const MB = 1024 * 1024;

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    return error as OpsCrewError;
  }
  throw new Error("expected the operation to fail");
}

describe("moveTimeoutMs", () => {
  it("scales with the database size between a floor and a ceiling", () => {
    expect(moveTimeoutMs(0)).toBe(5 * MIN);
    expect(moveTimeoutMs(1)).toBe(6 * MIN);
    expect(moveTimeoutMs(100 * MB)).toBe(6 * MIN);
    expect(moveTimeoutMs(100 * MB + 1)).toBe(7 * MIN);
    expect(moveTimeoutMs(10 * 1024 * MB)).toBe(5 * MIN + Math.ceil((10 * 1024) / 100) * MIN);
    expect(moveTimeoutMs(10 ** 13)).toBe(6 * 60 * MIN);
    expect(moveTimeoutMs(Number.NaN)).toBe(6 * 60 * MIN);
    expect(moveTimeoutMs(-5)).toBe(5 * MIN);
  });
});

describe("services", () => {
  it("stops and starts app and Caddy with Compose in /srv/app", async () => {
    const remote = new FakeRemote("203.0.113.10");
    await stopService(remote, "app", { redact: identity });
    await startService(remote, "app", { redact: identity });
    await stopService(remote, "caddy", { redact: identity });
    await startService(remote, "caddy", { redact: identity });
    expect(remote.calls).toEqual([
      { command: "cd /srv/app && docker compose stop app", timeoutMs: 2 * MIN },
      { command: "cd /srv/app && docker compose up -d app", timeoutMs: 5 * MIN },
      { command: "cd /srv/app && docker compose stop caddy", timeoutMs: 2 * MIN },
      { command: "cd /srv/app && docker compose up -d caddy", timeoutMs: 5 * MIN },
    ]);
  });

  it("names the step and host and passes stderr through the redactor", async () => {
    const token = fakeSecret("github-token");
    const redactor = new Redactor();
    redactor.addLiteral(token, "github-token");
    const remote = new FakeRemote("203.0.113.10", () =>
      fail(`Error response from daemon: denied ${token}\n`),
    );
    const error = await caught(startService(remote, "app", { redact: redactor.redact }));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("start the app");
    expect(error.message).toContain("203.0.113.10");
    expect(error.message).toContain("Error response from daemon");
    expect(error.message).not.toContain(token);
    expect(error.hint).toContain("docker compose ps");
  });

  it("truncates long stderr", async () => {
    const remote = new FakeRemote("h", () => fail("x".repeat(5000)));
    const error = await caught(stopService(remote, "caddy", { redact: identity }));
    expect(error.message).toContain("stop Caddy");
    expect(error.message.length).toBeLessThan(800);
    expect(error.message).toContain("…");
  });

  it("reports a timeout and a connection failure", async () => {
    const timedOut = new FakeRemote("h", () => ({
      exitCode: 124,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const error = await caught(stopService(timedOut, "app", { redact: identity }));
    expect(error.message).toMatch(/did not finish within 2 minutes/);

    const throwing = new FakeRemote("h", () => {
      throw new Error("spawn ssh ENOENT");
    });
    const thrown = await caught(startService(throwing, "caddy", { redact: identity }));
    expect(thrown.code).toBe("COMMAND_FAILED");
    expect(thrown.message).toContain("start Caddy");
    expect(thrown.message).toContain("spawn ssh ENOENT");
  });
});

describe("app health", () => {
  it("asks the app from a one-off Caddy container on the Compose network", async () => {
    const remote = new FakeRemote("h");
    expect(await isAppHealthy(remote, 3000, "/healthz")).toBe(true);
    expect(remote.calls).toEqual([
      {
        command:
          "cd /srv/app && docker compose run --rm --no-deps -T --entrypoint wget caddy -q -O /dev/null -T 5 'http://app:3000/healthz'",
        timeoutMs: MIN,
      },
    ]);
  });

  it("is false on a failed check, a timeout or a connection error", async () => {
    expect(await isAppHealthy(new FakeRemote("h", () => fail("wget: bad address")), 80, "/")).toBe(
      false,
    );
    expect(
      await isAppHealthy(
        new FakeRemote("h", () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: true })),
        80,
        "/",
      ),
    ).toBe(false);
    expect(
      await isAppHealthy(
        new FakeRemote("h", () => {
          throw new Error("connection reset");
        }),
        80,
        "/",
      ),
    ).toBe(false);
  });

  it("refuses paths that are not safe to put in the command", async () => {
    const remote = new FakeRemote("h");
    for (const path of ["health", "/'; reboot; '", "/a b", "/$(id)", "/`id`"]) {
      const error = await caught(isAppHealthy(remote, 3000, path));
      expect(error.code).toBe("INVALID_INPUT");
    }
    expect(remote.calls).toEqual([]);
  });

  it("waits until the app answers, with a fake clock", async () => {
    let t = 0;
    const sleeps: number[] = [];
    let n = 0;
    const remote = new FakeRemote("h", () => (++n >= 3 ? ok() : fail("connection refused")));
    await waitAppHealthy(remote, 8080, "/up", {
      redact: identity,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    expect(n).toBe(3);
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("throws a plain error naming the host when the app never answers", async () => {
    let t = 0;
    const token = fakeSecret("github-token");
    const remote = new FakeRemote("2001:db8::1", () => fail(`wget: server returned 500 ${token}`));
    const error = await caught(
      waitAppHealthy(remote, 3000, "/health", {
        redact: (text) => text.split(token).join("[redacted]"),
        timeoutMs: 60_000,
        intervalMs: 10_000,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("2001:db8::1");
    expect(error.message).toContain("within 1 minute");
    expect(error.message).toContain("server returned 500");
    expect(error.message).not.toContain(token);
    expect(error.hint).toContain("docker compose logs --tail 200 app");
    expect(remote.calls.length).toBe(7);
  });
});

describe("database", () => {
  it("reads the database size in bytes", async () => {
    const remote = new FakeRemote("h", () => ok("123456789\n"));
    expect(await databaseSize(remote, { redact: identity })).toBe(123_456_789);
    expect(remote.calls).toEqual([
      {
        command: `cd /srv/app && docker compose exec -T db psql -U app -d app -tAc "select pg_database_size('app')"`,
        timeoutMs: MIN,
      },
    ]);
  });

  it("fails plainly on unexpected size output", async () => {
    const error = await caught(
      databaseSize(new FakeRemote("h", () => ok("oops\n")), { redact: identity }),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("database size");
    const failed = await caught(
      databaseSize(new FakeRemote("h", () => fail('service "db" is not running')), {
        redact: identity,
      }),
    );
    expect(failed.message).toContain('service "db" is not running');
  });

  it("dumps into a private file in /srv/app with a size-scaled timeout", async () => {
    const remote = new FakeRemote("h");
    await dumpDatabase(remote, 250 * MB, { redact: identity });
    expect(DUMP_PATH).toBe("/srv/app/opscrew-move.dump");
    expect(remote.calls).toEqual([
      {
        command:
          "cd /srv/app && umask 077 && rm -f /srv/app/opscrew-move.dump && docker compose exec -T db pg_dump -U app -Fc app > /srv/app/opscrew-move.dump",
        timeoutMs: moveTimeoutMs(250 * MB),
      },
    ]);
  });

  it("restores into the app database in one transaction", async () => {
    const remote = new FakeRemote("h");
    await restoreDatabase(remote, 0, { redact: identity });
    expect(remote.calls).toEqual([
      {
        command:
          "cd /srv/app && chmod 600 /srv/app/opscrew-move.dump && docker compose exec -T db pg_restore -U app -d app --no-owner --single-transaction < /srv/app/opscrew-move.dump",
        timeoutMs: 5 * MIN,
      },
    ]);
  });

  it("recreates the app database empty from the maintenance database, ending stray sessions", async () => {
    const remote = new FakeRemote("h");
    await recreateDatabase(remote, { redact: identity });
    expect(remote.calls).toEqual([
      {
        command:
          "cd /srv/app && docker compose exec -T db psql -U app -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS app WITH (FORCE)' -c 'CREATE DATABASE app OWNER app'",
        timeoutMs: 2 * MIN,
      },
    ]);
    const error = await caught(
      recreateDatabase(
        new FakeRemote("198.51.100.7", () => fail('psql: error: database "postgres" not found')),
        { redact: identity },
      ),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("empty the database on 198.51.100.7");
    expect(error.hint).toContain("docker compose logs --tail 100 db");
  });

  it("never puts dump output or row data into errors", async () => {
    const stderr = [
      'pg_restore: error: COPY failed for table "users": ERROR:  duplicate key value violates unique constraint "users_pkey"',
      "DETAIL:  Key (email)=(someone@example.com) already exists.",
      'CONTEXT:  COPY users, line 1: "1\tsomeone@example.com\tsecret-row"',
      "Command was: INSERT INTO users VALUES (1, 'secret-row');",
      "    continued secret-row",
      "pg_restore: warning: errors ignored on restore: 1",
    ].join("\n");
    const remote = new FakeRemote("198.51.100.7", () => fail(stderr, "PGDMP binary dump bytes"));
    const error = await caught(restoreDatabase(remote, 0, { redact: identity }));
    expect(error.message).toContain("restore the database");
    expect(error.message).toContain("198.51.100.7");
    expect(error.message).toContain("duplicate key value");
    expect(error.message).toContain("errors ignored on restore");
    expect(error.message).not.toContain("someone@example.com");
    expect(error.message).not.toContain("secret-row");
    expect(error.message).not.toContain("PGDMP");

    const dump = await caught(
      dumpDatabase(new FakeRemote("h", () => fail("pg_dump: error: x", "PGDMP")), 0, {
        redact: identity,
      }),
    );
    expect(dump.message).toContain("dump the database");
    expect(dump.message).not.toContain("PGDMP");
  });

  it("removes the dump and ignores a missing file", async () => {
    const remote = new FakeRemote("h");
    await removeDump(remote, { redact: identity });
    expect(remote.calls).toEqual([{ command: "rm -f /srv/app/opscrew-move.dump", timeoutMs: MIN }]);
    const error = await caught(
      removeDump(new FakeRemote("h", () => ({ exitCode: 255, stdout: "", stderr: "timeout" })), {
        redact: identity,
      }),
    );
    expect(error.message).toContain("remove the database dump");
  });
});

describe("copyDump", () => {
  it("copies between the servers through this computer with the pinned host keys", async () => {
    const runner = new ScriptedRunner();
    await copyDump(runner, {
      from: "203.0.113.10",
      to: "198.51.100.7",
      keyFile: "/home/u/.opscrew/k",
      knownHostsFile: "/home/u/.opscrew/known_hosts",
      sizeBytes: 50 * MB,
      redact: identity,
    });
    expect(runner.calls).toEqual([
      {
        command: "scp",
        args: [
          "-3",
          "-i",
          "/home/u/.opscrew/k",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "UserKnownHostsFile=/home/u/.opscrew/known_hosts",
          "-o",
          "ConnectTimeout=10",
          "-P",
          "22",
          "deploy@203.0.113.10:/srv/app/opscrew-move.dump",
          "deploy@198.51.100.7:/srv/app/opscrew-move.dump",
        ],
        options: { timeoutMs: 6 * MIN },
      },
    ]);
  });

  it("uses the same SSH options as sshArgs", async () => {
    const runner = new ScriptedRunner();
    await copyDump(runner, {
      from: "a.example",
      to: "b.example",
      keyFile: "k",
      knownHostsFile: "kh",
      sizeBytes: 0,
      redact: identity,
    });
    const ssh = sshArgs({ host: "x", keyFile: "k", knownHostsFile: "kh" });
    const options = ssh.slice(0, ssh.indexOf("-p"));
    expect(runner.calls[0]?.args.slice(1, 1 + options.length)).toEqual(options);
  });

  it("puts IPv6 addresses in brackets", async () => {
    const runner = new ScriptedRunner();
    await copyDump(runner, {
      from: "2001:db8::1",
      to: "2001:db8::2",
      keyFile: "k",
      knownHostsFile: "kh",
      sizeBytes: 0,
      redact: identity,
    });
    expect(runner.calls[0]?.args.slice(-2)).toEqual([
      "deploy@[2001:db8::1]:/srv/app/opscrew-move.dump",
      "deploy@[2001:db8::2]:/srv/app/opscrew-move.dump",
    ]);
  });

  it("refuses host names that scp would read as options or paths", async () => {
    const runner = new ScriptedRunner();
    for (const host of ["-oProxyCommand=x", "a b", "h/x", "", "user@h"]) {
      const error = await caught(
        copyDump(runner, {
          from: host,
          to: "b",
          keyFile: "k",
          knownHostsFile: "kh",
          sizeBytes: 0,
          redact: identity,
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
    }
    expect(runner.calls).toEqual([]);
  });

  it("names both hosts on failure with redacted stderr and a size-scaled timeout", async () => {
    const token = fakeSecret("github-token");
    const runner = new ScriptedRunner(() => ({
      exitCode: 1,
      stdout: "PGDMP",
      stderr: `Host key verification failed. ${token}`,
    }));
    const error = await caught(
      copyDump(runner, {
        from: "203.0.113.10",
        to: "198.51.100.7",
        keyFile: "k",
        knownHostsFile: "kh",
        sizeBytes: 1024 * MB,
        redact: (text) => text.split(token).join("[redacted]"),
      }),
    );
    expect(runner.calls[0]?.options?.timeoutMs).toBe(moveTimeoutMs(1024 * MB));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("copy the database dump");
    expect(error.message).toContain("203.0.113.10");
    expect(error.message).toContain("198.51.100.7");
    expect(error.message).toContain("Host key verification failed");
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain("PGDMP");
  });
});

describe("release", () => {
  it("finds the release service in the server's compose file", async () => {
    const remote = new FakeRemote("h", () => ok("app\nrelease\ndb\ncaddy\n"));
    expect(await hasReleaseService(remote, { redact: identity })).toBe(true);
    expect(remote.calls).toEqual([
      {
        command: "cd /srv/app && docker compose --profile release config --services",
        timeoutMs: MIN,
      },
    ]);
    const without = new FakeRemote("h", () => ok("app\ndb\ncaddy\n"));
    expect(await hasReleaseService(without, { redact: identity })).toBe(false);
    const similar = new FakeRemote("h", () => ok("app\nrelease-notes\n"));
    expect(await hasReleaseService(similar, { redact: identity })).toBe(false);
    const error = await caught(
      hasReleaseService(new FakeRemote("h", () => fail("no configuration file provided")), {
        redact: identity,
      }),
    );
    expect(error.message).toContain("read the Compose services on h");
  });

  it("runs the release service in a one-off container with a size-scaled timeout", async () => {
    const remote = new FakeRemote("h");
    await runRelease(remote, 250 * MB);
    expect(remote.calls).toEqual([
      {
        command: "cd /srv/app && docker compose run --rm --no-deps -T release",
        timeoutMs: moveTimeoutMs(250 * MB),
      },
    ]);
  });

  it.each([
    { tool: "Prisma P3018", stderr: PRISMA_P3018 },
    { tool: "SQLAlchemy", stderr: SQLALCHEMY_ERROR },
  ])("a failed release ($tool) shows the exit code and none of its output", async ({ stderr }) => {
    const remote = new FakeRemote("198.51.100.7", () => ({
      exitCode: 1,
      stdout: stderr,
      stderr,
    }));
    const error = await caught(runRelease(remote, 0));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "Could not run the release command (app.releaseCommand in opscrew/plan.yaml) on 198.51.100.7: it exited with code 1 (it ran only on the copy of the database on the new server; your users' data on the old server is untouched).",
    );
    expect(error.hint).toContain("The old server keeps serving your users.");
    expect(error.hint).toContain(
      "`ssh deploy@198.51.100.7`, then `cd /srv/app && docker compose run --rm --no-deps -T release`",
    );
    expect(error.hint).toContain("app.releaseCommand");
    for (const fragment of RELEASE_OUTPUT_FRAGMENTS) {
      expect(`${error.message}\n${error.hint}`).not.toContain(fragment);
    }
  });

  it("a release that times out or loses the connection says so plainly", async () => {
    const slow = new FakeRemote("h", () => ({
      exitCode: 1,
      stdout: "",
      stderr: SQLALCHEMY_ERROR,
      timedOut: true,
    }));
    const late = await caught(runRelease(slow, 0));
    expect(late.message).toContain("it did not finish within 5 minutes");
    const broken = new FakeRemote("h", () => {
      throw new Error(SQLALCHEMY_ERROR);
    });
    const lost = await caught(runRelease(broken, 0));
    expect(lost.message).toContain("the SSH connection failed");
    for (const fragment of RELEASE_OUTPUT_FRAGMENTS) {
      expect(`${late.message}${late.hint}${lost.message}${lost.hint}`).not.toContain(fragment);
    }
  });
});

describe("verifyDump", () => {
  const hash = "a".repeat(64);

  it("checks that Postgres can read the dump and returns its SHA-256", async () => {
    const remote = new FakeRemote("h", () => ok(`${hash}  ${DUMP_PATH}\n`));
    expect(await verifyDump(remote, 250 * MB, { redact: identity })).toBe(hash);
    expect(remote.calls).toEqual([
      {
        command:
          "cd /srv/app && docker compose exec -T db pg_restore --list < /srv/app/opscrew-move.dump > /dev/null && sha256sum /srv/app/opscrew-move.dump",
        timeoutMs: moveTimeoutMs(250 * MB),
      },
    ]);
  });

  it("fails plainly on an unreadable dump or a missing checksum", async () => {
    const unreadable = await caught(
      verifyDump(
        new FakeRemote("198.51.100.7", () =>
          fail("pg_restore: error: input file does not appear to be a valid archive"),
        ),
        0,
        { redact: identity },
      ),
    );
    expect(unreadable.code).toBe("COMMAND_FAILED");
    expect(unreadable.message).toContain("read the database dump on 198.51.100.7");
    expect(unreadable.message).toContain("does not appear to be a valid archive");
    expect(unreadable.hint).toContain("opscrew retarget");
    const garbled = await caught(
      verifyDump(new FakeRemote("h", () => ok("oops\n")), 0, { redact: identity }),
    );
    expect(garbled.message).toContain("did not report a checksum");
  });
});
