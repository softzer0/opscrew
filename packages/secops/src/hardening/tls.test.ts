import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { runHostChecks } from "./checks";
import { serviceHostChecks } from "./services";
import {
  certbotFailureCommand,
  certificateHostChecks,
  originHostChecks,
  parseCertbotFailure,
  parseServerHandshake,
  renewalAdvice,
  serverHandshakeCommand,
} from "./tls";

const NOW = new Date("2026-10-21T12:00:00Z");
const KEY = generateP256().privateKey;

/** A certificate whose issuer is `issuer` (self-signed), valid for `days` from now. */
function certificate(issuer: string, days: number): string {
  return selfSignedClientCertificate({ key: KEY, commonName: issuer, days, now: NOW });
}

const ORIGIN_CA = "CloudFlare Origin SSL ECC Certificate Authority";

/** `openssl s_client`'s output: connected, the server's certificate, then what followed. */
function sClient(pem: string | undefined, after = ""): string {
  return [
    "CONNECTED(00000003)",
    "---",
    ...(pem === undefined
      ? ["no peer certificate available"]
      : ["Server certificate", pem.trim(), `issuer=CN=${ORIGIN_CA}`]),
    "---",
    after,
  ].join("\n");
}

const CADDY_REFUSED = sClient(
  certificate(ORIGIN_CA, 5475),
  "40B7:error:0A00045C:SSL routines:ssl3_read_bytes:tlsv13 alert certificate required:../ssl/record/rec_layer_s3.c:908:SSL alert number 116",
);
const NGINX_REFUSED = sClient(
  certificate(ORIGIN_CA, 5475),
  "HTTP/1.1 400 Bad Request\r\nServer: nginx\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html>\r\n<head><title>400 No required SSL certificate was sent</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<center>No required SSL certificate was sent</center>\r\n</body>\r\n</html>",
);

/** A shell on the server answering each command from `answer`. */
function shell(answer: (command: string) => CommandResult) {
  const commands: string[] = [];
  const remote: RemoteExec = {
    host: "203.0.113.10",
    async run(command) {
      commands.push(command);
      return answer(command);
    },
  };
  return { remote, commands };
}

const out = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, stdout, stderr: "" });

describe("the origin check from the server (FR-1402, FR-1404, FR-1423)", () => {
  it("runs openssl s_client to 127.0.0.1:443 with each hostname's SNI and no client certificate", () => {
    expect(serverHandshakeCommand("shop.example.com", true)).toBe(
      "printf 'GET / HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n' 'shop.example.com' | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername 'shop.example.com' -tls1_3 -ign_eof 2>&1",
    );
    expect(serverHandshakeCommand("shop.example.com", false)).toBe(
      "timeout 15 openssl s_client -connect 127.0.0.1:443 -servername 'shop.example.com' -tls1_3 </dev/null 2>&1",
    );
    expect(parseServerHandshake(NGINX_REFUSED)).toEqual({
      connected: true,
      certificate: { issuer: `CN=${ORIGIN_CA}`, validTo: expect.stringMatching(/^2041-/) },
      status: 400,
      clientCertificateMissing: true,
      certificateRequired: false,
    });
  });

  it.each([
    ["Caddy, which refuses the handshake", CADDY_REFUSED],
    ["nginx, which completes it and answers HTTP 400", NGINX_REFUSED],
  ])("counts a refusal by %s as refused, and checks the issuer", async (_proxy, refused) => {
    const { remote, commands } = shell((command) =>
      command.includes("unknown.opscrew.invalid")
        ? out("CONNECTED(00000003)\nerror:0A000458:SSL routines::tlsv1 unrecognized name\n", 1)
        : out(refused, 1),
    );
    const results = await runHostChecks(remote, originHostChecks(["shop.example.com"]));
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["origin-tls-shop.example.com", "pass"],
      ["origin-unknown-hostname", "pass"],
    ]);
    expect(results[0]?.message).toBe(
      "shop.example.com refuses connections without Cloudflare's client certificate and serves the app's Cloudflare origin certificate.",
    );
    expect(commands[0]).toContain("-servername 'shop.example.com'");
    expect(commands[1]).toContain("-servername 'unknown.opscrew.invalid'");
  });

  it("fails a hostname that answers without the client certificate, or with another issuer", async () => {
    const open = sClient(certificate(ORIGIN_CA, 5475), "HTTP/1.1 200 OK\r\n\r\nhello");
    const appBadRequest = sClient(certificate(ORIGIN_CA, 5475), "HTTP/1.1 400 Bad Request\r\n");
    const acme = sClient(certificate("R13", 80), "tlsv13 alert certificate required");
    const answers = [open, appBadRequest, acme];
    const { remote } = shell(() => out(answers.shift() ?? "", 0));
    const checks = originHostChecks(["shop.example.com"]).slice(0, 1);
    const [answered] = await runHostChecks(remote, checks);
    expect(answered).toMatchObject({
      status: "fail",
      severity: "high",
      message:
        "shop.example.com answers on the server without Cloudflare's client certificate (HTTP 200), so a request that reaches the server around Cloudflare gets the app.",
    });
    // A 400 of the app's own is not nginx's refusal.
    expect((await runHostChecks(remote, checks))[0]).toMatchObject({ status: "fail" });
    expect((await runHostChecks(remote, checks))[0]).toMatchObject({
      status: "fail",
      severity: "medium",
      message:
        "shop.example.com is served with a certificate from CN=R13, not with the app's Cloudflare origin certificate.",
    });
  });

  it("fails an unknown hostname the proxy accepts, and warns when it cannot check", async () => {
    const answers = [
      out(sClient(certificate("R13", 80))),
      out("bash: line 1: openssl: command not found\n", 127),
      out("connect:errno=111\n", 1),
    ];
    const { remote } = shell(() => answers.shift() ?? out("", 1));
    const [unknown] = originHostChecks(["shop.example.com"]).slice(1);
    const run = async () => (await runHostChecks(remote, unknown ? [unknown] : []))[0];
    expect(await run()).toMatchObject({
      status: "fail",
      message:
        "The server's proxy accepts a TLS connection for unknown.opscrew.invalid, a hostname no site on it serves.",
    });
    expect(await run()).toMatchObject({
      status: "warn",
      message:
        "openssl is not installed on the server, so OpsCrew could not check the proxy's TLS from there.",
    });
    expect(await run()).toMatchObject({
      status: "warn",
      message: "OpsCrew could not connect to the server's proxy on 127.0.0.1:443.",
    });
  });

  it("warns, never passes, when the certificate is served and the connection is reset or ends", async () => {
    const answers = [
      sClient(certificate(ORIGIN_CA, 5475), "read:errno=104"),
      sClient(certificate(ORIGIN_CA, 5475), "closed"),
    ];
    const { remote } = shell(() => out(answers.shift() ?? "", 1));
    const checks = originHostChecks(["shop.example.com"]).slice(0, 1);
    for (let i = 0; i < 2; i++) {
      expect((await runHostChecks(remote, checks))[0]).toMatchObject({
        status: "warn",
        message:
          "The connection to shop.example.com on the server ended without showing that the proxy requires Cloudflare's client certificate (no refusal and no answer came).",
      });
    }
  });

  it("has no checks without hostnames", () => {
    expect(originHostChecks([])).toEqual([]);
  });
});

describe("the certificates of DNS-only hostnames (FR-1406, FR-1445)", () => {
  const renewal = renewalAdvice(
    "nginx",
    { project: "opscrew-edge" },
    "Some challenges have failed.",
  );

  it.each<[number, string, string]>([
    [60, "pass", "is valid until"],
    [29, "warn", "(29 days left) and has not been renewed"],
    [-1, "fail", "expired on"],
  ])("with %i days left: %s", async (days, status, text) => {
    const pem = certificate("R13", days + 1);
    const now = new Date(NOW.getTime() + 3_600_000);
    const { remote } = shell(() => out(sClient(days < 0 ? certificate("R13", 0) : pem)));
    const [checked] = await runHostChecks(
      remote,
      certificateHostChecks(["shop.example.com"], { now, renewal }),
    );
    expect(checked).toMatchObject({ id: "certificate-shop.example.com", status });
    expect(checked?.message).toContain(text);
    if (status !== "pass") {
      expect(checked?.remediation).toBe(
        "certbot renews certificates 45 days before they expire, so its renewal is failing: certbot's last renewal said: Some challenges have failed. Check that the hostname's DNS record points to the server and that port 80 reaches it; certbot tries again every 12 hours.",
      );
    }
  });

  it("says what to do on Caddy, and on nginx without certbot's reason", () => {
    expect(renewalAdvice("caddy", { project: "opscrew-edge" })).toContain(
      "`docker compose -p opscrew-edge logs caddy`",
    );
    expect(renewalAdvice("nginx", { project: "opscrew-edge" })).toContain(
      "read why with `docker compose -p opscrew-edge logs certbot` on the server",
    );
  });
});

describe("certbot's last renewal", () => {
  it("reads only certbot's lines about the app's certificate, and its reason when the last run failed", () => {
    const command = certbotFailureCommand("opscrew-edge", "shop");
    expect(command).toContain("label=com.docker.compose.service=certbot");
    expect(command).toContain(
      "grep -E '^(Processing .*/renewal/shop\\.conf|Failed to renew certificate shop with error: )'",
    );
    expect(
      parseCertbotFailure(
        "Failed to renew certificate shop with error: Some challenges have failed.\n",
        "shop",
      ),
    ).toBe("Some challenges have failed.");
    // The run after a failure began again and did not fail.
    expect(parseCertbotFailure("Processing /etc/letsencrypt/renewal/shop.conf\n", "shop")).toBe(
      undefined,
    );
    expect(parseCertbotFailure("", "shop")).toBeUndefined();
    expect(
      parseCertbotFailure("Failed to renew certificate blog with error: nope\n", "shop"),
    ).toBeUndefined();
  });
});

describe("Valkey refuses a request without its password (FR-1450)", () => {
  const VALKEY = {
    name: "cache",
    title: "Valkey",
    login: ["VALKEY_PASSWORD"],
    ping: "valkey-cli PING",
  };

  it.each<[string, CommandResult, string]>([
    ["NOAUTH", out("NOAUTH Authentication required.\n"), "pass"],
    ["PONG", out("PONG\n"), "fail"],
    ["no running container", out("", 1), "warn"],
  ])("%s", async (_case, answer, status) => {
    const { remote, commands } = shell((command) =>
      command.includes("docker exec") ? answer : out("VALKEY_PASSWORD\n"),
    );
    const results = await runHostChecks(remote, serviceHostChecks("shop", [VALKEY]));
    expect(results.find((r) => r.id === "service-cache-auth")).toMatchObject({ status });
    const ping = commands.find((c) => c.includes("docker exec")) ?? "";
    expect(ping).toContain("label=com.docker.compose.service=cache");
    expect(ping).toContain('docker exec "$id" valkey-cli PING');
  });
});
