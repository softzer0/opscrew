import type { CloudflareDnsRecord } from "@opscrew/connector-cloudflare";
import { FAKE_ZONE_ID } from "@opscrew/connector-cloudflare/testing";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { fakeCloudflare, MemoryReporter, opscrewRecord } from "../../testing";
import {
  pagesHostnames,
  requireCaaAllowsLetsEncrypt,
  requirePagesAllowed,
  requirePagesHostnames,
} from "./checks";

const COMMAND = "opscrew provision";
const deps = { redactor: new Redactor() };

/** The error `check` stopped with. */
async function stop(check: Promise<void>): Promise<OpsCrewError> {
  const error = await check.then(() => undefined).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

function hostnames(records: CloudflareDnsRecord[], domain: string, www = false) {
  return requirePagesHostnames(deps, {
    api: fakeCloudflare({ records }),
    zoneId: FAKE_ZONE_ID,
    zone: "example.com",
    hostnames: pagesHostnames({ domain, www }),
    owner: "Example-Org",
    command: COMMAND,
  });
}

/** OpsCrew's own DNS-only record. */
const own = (name: string, type: string, content: string) =>
  opscrewRecord(name, type, content, { proxied: false });

describe("requirePagesHostnames", () => {
  it("passes the site's own DNS-only records and other records at the apex", async () => {
    await hostnames(
      [
        own("docs.example.com", "CNAME", "example-org.github.io"),
        own("example.com", "TXT", "v=spf1 -all"),
      ],
      "docs.example.com",
    );
    await hostnames(
      [
        own("example.com", "A", "185.199.110.153"),
        own("example.com", "AAAA", "2606:50c0:8003::153"),
        own("example.com", "MX", "mail.example.com"),
        own("www.example.com", "CNAME", "example-org.github.io"),
      ],
      "example.com",
      true,
    );
  });

  it("refuses a record proxied by Cloudflare, naming it", async () => {
    const error = await stop(
      hostnames(
        [opscrewRecord("docs.example.com", "CNAME", "example-org.github.io")],
        "docs.example.com",
      ),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("changed nothing");
    expect(error.message).toContain(
      "CNAME docs.example.com example-org.github.io (proxied by Cloudflare)",
    );
    expect(error.hint).toContain("stops GitHub from issuing and renewing the site's certificate");
    expect(error.hint).toContain(`run \`${COMMAND}\` again`);
  });

  it("refuses another record at the site's hostnames", async () => {
    const server = await stop(hostnames([own("example.com", "A", "203.0.113.10")], "example.com"));
    expect(server.message).toContain("A example.com 203.0.113.10");
    const besideCname = await stop(
      hostnames(
        [
          own("docs.example.com", "CNAME", "example-org.github.io"),
          own("docs.example.com", "TXT", "site-verification"),
        ],
        "docs.example.com",
      ),
    );
    expect(besideCname.message).toContain("TXT docs.example.com site-verification");
    expect(besideCname.message).not.toContain("CNAME docs.example.com");
  });

  it("checks www next to the apex", async () => {
    const error = await stop(
      hostnames([own("www.example.com", "CNAME", "other.example.net")], "example.com", true),
    );
    expect(error.message).toContain("CNAME www.example.com other.example.net");
  });
});

function caa(records: CloudflareDnsRecord[], domain: string, www = false) {
  return requireCaaAllowsLetsEncrypt(deps, {
    api: fakeCloudflare({ records }),
    zoneId: FAKE_ZONE_ID,
    zone: "example.com",
    hostnames: pagesHostnames({ domain, www }),
    command: COMMAND,
  });
}

const caaRecord = (name: string, content: string): CloudflareDnsRecord => ({
  id: `caa-${name}-${content}`,
  type: "CAA",
  name,
  content,
  ttl: 1,
});

describe("requireCaaAllowsLetsEncrypt", () => {
  it("passes without CAA records, and with one that allows Let's Encrypt", async () => {
    await caa([], "docs.example.com");
    await caa(
      [
        caaRecord("example.com", '0 issue "digicert.com"'),
        caaRecord("example.com", '0 issue "letsencrypt.org; validationmethods=dns-01"'),
      ],
      "docs.example.com",
    );
    // Only `issue` decides for the site's names, not `issuewild` or `iodef`.
    await caa(
      [
        caaRecord("example.com", '0 issuewild "digicert.com"'),
        caaRecord("example.com", '0 iodef "mailto:security@example.com"'),
      ],
      "example.com",
    );
  });

  it("refuses a CAA record on the domain that doesn't allow Let's Encrypt, naming the record", async () => {
    const error = await stop(
      caa([caaRecord("example.com", '0 issue "digicert.com"')], "docs.example.com"),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("could not get the site's certificate from Let's Encrypt");
    expect(error.message).toContain('CAA example.com 0 issue "digicert.com"');
    expect(error.message).toContain("changed nothing");
    expect(error.hint).toContain('0 issue "letsencrypt.org"');
  });

  it("lets the closest name with CAA records decide", async () => {
    // The subdomain's own records allow Let's Encrypt, so the apex's do not count for it.
    await caa(
      [
        caaRecord("example.com", '0 issue "digicert.com"'),
        caaRecord("docs.example.com", '0 issue "letsencrypt.org"'),
      ],
      "docs.example.com",
    );
    const error = await stop(
      caa([caaRecord("docs.example.com", '0 issue ";"')], "docs.example.com"),
    );
    expect(error.message).toContain('CAA docs.example.com 0 issue ";"');
  });

  it("checks www's records too", async () => {
    const error = await stop(
      caa([caaRecord("www.example.com", '0 issue "digicert.com"')], "example.com", true),
    );
    expect(error.message).toContain("CAA www.example.com");
  });
});

describe("requirePagesAllowed", () => {
  const repository = { owner: "example-org", repo: "example-app" };

  it("refuses a private repository whose plan has no GitHub Pages", async () => {
    const reporter = new MemoryReporter();
    const error = await stop(
      requirePagesAllowed({ reporter }, { pagesAllowed: async () => "no" }, repository),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("GitHub Pages is not available for example-org/example-app");
    expect(error.message).toContain("Nothing was changed.");
    expect(error.hint).toContain("Make the repository public");
  });

  it("goes on when GitHub does not say, telling that its first step may be refused", async () => {
    const reporter = new MemoryReporter();
    await requirePagesAllowed({ reporter }, { pagesAllowed: async () => "unknown" }, repository);
    expect(reporter.text()).toContain("GitHub refuses the Pages plan's first step");
    await requirePagesAllowed({ reporter }, { pagesAllowed: async () => "yes" }, repository);
  });
});
