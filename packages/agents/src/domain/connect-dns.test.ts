import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it, vi } from "vitest";
import { lookupPublishedDs } from "./connect-dns";

function answering(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/dns-json" },
    });
  };
  return { fetch, calls };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("lookupPublishedDs", () => {
  it("asks Cloudflare's DNS over HTTPS for the DS records and keeps their TTL", async () => {
    const { fetch, calls } = answering({
      Status: 0,
      Question: [{ name: "example.com", type: 43 }],
      Answer: [
        { name: "example.com.", type: 43, TTL: 79123, data: "2371 13 2 abcdef0123" },
        { name: "example.com.", type: 43, TTL: 86400, data: "4012 8 2 98AB CD76" },
        { name: "example.com.", type: 46, TTL: 86400, data: "DS 13 2 86400 ignored" },
      ],
    });

    const answer = await lookupPublishedDs(fetch, "example.com");

    expect(calls).toEqual([
      {
        url: "https://cloudflare-dns.com/dns-query?name=example.com&type=DS",
        headers: { accept: "application/dns-json" },
      },
    ]);
    expect(answer).toEqual({
      records: [
        { keyTag: 2371, algorithm: 13, digestType: 2, digest: "ABCDEF0123" },
        { keyTag: 4012, algorithm: 8, digestType: 2, digest: "98ABCD76" },
      ],
      ttlSeconds: 86400,
    });
  });

  it("returns no records when none are published (or the name does not exist)", async () => {
    expect(await lookupPublishedDs(answering({ Status: 0 }).fetch, "example.com")).toEqual({
      records: [],
    });
    expect(await lookupPublishedDs(answering({ Status: 3 }).fetch, "example.com")).toEqual({
      records: [],
    });
  });

  it("stops when the resolver fails, so nothing is switched on a guess", async () => {
    const error = await failure(lookupPublishedDs(answering({ Status: 2 }).fetch, "example.com"));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "OpsCrew could not look up the DNSSEC (DS) records of example.com (the resolver answered with DNS status 2).",
    );
    expect(error.hint).toContain("does not switch nameservers");
  });

  it.each([
    ["an HTTP error", answering({ Status: 0 }, 503).fetch, "HTTP 503"],
    ["an unreadable answer", answering("<html>").fetch, "an unexpected answer"],
    [
      "a malformed DS record",
      answering({ Status: 0, Answer: [{ name: "example.com.", type: 43, TTL: 1, data: "x" }] })
        .fetch,
      "an unexpected answer",
    ],
    [
      "a network failure",
      (async () => {
        throw new TypeError("fetch failed");
      }) as FetchLike,
      "fetch failed",
    ],
  ])("stops on %s", async (_case, fetch, reason) => {
    const error = await failure(lookupPublishedDs(fetch, "example.com"));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain(reason);
  });

  it("gives up on a resolver that does not answer instead of waiting forever", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const asked: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      asked.push(ms);
      return realTimeout(1);
    });
    // Answers only by failing once the request's signal aborts.
    const silent: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("the request has no timeout"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    try {
      const error = await failure(lookupPublishedDs(silent, "example.com"));

      expect(asked).toEqual([15_000]);
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("aborted due to timeout");
      expect(error.hint).toContain("does not switch nameservers");
    } finally {
      timeout.mockRestore();
    }
  });
});
