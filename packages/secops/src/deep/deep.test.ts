import { readFileSync } from "node:fs";
import type { CommandResult, FetchLike, RemoteExec } from "@opscrew/contracts";
import { sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { LYNIS_TIMEOUT_MS, lynisResults, parseLynisReport, runLynis } from "./lynis";
import { DEEP_NOISE, markNoise } from "./noise";
import { localDockerProblem } from "./shared";
import {
  parseSshAudit,
  parseSshAuditPolicy,
  runSshAudit,
  SSH_AUDIT_POLICY,
  sshAuditResults,
} from "./ssh-audit";
import { parseTestssl, runTestssl, testsslResults } from "./testssl";
import type { DeepPins, LocalDocker } from "./types";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const LYNIS_REPORT = fixture("lynis-report.dat");
const SSH_AUDIT = fixture("ssh-audit.json");
const SSH_POLICY = fixture("ssh-audit-policy.json");
const TESTSSL = fixture("testssl.json");

/** A stand-in for the Lynis tarball, with its SHA-256 as the pin. */
const TARBALL = new TextEncoder().encode("not really a tarball\u0000ÿ");

const PINS: DeepPins = {
  lynisImage:
    "curlimages/curl:8.23.0@sha256:1111111111111111111111111111111111111111111111111111111111111111",
  lynis: {
    version: "3.1.7",
    url: "https://downloads.cisofy.com/lynis/lynis-3.1.7.tar.gz",
    sha256: sha256Hex(TARBALL),
  },
  sshAudit:
    "positronsecurity/ssh-audit:v3.9.0@sha256:2222222222222222222222222222222222222222222222222222222222222222",
  testssl:
    "ghcr.io/testssl/testssl.sh:3.2@sha256:3333333333333333333333333333333333333333333333333333333333333333",
};

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

const tarballFetch: FetchLike = async (url) => {
  expect(String(url)).toBe(PINS.lynis.url);
  return new Response(TARBALL);
};

interface SshCall {
  command: string;
  options?: { timeoutMs?: number; input?: string };
}

/** A fake server: `docker image inspect` says whether the image is there; Lynis's run answers `lynis`. */
function fakeServer(o: { present?: boolean; lynis?: CommandResult; rm?: CommandResult } = {}) {
  const calls: SshCall[] = [];
  let pulled = false;
  const ssh: RemoteExec = {
    host: "192.0.2.10",
    async run(command, options) {
      calls.push({ command, ...(options !== undefined ? { options } : {}) });
      if (command.startsWith("docker image inspect")) return ok(o.present ? "yes\n" : "no\n");
      if (command.startsWith("docker run")) {
        pulled = true;
        return o.lynis ?? ok(LYNIS_REPORT);
      }
      if (command.startsWith("if docker image inspect")) {
        expect(pulled).toBe(true);
        return o.rm ?? ok();
      }
      if (command.startsWith("docker rm -f")) return ok();
      return { exitCode: 127, stdout: "", stderr: `unexpected: ${command}` };
    },
  };
  return { ssh, calls };
}

/** A fake local Docker answering each `docker` call with `answer`. */
function fakeDocker(answer: (args: readonly string[]) => CommandResult) {
  const calls: { args: readonly string[]; timeoutMs: number }[] = [];
  const docker: LocalDocker = {
    async run(args, options) {
      calls.push({ args, timeoutMs: options.timeoutMs });
      return answer(args);
    },
  };
  return { docker, calls };
}

describe("parseLynisReport", () => {
  it("reads the version, the hardening index, the warnings and the suggestions", () => {
    const report = parseLynisReport(LYNIS_REPORT);
    expect(report.version).toBe("3.1.7");
    expect(report.hardeningIndex).toBe(62);
    expect(report.warnings.map((w) => w.id)).toEqual(["PKGS-7388", "PKGS-7392", "FIRE-4512"]);
    expect(report.warnings[1]).toEqual({
      id: "PKGS-7392",
      text: "Found one or more vulnerable packages.",
    });
    expect(report.suggestions).toHaveLength(40);
    expect(report.suggestions.find((s) => s.id === "HRDN-7230")).toEqual({
      id: "HRDN-7230",
      text: "Harden the system by installing at least one malware scanner, to perform periodic file system scans",
      solution: "Install a tool like rkhunter, chkrootkit, OSSEC, Wazuh",
    });
    expect(report.suggestions.find((s) => s.id === "FILE-7524")?.solution).toBe(
      "Use chmod to change file permissions",
    );
  });

  it("reads Lynis's notices about its own age, and sets them apart as noise", () => {
    const report = parseLynisReport(
      [
        "lynis_version=3.1.7",
        "warning[]=LYNIS|This release is more than 4 months old. Check the website or GitHub to see if there is an update available.|-|-|",
        "suggestion[]=LYNIS|This release is more than 4 months old. Consider upgrading|-|-|",
        "hardening_index=70",
      ].join("\n"),
    );
    expect(report.warnings.map((w) => w.id)).toEqual(["LYNIS"]);
    expect(report.suggestions.map((s) => s.id)).toEqual(["LYNIS"]);
    const noise = lynisResults(report).filter((r) => r.id === "LYNIS");
    expect(noise.map((r) => r.noise)).toEqual([
      "OpsCrew pins Lynis's version and updates it with its pins.",
      "OpsCrew pins Lynis's version and updates it with its pins.",
    ]);
  });

  it("refuses a report whose items are not Lynis's", () => {
    expect(() => parseLynisReport("warning[]=not an id|text|-|-|")).toThrow();
  });
});

describe("lynisResults", () => {
  it("maps warnings to medium, suggestions to low and an index below 65 to medium, all warn", () => {
    const results = lynisResults(parseLynisReport(LYNIS_REPORT));
    expect(results[0]).toMatchObject({
      id: "hardening-index",
      status: "warn",
      severity: "medium",
      message: "The Lynis hardening index is 62 of 100.",
      source: "lynis",
    });
    const warning = results.find((r) => r.id === "PKGS-7392");
    expect(warning).toMatchObject({ status: "warn", severity: "medium", source: "lynis" });
    // A warning without a solution takes the advice of its suggestion.
    expect(warning?.remediation).toContain("Update your system with apt-get update");
    expect(results.filter((r) => r.severity === "low" && r.status === "warn")).toHaveLength(40);
    expect(results.find((r) => r.id === "FIRE-4512")?.remediation).toBe(
      "See https://cisofy.com/lynis/controls/FIRE-4512/ for what Lynis checks and how to fix it.",
    );
    expect(lynisResults({ hardeningIndex: 65, warnings: [], suggestions: [] })[0]?.status).toBe(
      "pass",
    );
  });

  it("sets apart Lynis's known noise with its reason", () => {
    const results = lynisResults(parseLynisReport(LYNIS_REPORT));
    const noise = results.filter((r) => r.noise !== undefined).map((r) => r.id);
    expect(noise).toEqual(
      expect.arrayContaining([
        "PKGS-7388",
        "FILE-6310",
        "BOOT-5122",
        "USB-1000",
        "HRDN-7230",
        "FINT-4350",
      ]),
    );
    expect(results.find((r) => r.id === "PKGS-7388")?.noise).toContain("deb822");
    expect(results.find((r) => r.id === "PKGS-7392")?.noise).toBeUndefined();
    expect(results.find((r) => r.id === "FIRE-4512")?.noise).toBeUndefined();
  });
});

describe("markNoise", () => {
  it("marks only the tool's listed ids, keeping the result's data", () => {
    const result = {
      id: "BOOT-5122",
      title: "t",
      status: "warn" as const,
      severity: "low" as const,
      message: "m",
    };
    expect(markNoise([result], "lynis")).toEqual([
      { ...result, noise: DEEP_NOISE.lynis["BOOT-5122"] },
    ]);
    expect(markNoise([result], "testssl")).toEqual([result]);
    expect(markNoise([{ ...result, id: "OCSP_stapling" }], "testssl")[0]?.noise).toContain("OCSP");
  });
});

describe("runLynis", () => {
  it("runs Lynis once in a throwaway read-only container, streams the tarball and removes the pulled image", async () => {
    const { ssh, calls } = fakeServer();
    const result = await runLynis(ssh, PINS, tarballFetch);

    expect(calls.map((c) => c.command.split(" ").slice(0, 3).join(" "))).toEqual([
      "docker image inspect",
      "docker run --rm",
      "if docker image",
    ]);
    const run = calls[1];
    const command = run?.command ?? "";
    expect(command).toMatch(/^docker run --rm -i --name opscrew-lynis-[0-9a-f]{12} --user 0 /);
    for (const part of [
      "--mount type=bind,src=/,dst=/hostfs,readonly,bind-recursive=readonly",
      "--tmpfs /hostfs/tmp:rw,exec,size=128m",
      "--pid=host --net=host --security-opt no-new-privileges",
      `--entrypoint /bin/sh ${PINS.lynisImage}`,
      `echo "${PINS.lynis.sha256}  lynis.tar.gz" | sha256sum -c -s -`,
      "chroot /hostfs /bin/sh -c",
      "--quick --no-colors --report-file /tmp/report.dat",
      "cat report.dat",
    ]) {
      expect(command).toContain(part);
    }
    expect(command.match(/docker run/g)).toHaveLength(1);
    expect(command.slice(command.indexOf("-c '") + 4, -1)).not.toContain("'");
    expect(run?.options?.timeoutMs).toBe(LYNIS_TIMEOUT_MS);
    expect(Buffer.from(run?.options?.input ?? "", "base64")).toEqual(Buffer.from(TARBALL));
    expect(calls[2]?.command).toBe(
      `if docker image inspect ${PINS.lynisImage} > /dev/null 2>&1; then docker image rm ${PINS.lynisImage} > /dev/null; fi`,
    );

    expect(result).toMatchObject({ tool: "lynis", version: "3.1.7", hardeningIndex: 62 });
    expect(result.results.some((r) => r.id === "PKGS-7392")).toBe(true);
  });

  it("keeps an image that was on the server before", async () => {
    const { ssh, calls } = fakeServer({ present: true });
    await runLynis(ssh, PINS, tarballFetch);
    expect(calls.map((c) => c.command.split(" ")[1])).toEqual(["image", "run"]);
  });

  it("warns when the pulled image could not be removed", async () => {
    const { ssh } = fakeServer({ rm: { exitCode: 1, stdout: "", stderr: "image is in use" } });
    const result = await runLynis(ssh, PINS, tarballFetch);
    expect(result.results.at(-1)).toMatchObject({
      id: "lynis-image-removed",
      status: "warn",
      message: "The image Lynis ran in could not be removed from the server (image is in use).",
    });
  });

  it("skips with the reason when the download, SSH, the checksum or the time limit stops it", async () => {
    const failing: FetchLike = async () => new Response("", { status: 503 });
    const download = await runLynis(fakeServer().ssh, PINS, failing);
    expect(download.results).toEqual([
      expect.objectContaining({ status: "skip", message: expect.stringContaining("HTTP 503") }),
    ]);

    const unreachable: RemoteExec = {
      host: "192.0.2.10",
      run: async () => ({
        exitCode: 255,
        stdout: "",
        stderr: "ssh: connect to host: Connection refused",
      }),
    };
    const refused = await runLynis(unreachable, PINS, tarballFetch);
    expect(refused.results).toEqual([
      expect.objectContaining({
        status: "skip",
        message:
          "OpsCrew could not reach the server over SSH to run Lynis (ssh: connect to host: Connection refused).",
      }),
    ]);

    const mismatch = await runLynis(
      fakeServer({ lynis: { exitCode: 90, stdout: "", stderr: "mismatch" } }).ssh,
      PINS,
      tarballFetch,
    );
    expect(mismatch.results[0]).toMatchObject({
      status: "skip",
      message: "The Lynis 3.1.7 download does not match its pinned SHA-256, so it did not run.",
    });

    const { ssh, calls } = fakeServer({
      lynis: { exitCode: 124, stdout: "", stderr: "", timedOut: true },
    });
    const slow = await runLynis(ssh, PINS, tarballFetch);
    expect(slow.results).toEqual([
      expect.objectContaining({
        status: "skip",
        message: "Lynis did not finish within 4 minutes, so it gives no result.",
      }),
    ]);
    // The container still running on the server is removed by its name, then the image.
    const name = /--name (opscrew-lynis-[0-9a-f]{12})/.exec(calls[1]?.command ?? "")?.[1];
    expect(calls.slice(2).map((c) => c.command)).toEqual([
      `docker rm -f ${name} > /dev/null 2>&1 || true`,
      `if docker image inspect ${PINS.lynisImage} > /dev/null 2>&1; then docker image rm ${PINS.lynisImage} > /dev/null; fi`,
    ]);
  });

  it("removes the container after a failure, and only then", async () => {
    const ran = fakeServer();
    await runLynis(ran.ssh, PINS, tarballFetch);
    expect(ran.calls.some((c) => c.command.startsWith("docker rm -f"))).toBe(false);

    const failed = fakeServer({ lynis: { exitCode: 1, stdout: "", stderr: "chroot: failed" } });
    const result = await runLynis(failed.ssh, PINS, tarballFetch);
    expect(result.results[0]).toMatchObject({
      status: "skip",
      message: expect.stringContaining("chroot: failed"),
    });
    expect(failed.calls[2]?.command).toMatch(/^docker rm -f opscrew-lynis-[0-9a-f]{12} /);
  });

  it("skips a server whose Docker or kernel cannot mount the host read-only, with the versions needed", async () => {
    const { ssh } = fakeServer({
      lynis: {
        exitCode: 125,
        stdout: "",
        stderr:
          "docker: Error response from daemon: failed to create task for container: recursive read-only mount is not supported by the kernel.",
      },
    });
    const result = await runLynis(ssh, PINS, tarballFetch);
    expect(result.results[0]).toMatchObject({
      status: "skip",
      message: expect.stringContaining(
        "This server's Docker or kernel cannot mount the host read-only, so OpsCrew does not run Lynis on it",
      ),
      remediation: expect.stringContaining("kernel 5.12 or later and Docker 25 or later"),
    });
  });

  it("downloads the tarball with a one-minute limit", async () => {
    let signal: AbortSignal | undefined;
    const fetch: FetchLike = async (url, init) => {
      signal = init?.signal ?? undefined;
      return tarballFetch(url, init);
    };
    await runLynis(fakeServer().ssh, PINS, fetch);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ssh-audit", () => {
  it("parses the audit and the policy test", () => {
    const audit = parseSshAudit(JSON.parse(SSH_AUDIT));
    expect(audit.software).toBe("OpenSSH_9.6p1");
    expect(audit.algorithms.find((a) => a.name === "ecdsa-sha2-nistp256")).toMatchObject({
      kind: "key",
      fail: [
        "using elliptic curves that are suspected as being backdoored by the U.S. National Security Agency",
      ],
    });
    expect(parseSshAuditPolicy(JSON.parse(SSH_POLICY))).toEqual({
      policy: SSH_AUDIT_POLICY,
      passed: false,
      mismatched: [
        "Host keys",
        "Host key (rsa-sha2-256) sizes",
        "Host key (rsa-sha2-512) sizes",
        "Key exchanges",
        "Ciphers",
        "MACs",
      ],
    });
    expect(() => parseSshAudit({ banner: {} })).toThrow();
    expect(() => parseSshAuditPolicy({ passed: "no" })).toThrow();
  });

  it("maps a failed policy to high fail, each flagged algorithm to low warn, and marks the noise", () => {
    const results = sshAuditResults(
      parseSshAudit(JSON.parse(SSH_AUDIT)),
      parseSshAuditPolicy(JSON.parse(SSH_POLICY)),
    );
    expect(results[0]).toMatchObject({
      id: "policy",
      status: "fail",
      severity: "high",
      source: "ssh-audit",
    });
    expect(results[0]?.message).toContain("Key exchanges, Ciphers, MACs differ");
    const others = results.slice(1);
    expect(others.every((r) => r.status === "warn" && r.severity === "low")).toBe(true);
    expect(results.find((r) => r.id === "mac:hmac-sha1")).toMatchObject({ status: "warn" });
    expect(results.find((r) => r.id === "mac:hmac-sha1")?.noise).toBeUndefined();
    expect(results.find((r) => r.id === "key:ecdsa-sha2-nistp256")?.noise).toContain("NIST");
    expect(results.find((r) => r.id === "kex:diffie-hellman-group14-sha256")?.noise).toContain(
      "group14",
    );
    expect(results.find((r) => r.id === "mac:hmac-sha2-256")?.noise).toContain("encrypt-then-MAC");
    // An algorithm with only info notes is no result.
    expect(results.some((r) => r.id === "enc:aes128-ctr")).toBe(false);
  });

  it("runs the audit and the policy test in the pinned image and reads the JSON despite exit code 3", async () => {
    const { docker, calls } = fakeDocker((args) => ({
      exitCode: 3,
      stdout: args.includes("-P") ? SSH_POLICY : SSH_AUDIT,
      stderr: "",
    }));
    const result = await runSshAudit(docker, "192.0.2.10", 2222, PINS);
    const name = expect.stringMatching(/^opscrew-ssh-audit-[0-9a-f]{12}$/);
    expect(calls.map((c) => c.args)).toEqual([
      [
        ...["run", "--rm", "--name", name, PINS.sshAudit, "-jj", "--skip-rate-test"],
        ...["-p", "2222", "192.0.2.10"],
      ],
      [
        ...["run", "--rm", "--name", name, PINS.sshAudit, "-jj", "-P", SSH_AUDIT_POLICY],
        ...["-p", "2222", "192.0.2.10"],
      ],
    ]);
    expect(calls[0]?.args[3]).not.toBe(calls[1]?.args[3]);
    expect(calls.every((c) => c.timeoutMs === 60_000)).toBe(true);
    expect(result.version).toBe("3.9.0");
    expect(result.results[0]).toMatchObject({ id: "policy", status: "fail" });
  });

  it("skips, never passes, when the connection is refused or times out", async () => {
    const refused = fakeDocker(() => ({
      exitCode: 1,
      stdout:
        "\u001b[0;31m[exception] cannot connect to 192.0.2.10 port 22: [Errno 111] Connection refused\u001b[0m\n",
      stderr: "",
    }));
    const result = await runSshAudit(refused.docker, "192.0.2.10", 22, PINS);
    expect(result.results).toEqual([
      expect.objectContaining({
        status: "skip",
        message:
          "ssh-audit could not finish auditing SSH on port 22: [exception] cannot connect to 192.0.2.10 port 22: [Errno 111] Connection refused.",
      }),
    ]);
    expect(refused.calls).toHaveLength(1);

    const slow = fakeDocker((args) =>
      args[0] === "rm" ? ok() : { exitCode: 1, stdout: "", stderr: "", timedOut: true },
    );
    const timedOut = await runSshAudit(slow.docker, "192.0.2.10", 22, PINS);
    expect(timedOut.results).toEqual([
      expect.objectContaining({
        status: "skip",
        message: expect.stringContaining("did not finish auditing SSH on port 22 within 1 minute"),
      }),
    ]);
    // The container the killed client left running is removed by its name.
    expect(slow.calls.map((c) => c.args)).toEqual([
      expect.arrayContaining(["--name", slow.calls[0]?.args[3]]),
      ["rm", "-f", slow.calls[0]?.args[3]],
    ]);
    expect(refused.calls.some((c) => c.args[0] === "rm")).toBe(false);
  });
});

describe("testssl.sh", () => {
  it("parses every finding and its version", () => {
    const { version, items } = parseTestssl(JSON.parse(TESTSSL));
    expect(version).toBe("3.2.4");
    expect(items.find((i) => i.id === "cert_chain_of_trust")).toEqual({
      id: "cert_chain_of_trust",
      severity: "CRITICAL",
      finding: "failed (chain incomplete).",
    });
    expect(() =>
      parseTestssl({
        version: "3.2.4",
        scanResult: [{ id: "x", severity: "SEVERE", finding: "" }],
      }),
    ).toThrow();
  });

  it("maps CRITICAL to LOW one to one, drops OK and INFO, and marks the noise", () => {
    const { items } = parseTestssl(JSON.parse(TESTSSL));
    const results = testsslResults(items, "app.example.com", false);
    expect(results.map((r) => [r.id, r.severity, r.status])).toEqual([
      ["cert_chain_of_trust", "critical", "fail"],
      ["cert_revocation", "high", "fail"],
      ["DNS_CAArecord", "low", "warn"],
      ["intermediate_cert_notAfter <#1>", "high", "fail"],
      ["intermediate_cert_expiration <#1>", "high", "fail"],
      ["security_headers", "medium", "warn"],
    ]);
    expect(results.every((r) => r.target === "app.example.com" && r.source === "testssl")).toBe(
      true,
    );
    expect(results.find((r) => r.id === "DNS_CAArecord")?.noise).toContain("CAA");
    expect(results.find((r) => r.id === "security_headers")?.message).toBe(
      "security_headers: none",
    );
  });

  it("labels a proxied hostname's results as Cloudflare's edge", () => {
    const { items } = parseTestssl(JSON.parse(TESTSSL));
    const results = testsslResults(items, "app.example.com", true);
    expect(results.every((r) => r.target === "app.example.com (Cloudflare's edge)")).toBe(true);
    expect(results[0]?.remediation).toContain("Cloudflare");
    expect(testsslResults([], "app.example.com", true)).toEqual([
      expect.objectContaining({ status: "pass", target: "app.example.com (Cloudflare's edge)" }),
    ]);
  });

  it("turns a WARN or FATAL (a problem with the scan) into a skip with the reason", () => {
    const results = testsslResults(
      [
        { id: "scanProblem", severity: "FATAL", finding: "Can't connect to 'app.example.com:443'" },
        { id: "service", severity: "WARN", finding: "Couldn't determine the protocol" },
      ],
      "app.example.com",
      false,
    );
    expect(results.map((r) => [r.status, r.message])).toEqual([
      ["skip", "testssl.sh could not test this fully: Can't connect to 'app.example.com:443'"],
      ["skip", "testssl.sh could not test this fully: Couldn't determine the protocol"],
    ]);
  });

  it("runs the pinned image per hostname, keeping only its JSON file", async () => {
    const { docker, calls } = fakeDocker(() => ok(TESTSSL));
    const result = await runTestssl(docker, "app.example.com", PINS, { edge: false });
    expect(calls).toEqual([
      {
        args: [
          "run",
          "--rm",
          "--name",
          expect.stringMatching(/^opscrew-testssl-[0-9a-f]{12}$/),
          "--entrypoint",
          "/bin/sh",
          PINS.testssl,
          "-c",
          'testssl.sh "$@" > /dev/null; cat /tmp/testssl.json',
          "testssl",
          "--quiet",
          "--warnings",
          "batch",
          "--color",
          "0",
          "--connect-timeout",
          "10",
          "--jsonfile-pretty",
          "/tmp/testssl.json",
          "-p",
          "-S",
          "-h",
          "app.example.com:443",
        ],
        timeoutMs: 120_000,
      },
    ]);
    expect(result).toMatchObject({ tool: "testssl", version: "3.2.4" });
    expect(result.results[0]).toMatchObject({ id: "cert_chain_of_trust" });
  });

  it("skips a refused connection (a FATAL scan) and a timed-out one", async () => {
    // What testssl.sh 3.2 writes when it cannot connect.
    const fatal = JSON.stringify({
      version: "3.2.4 ",
      scanResult: [
        {
          id: "scanProblem",
          severity: "FATAL",
          finding:
            "Can't connect to 'app.example.com:443' Make sure a firewall is not between you and your scanning target!",
        },
      ],
      scanTime: "Scan interrupted",
    });
    const refused = await runTestssl(fakeDocker(() => ok(fatal)).docker, "app.example.com", PINS, {
      edge: false,
    });
    expect(refused.results).toEqual([
      expect.objectContaining({ status: "skip", target: "app.example.com" }),
    ]);

    const stuck = fakeDocker((args) =>
      args[0] === "rm" ? ok() : { exitCode: 137, stdout: "", stderr: "", timedOut: true },
    );
    const slow = await runTestssl(stuck.docker, "app.example.com", PINS, { edge: true });
    expect(stuck.calls.map((c) => c.args.slice(0, 4))).toEqual([
      ["run", "--rm", "--name", stuck.calls[0]?.args[3]],
      ["rm", "-f", stuck.calls[0]?.args[3]],
    ]);
    expect(slow.results).toEqual([
      expect.objectContaining({
        status: "skip",
        message: expect.stringContaining("within 2 minutes"),
        target: "app.example.com (Cloudflare's edge)",
      }),
    ]);
    expect(slow.version).toBe("3.2");
  });
});

describe("localDockerProblem", () => {
  it("says when Docker is missing or not running, with how to enable it", async () => {
    const missing: LocalDocker = {
      run: async () => {
        throw new Error("Could not run docker: it is not installed or not on PATH.");
      },
    };
    expect(await localDockerProblem(missing)).toEqual({
      message: expect.stringContaining("Docker is not installed on this computer"),
      remediation: expect.stringContaining("Install Docker Desktop"),
    });
    const stopped = fakeDocker(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
    }));
    expect(await localDockerProblem(stopped.docker)).toEqual({
      message: expect.stringContaining("its engine is not running"),
      remediation: expect.stringContaining("Start Docker Desktop"),
    });
    expect(stopped.calls[0]?.args).toEqual(["version", "--format", "{{.Server.Version}}"]);
    expect(await localDockerProblem(fakeDocker(() => ok("29.8.2\n")).docker)).toBeUndefined();
  });
});
