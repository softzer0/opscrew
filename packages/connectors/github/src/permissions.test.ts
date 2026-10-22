import { OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const READ_TOKEN = fakeSecret("github-token", "ghcr-read");
const API = "/repos/acme/shop";
const GHCR = "GET https://ghcr.io/v2/acme/shop/manifests";
const DIGEST = `sha256:${"c".repeat(64)}`;
const credential = { username: "deployer", token: READ_TOKEN };

/**
 * What a call gives: a named permission in the hint, the generic hint, GHCR's hint, a precondition
 * (`PHASE_PRECONDITION`), or a value.
 */
type Outcome = { permission: string } | "generic" | "ghcr" | "precondition" | "undefined";

interface Row {
  method: string;
  /** The route the 403 or 404 answers. */
  route: string;
  call: (client: GitHubClient) => Promise<unknown>;
  /** Routes that answer normally around it. */
  around?: Record<string, FakeReply>;
  /** With `x-accepted-github-permissions: administration=write`. */
  withHeader: Outcome;
  withoutHeader: Outcome;
  notFound: Outcome;
}

const ADMIN_WRITE = { permission: "Administration: Read and write" };
const ADMIN_READ = { permission: "Administration: Read" };
const ENVIRONMENTS = { permission: "Environments: Read and write" };
const ME = { "GET /user": { body: { login: "octocat", id: 1 } } };
const PULL = { "GET https://ghcr.io/token": { body: { token: fakeSecret("generic-password") } } };

async function publicKey(): Promise<{ keyId: string; key: string }> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return { keyId: "k1", key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL) };
}

const ROWS: Row[] = [
  {
    method: "putEnvironment",
    route: `PUT ${API}/environments/staging`,
    call: (c) => c.putEnvironment("acme", "shop", "staging", {}),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_WRITE,
    notFound: "generic",
  },
  {
    method: "getEnvironment",
    route: `GET ${API}/environments/staging`,
    call: (c) => c.getEnvironment("acme", "shop", "staging"),
    withHeader: ADMIN_WRITE,
    withoutHeader: "generic",
    notFound: "undefined",
  },
  {
    method: "deleteEnvironment",
    route: `DELETE ${API}/environments/staging`,
    call: (c) => c.deleteEnvironment("acme", "shop", "staging"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_WRITE,
    notFound: "undefined",
  },
  {
    method: "environmentCapability",
    route: `${API}/environments/opscrew-probe`,
    call: (c) => c.environmentCapability("acme", "shop", "opscrew-probe", "main"),
    around: ME,
    withHeader: ADMIN_WRITE,
    withoutHeader: "generic",
    notFound: "generic",
  },
  {
    method: "environmentPublicKey",
    route: `GET ${API}/environments/staging/secrets/public-key`,
    call: (c) => c.environmentPublicKey("acme", "shop", "staging"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ENVIRONMENTS,
    notFound: "generic",
  },
  {
    method: "setEnvironmentSecret",
    route: `PUT ${API}/environments/staging/secrets/OPSCREW_HOST`,
    call: async (c) =>
      c.setEnvironmentSecret("acme", "shop", "staging", "OPSCREW_HOST", "x", await publicKey()),
    withHeader: ADMIN_WRITE,
    withoutHeader: ENVIRONMENTS,
    notFound: "generic",
  },
  {
    method: "deleteEnvironmentSecret",
    route: `DELETE ${API}/environments/staging/secrets/OPSCREW_HOST`,
    call: (c) => c.deleteEnvironmentSecret("acme", "shop", "staging", "OPSCREW_HOST"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ENVIRONMENTS,
    notFound: "undefined",
  },
  {
    method: "runnerRegistrationToken",
    route: `POST ${API}/actions/runners/registration-token`,
    call: (c) => c.runnerRegistrationToken("acme", "shop"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_WRITE,
    notFound: "generic",
  },
  {
    method: "runnerRemoveToken",
    route: `POST ${API}/actions/runners/remove-token`,
    call: (c) => c.runnerRemoveToken("acme", "shop"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_WRITE,
    notFound: "generic",
  },
  {
    method: "listRunners",
    route: `GET ${API}/actions/runners`,
    call: (c) => c.listRunners("acme", "shop"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_READ,
    notFound: "generic",
  },
  {
    method: "deleteRunner",
    route: `DELETE ${API}/actions/runners/23`,
    call: (c) => c.deleteRunner("acme", "shop", 23),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_WRITE,
    notFound: "undefined",
  },
  {
    method: "repositoryVisibility",
    route: `GET ${API}`,
    call: (c) => c.repositoryVisibility("acme", "shop"),
    withHeader: ADMIN_WRITE,
    withoutHeader: "generic",
    notFound: "generic",
  },
  {
    method: "forkPrApprovalPolicy",
    route: `GET ${API}/actions/permissions/fork-pr-contributor-approval`,
    call: (c) => c.forkPrApprovalPolicy("acme", "shop"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_READ,
    notFound: "generic",
  },
  {
    method: "setForkPrApprovalPolicy",
    route: `PUT ${API}/actions/permissions/fork-pr-contributor-approval`,
    call: (c) => c.setForkPrApprovalPolicy("acme", "shop", "all_external_contributors"),
    withHeader: ADMIN_WRITE,
    withoutHeader: ADMIN_WRITE,
    notFound: "generic",
  },
  {
    method: "dispatchWorkflow",
    route: `POST ${API}/actions/workflows/opscrew-deploy.yml/dispatches`,
    call: (c) => c.dispatchWorkflow("acme", "shop", "opscrew-deploy.yml", "main"),
    withHeader: ADMIN_WRITE,
    withoutHeader: "generic",
    notFound: "precondition",
  },
  {
    method: "fileSha",
    route: `GET ${API}/contents/.github/workflows/opscrew-deploy.yml?ref=main`,
    call: (c) => c.fileSha("acme", "shop", ".github/workflows/opscrew-deploy.yml", "main"),
    withHeader: ADMIN_WRITE,
    withoutHeader: "generic",
    notFound: "undefined",
  },
  {
    method: "workflowRun",
    route: `GET ${API}/actions/runs/1`,
    call: (c) => c.workflowRun("acme", "shop", 1),
    withHeader: ADMIN_WRITE,
    withoutHeader: "generic",
    notFound: "undefined",
  },
  {
    method: "taggedDigest",
    route: `${GHCR}/opscrew-prod`,
    call: (c) => c.taggedDigest("acme", "shop", "opscrew-prod", credential),
    around: PULL,
    withHeader: "ghcr",
    withoutHeader: "ghcr",
    notFound: "undefined",
  },
  {
    method: "imageProvenance",
    route: `${GHCR}/${DIGEST}`,
    call: (c) => c.imageProvenance("acme", "shop", DIGEST, credential),
    around: PULL,
    withHeader: "ghcr",
    withoutHeader: "ghcr",
    notFound: "undefined",
  },
];

const ANSWERS: Record<"withHeader" | "withoutHeader" | "notFound", FakeReply> = {
  withHeader: {
    status: 403,
    body: { message: "Resource not accessible by personal access token" },
    headers: { "x-accepted-github-permissions": "administration=write" },
  },
  withoutHeader: { status: 403, body: { message: "Resource not accessible by integration" } },
  notFound: { status: 404, body: { message: "Not Found" } },
};

describe("every call's answer to a 403 with the permission header, a 403 without, and a 404", () => {
  for (const row of ROWS) {
    for (const answer of ["withHeader", "withoutHeader", "notFound"] as const) {
      const expected = row[answer];
      const label = typeof expected === "string" ? expected : expected.permission;
      it(`${row.method}, ${answer}: ${label}`, async () => {
        const { fetch } = fakeFetch(
          { ...row.around, [row.route]: ANSWERS[answer] },
          { base: GITHUB_API },
        );
        const result = row.call(new GitHubClient({ token: TOKEN, fetch }));
        if (expected === "undefined") {
          await expect(result).resolves.toBeUndefined();
          return;
        }
        const error = await result.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpsCrewError);
        const { code, message, hint = "" } = error as OpsCrewError;
        expect(`${message} ${hint}`).not.toContain(TOKEN);
        expect(`${message} ${hint}`).not.toContain(READ_TOKEN);
        expect(code).toBe(
          expected === "precondition" ? "PHASE_PRECONDITION" : "CREDENTIALS_INVALID",
        );
        if (expected === "precondition") return;
        if (expected === "generic") expect(hint).toContain("Secrets: Read and write");
        else if (expected === "ghcr") expect(hint).toContain("OPSCREW_GHCR_READ_TOKEN");
        else expect(hint).toContain(`Give the token ${expected.permission} on this repository`);
      });
    }
  }
});
