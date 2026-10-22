import { X509Certificate } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { ensureLocalCa, issueLeaf, leafFile, leafState } from "./ca";

const now = new Date("2026-10-11T12:00:00.000Z");

describe("the leaf certificates of OpsCrew's local CA", () => {
  it("keep a long <env>.<app>.localhost in the SAN, with a common name of at most 64 characters", async () => {
    const paths = { homeDir: await mkdtemp(join(tmpdir(), "opscrew-local-ca-")) };
    const ca = await ensureLocalCa(paths, { computerName: "test", now });
    const app = "a-very-long-app-name-that-fills-most-of-4";
    const hostname = `staging-europe01.${app}.localhost`;
    expect(hostname.length).toBeGreaterThan(64);
    const leaf = new X509Certificate(issueLeaf(ca, hostname, now).certificate);
    const commonName = /CN=([^\n]+)/.exec(leaf.subject)?.[1] ?? "";
    expect(commonName.length).toBeLessThanOrEqual(64);
    expect(leaf.subjectAltName?.split(", ")).toContain(`DNS:${hostname}`);
    expect(leaf.checkIssued(new X509Certificate(ca.certificate))).toBe(true);

    // Provision keeps it: it is the leaf this hostname gets.
    const plan = { app: { name: `${app}-staging-europe01` } } as Parameters<typeof leafFile>[1];
    await writeFileAtomic(leafFile(paths, plan), leaf.toString());
    expect((await leafState(paths, plan, hostname, now)).action).toBe("keep");
    // A short hostname is its own common name, and the SAN's only name.
    const short = new X509Certificate(issueLeaf(ca, "shop.localhost", now).certificate);
    expect(short.subject).toBe("CN=shop.localhost");
    expect(short.subjectAltName).toBe("DNS:shop.localhost");
  });
});
