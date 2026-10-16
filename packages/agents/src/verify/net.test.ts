import type { LookupAddress } from "node:dns";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { defaultTlsConnect, nodeFetchWithLookup, publicAnswerLookup } from "./net";

const notFound = (host: string) =>
  Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });

/** This computer's resolver: knows only `known`, says ENOTFOUND for every other name. */
function systemLookup(known: Record<string, string> = {}): LookupFunction & { asked: string[] } {
  const asked: string[] = [];
  const lookup = ((host, options, callback) => {
    asked.push(host);
    const address = known[host];
    process.nextTick(() => {
      if (address === undefined) callback(notFound(host), "", 0);
      else if (options.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    });
  }) as LookupFunction & { asked: string[] };
  lookup.asked = asked;
  return lookup;
}

function ask(lookup: LookupFunction, host: string, options: object) {
  return new Promise<{ error?: NodeJS.ErrnoException; address: unknown; family?: number }>(
    (resolve) =>
      lookup(host, options, (error, address, family) =>
        resolve({ ...(error ? { error } : {}), address, ...(family ? { family } : {}) }),
      ),
  );
}

describe("publicAnswerLookup", () => {
  const answers = new Map([["shop.example.com", { ipv4: ["192.0.2.10"], ipv6: ["2001:db8::10"] }]]);

  it("asks this computer first and keeps its answer", async () => {
    const system = systemLookup({ "shop.example.com": "198.51.100.1" });
    const lookup = publicAnswerLookup(answers, system);
    expect(await ask(lookup, "shop.example.com", { all: true })).toEqual({
      address: [{ address: "198.51.100.1", family: 4 }],
    });
    expect(system.asked).toEqual(["shop.example.com"]);
  });

  it("answers from the public answer when this computer finds no such name", async () => {
    const lookup = publicAnswerLookup(answers, systemLookup());
    expect(await ask(lookup, "Shop.Example.com.", { all: true })).toEqual({
      address: [
        { address: "192.0.2.10", family: 4 },
        { address: "2001:db8::10", family: 6 },
      ] satisfies LookupAddress[],
    });
    expect(await ask(lookup, "shop.example.com", {})).toEqual({
      address: "192.0.2.10",
      family: 4,
    });
    expect(await ask(lookup, "shop.example.com", { family: 6 })).toEqual({
      address: "2001:db8::10",
      family: 6,
    });
  });

  it("keeps this computer's error for other names and for a family the public answer lacks", async () => {
    const lookup = publicAnswerLookup(
      new Map([["shop.example.com", { ipv4: ["192.0.2.10"], ipv6: [] }]]),
      systemLookup(),
    );
    expect((await ask(lookup, "other.example.com", { all: true })).error?.code).toBe("ENOTFOUND");
    expect((await ask(lookup, "shop.example.com", { family: 6 })).error?.code).toBe("ENOTFOUND");
  });
});

describe("nodeFetchWithLookup", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function listen(
    handler: (
      path: string,
      headers: IncomingHttpHeaders,
    ) => {
      status: number;
      headers?: Record<string, string | undefined>;
      body?: string;
    },
  ): Promise<number> {
    const server = createServer((request, response) => {
      const answer = handler(request.url ?? "/", request.headers);
      const headers = Object.entries(answer.headers ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      );
      response.writeHead(answer.status, Object.fromEntries(headers));
      response.end(answer.body ?? "");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("connects to the address the lookup gives while the request keeps the host name", async () => {
    const hosts: string[] = [];
    const port = await listen((path, headers) => {
      hosts.push(String(headers.host));
      if (path === "/old") return { status: 308, headers: { location: "/" } };
      return { status: 200, headers: { "x-content-type-options": "nosniff" }, body: "hello" };
    });
    const lookup = publicAnswerLookup(
      new Map([["shop.example.test", { ipv4: ["127.0.0.1"], ipv6: [] }]]),
      systemLookup(),
    );
    const fetch = nodeFetchWithLookup(lookup);

    const followed = await fetch(`http://shop.example.test:${port}/old`, { redirect: "follow" });
    expect(followed.status).toBe(200);
    expect(followed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await followed.text()).toBe("hello");

    const manual = await fetch(`http://shop.example.test:${port}/old`, { redirect: "manual" });
    expect(manual.status).toBe(308);
    expect(manual.headers.get("location")).toBe("/");
    await manual.body?.cancel();

    expect(hosts).toEqual([
      `shop.example.test:${port}`,
      `shop.example.test:${port}`,
      `shop.example.test:${port}`,
    ]);
  });

  it("fails like fetch when the name is not found, and honours the abort signal", async () => {
    const fetch = nodeFetchWithLookup(publicAnswerLookup(new Map(), systemLookup()));
    const error = await fetch("http://nowhere.example.test/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOTFOUND");

    const port = await listen(() => ({ status: 200 }));
    const lookup = publicAnswerLookup(
      new Map([["shop.example.test", { ipv4: ["127.0.0.1"], ipv6: [] }]]),
      systemLookup(),
    );
    await expect(
      nodeFetchWithLookup(lookup)(`http://shop.example.test:${port}/`, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it("sends the real host name as the TLS server name (SNI), for fetch and the certificate reader", async () => {
    const names: string[] = [];
    const server = createTlsServer({
      SNICallback: (name, callback) => {
        names.push(name);
        callback(new Error("no certificate here"));
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const lookup = publicAnswerLookup(
        new Map([["shop.example.test", { ipv4: ["127.0.0.1"], ipv6: [] }]]),
        systemLookup(),
      );
      await expect(
        nodeFetchWithLookup(lookup)(`https://shop.example.test:${port}/`),
      ).rejects.toThrow();
      await expect(
        defaultTlsConnect("shop.example.test", { port, timeoutMs: 5000, lookup }),
      ).rejects.toThrow();
      expect(names).toEqual(["shop.example.test", "shop.example.test"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
