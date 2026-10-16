import { describe, expect, it } from "vitest";
import { fakeFetch } from "./fake-fetch";

const BASE = "https://api.example.test";

describe("fakeFetch", () => {
  it("routes by the longest matching method and path prefix and records every call", async () => {
    const { fetch, calls } = fakeFetch(
      {
        "/": { status: 404, body: { message: "not found" } },
        "/servers": { body: { servers: [] } },
        "POST /servers": { status: 201, body: { server: { id: 1 } } },
        "/servers?page=2": { body: { servers: ["b"] } },
      },
      { base: BASE },
    );
    expect(await (await fetch(`${BASE}/servers?page=1`)).json()).toEqual({ servers: [] });
    expect(await (await fetch(`${BASE}/servers?page=2`)).json()).toEqual({ servers: ["b"] });
    const created = await fetch(`${BASE}/servers`, {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ name: "web" }),
    });
    expect(created.status).toBe(201);
    expect((await fetch(`${BASE}/images`)).status).toBe(404);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /servers?page=1",
      "GET /servers?page=2",
      "POST /servers",
      "GET /images",
    ]);
    expect(calls[2]).toEqual({
      method: "POST",
      url: `${BASE}/servers`,
      path: "/servers",
      headers: { Authorization: "Bearer x" },
      body: { name: "web" },
    });
  });

  it("answers a queue in order and repeats its last reply, without changing the routes", async () => {
    const queue = [{ status: 500 }, { body: { ok: true } }];
    const { fetch } = fakeFetch({ "/x": queue });
    expect((await fetch("/x")).status).toBe(500);
    expect((await fetch("/x")).status).toBe(200);
    expect((await fetch("/x")).status).toBe(200);
    expect(queue).toHaveLength(2);
  });

  it("sends raw text, extra headers, an empty 204 and a non-JSON body as given", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /xml": { text: "<ok/>", headers: { "content-type": "text/xml" } },
      "DELETE /x": { status: 204 },
      "POST /form": { body: {} },
    });
    const xml = await fetch("/xml");
    expect(await xml.text()).toBe("<ok/>");
    expect(xml.headers.get("content-type")).toBe("text/xml");
    expect(await (await fetch("/x", { method: "DELETE" })).text()).toBe("");
    await fetch("/form", { method: "POST", body: "a=1&b=2" });
    expect(calls[2]?.body).toBe("a=1&b=2");
  });

  it("throws for a lost connection and an unrouted request", async () => {
    const { fetch } = fakeFetch({ "/down": { error: new TypeError("fetch failed") } });
    await expect(fetch("/down")).rejects.toThrow("fetch failed");
    await expect(fetch("/elsewhere")).rejects.toThrow("no route for GET /elsewhere");
  });

  it("honours the abort signal, also while a reply hangs", async () => {
    const { fetch } = fakeFetch({ "/slow": { hang: true }, "/fast": { body: {} } });
    await expect(fetch("/slow", { signal: AbortSignal.timeout(5) })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(fetch("/fast", { signal: aborted.signal })).rejects.toThrow("cancelled");
  });
});
