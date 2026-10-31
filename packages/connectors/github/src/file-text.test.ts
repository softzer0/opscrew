import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const ROUTE = "GET /repos/acme/shop/contents/opscrew/plan.yaml";
const COMMIT = "c".repeat(40);
/** A plan with a non-ASCII character, as UTF-8 must keep it. */
const PLAN = "app:\n  name: Café shop\n  services:\n    - web\n";

const fakeFetch = (routes: Record<string, FakeReply>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

/** The contents API's answer for a file: base64 wrapped at 60 characters, as GitHub sends it. */
function fileAnswer(text: string, extra: Record<string, unknown> = {}) {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return {
    type: "file",
    name: "plan.yaml",
    path: "opscrew/plan.yaml",
    sha: "d".repeat(40),
    size: Buffer.byteLength(text),
    encoding: "base64",
    content: `${base64.match(/.{1,60}/g)?.join("\n")}\n`,
    ...extra,
  };
}

const client = (fetch: ReturnType<typeof fakeFetch>["fetch"]) =>
  new GitHubClient({ token: TOKEN, fetch });

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  const opsError = error as OpsCrewError;
  const text = `${opsError.message} ${opsError.hint ?? ""} ${JSON.stringify(error)}`;
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("Café");
  expect(text).not.toContain(Buffer.from(PLAN, "utf8").toString("base64").slice(0, 20));
  return opsError;
}

describe("fileText", () => {
  it("reads the file's UTF-8 text at the commit", async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: { body: fileAnswer(PLAN) } });
    expect(await client(fetch).fileText("acme", "shop", "opscrew/plan.yaml", COMMIT)).toBe(PLAN);
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/acme/shop/contents/opscrew/plan.yaml?ref=${COMMIT}`,
    );
  });

  it("is undefined when GitHub has no such file at that commit (404)", async () => {
    const { fetch } = fakeFetch({ [ROUTE]: { status: 404, body: { message: "Not Found" } } });
    expect(
      await client(fetch).fileText("acme", "shop", "opscrew/plan.yaml", COMMIT),
    ).toBeUndefined();
  });

  it("refuses plainly a file over 1 MB, whose text GitHub does not send", async () => {
    const { fetch } = fakeFetch({
      [ROUTE]: { body: fileAnswer("", { size: 2_500_000, encoding: "none", content: "" }) },
    });
    const error = await failure(
      client(fetch).fileText("acme", "shop", "opscrew/plan.yaml", COMMIT),
    );
    expect(error.message).toContain("opscrew/plan.yaml");
    expect(error.message).toContain("1 MB");
  });

  it("refuses an encoding it can't read, as GitHub's fault", async () => {
    const { fetch } = fakeFetch({
      [ROUTE]: { body: fileAnswer(PLAN, { encoding: "none", content: "" }) },
    });
    const error = await failure(
      client(fetch).fileText("acme", "shop", "opscrew/plan.yaml", COMMIT),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("an answer OpsCrew can't read");
  });

  it("refuses a path that is not a file inside the repository before any request", async () => {
    const { fetch, calls } = fakeFetch({});
    for (const path of ["../x", "", "/etc/passwd", "opscrew//plan.yaml", "./plan.yaml", "a/.."]) {
      const text = await failure(client(fetch).fileText("acme", "shop", path, COMMIT));
      expect(text.code).toBe("INVALID_INPUT");
      const sha = await failure(client(fetch).fileSha("acme", "shop", path, COMMIT));
      expect(sha.code).toBe("INVALID_INPUT");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an answer that is not a file without putting its content in the error", async () => {
    const { fetch } = fakeFetch({ [ROUTE]: { body: fileAnswer(PLAN, { type: "symlink" }) } });
    const error = await failure(
      client(fetch).fileText("acme", "shop", "opscrew/plan.yaml", COMMIT),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
  });
});
