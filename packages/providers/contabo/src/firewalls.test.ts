import type { FirewallApi, WantedFirewall, WantedFirewallRule } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CREDENTIALS_ENV, contaboFetch, fakeTime, page, param } from "./__fixtures__/fixtures";
import { contaboConnector } from "./connector";

const ID = "0f6c1d2e-0000-4000-8000-000000000001";
const OTHER_ID = "0f6c1d2e-0000-4000-8000-000000000002";
const NAME = "shop-firewall";

const WANTED: WantedFirewall = {
  name: NAME,
  description: "OpsCrew's firewall of shop.",
  serverIds: ["101"],
  rules: [
    { protocol: "tcp", ports: ["22"], ipv4: ["203.0.113.0/24"], ipv6: ["::1/128"] },
    { protocol: "tcp", ports: ["80", "443"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
    { protocol: "icmp", ports: [], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
    { protocol: "udp", ports: ["51820"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
  ],
};

/** A rule as OpsCrew sends it to Contabo. */
function sent(rule: WantedFirewallRule) {
  return {
    protocol: rule.protocol,
    destPorts: rule.ports,
    srcCidr: { ipv4: rule.ipv4, ipv6: rule.ipv6 },
    action: "accept",
    status: "active",
  };
}

/** A rule as Contabo answers it. */
function answered(rule: WantedFirewallRule) {
  return { ...sent(rule), displayName: null };
}

/** Contabo's own rule, which it appends to every firewall. */
const DROP_RULE = {
  protocol: "",
  destPorts: [],
  srcCidr: { ipv4: [], ipv6: [] },
  action: "drop",
  status: "active",
  displayName: "Block all traffic",
};

/** Server 101 as a firewall lists it. */
const INSTANCE_101 = {
  instanceId: 101,
  displayName: "shop",
  name: "vmi101",
  productId: "V153",
  ipConfig: {
    v4: { ip: "192.0.2.10", netmaskCidr: 24, gateway: "192.0.2.1" },
    v6: { ip: "2001:db8::10", netmaskCidr: 64, gateway: "fe80::1" },
  },
  regionSlug: "EU",
  regionName: "European Union",
  dataCenterSlug: "EU1",
  dataCenterName: "Nuremberg",
};

/** The wanted firewall as Contabo answers it, protecting server 101, unless `extra` differs. */
function firewall(extra: Record<string, unknown> = {}) {
  return {
    tenantId: "INT",
    customerId: "10000001",
    firewallId: ID,
    name: NAME,
    description: WANTED.description,
    status: "active",
    instanceStatus: [{ instanceId: 101, status: "ok", errorMessage: null }],
    instances: [INSTANCE_101],
    rules: { inbound: [...WANTED.rules.map(answered), DROP_RULE] },
    createdDate: "2026-11-12T10:00:00.000Z",
    updatedDate: "2026-11-12T10:00:00.000Z",
    ...extra,
  };
}

/** One firewall answered alone (`GET`, `POST`, `PUT` and `PATCH` of one firewall). */
function one(data: unknown): FakeReply {
  return { body: { data: [data], _links: { self: `/v1/firewalls/${ID}` } } };
}

/** An assignment's answer. */
const LINKS: FakeReply = { body: { _links: { self: `/v1/firewalls/${ID}/instances/101` } } };

function setup(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = contaboFetch(routes);
  const time = fakeTime();
  const connector = contaboConnector({
    env: CREDENTIALS_ENV,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: () => new Date(time.now()),
  });
  const api = connector.firewalls as FirewallApi;
  const calls = () =>
    fake.calls
      .filter((call) => !call.url.startsWith("https://auth."))
      .map((c) => `${c.method} ${c.path}`);
  const body = (route: string) =>
    fake.calls.find((call) => `${call.method} ${call.path}` === route)?.body;
  return { api, fake, calls, body, time };
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const LIST = `GET /v1/firewalls?page=1&size=100&name=${NAME}`;

describe("firewalls.sync", () => {
  it("creates a missing firewall with its rules, adds the server and waits until it is protected", async () => {
    const { api, calls, body, fake, time } = setup({
      "GET /v1/firewalls?": page([]),
      "POST /v1/firewalls": {
        status: 201,
        body: {
          data: [firewall({ instances: [], instanceStatus: [] })],
          _links: { self: `/v1/firewalls/${ID}` },
        },
      },
      [`POST /v1/firewalls/${ID}/instances/101`]: { status: 201, ...LINKS },
      [`GET /v1/firewalls/${ID}`]: [
        one(firewall({ instanceStatus: [{ instanceId: 101, status: "processing" }] })),
        one(firewall()),
      ],
    });
    expect(await api.sync(WANTED)).toEqual([
      "Created Contabo's firewall shop-firewall with 4 rules.",
      "Added server 101 to Contabo's firewall shop-firewall.",
    ]);
    expect(calls()).toEqual([
      LIST,
      "POST /v1/firewalls",
      `POST /v1/firewalls/${ID}/instances/101`,
      `GET /v1/firewalls/${ID}`,
      `GET /v1/firewalls/${ID}`,
    ]);
    expect(param(fake.calls[1], "name")).toBe(NAME);
    expect(body("POST /v1/firewalls")).toEqual({
      name: NAME,
      description: WANTED.description,
      status: "active",
      rules: { inbound: WANTED.rules.map(sent) },
    });
    expect(time.waits).toEqual([5_000]);
  });

  it("changes nothing on a firewall that is as wanted, ignoring Contabo's own rule and the order", async () => {
    const reordered = firewall({
      rules: {
        inbound: [
          DROP_RULE,
          answered({ protocol: "udp", ports: ["51820"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] }),
          answered({ protocol: "tcp", ports: ["443", "80"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] }),
          answered({ protocol: "icmp", ports: [], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] }),
          answered({ protocol: "tcp", ports: ["22"], ipv4: ["203.0.113.0/24"], ipv6: ["::1/128"] }),
        ],
      },
    });
    const { api, calls } = setup({
      "GET /v1/firewalls?": page([reordered]),
      [`GET /v1/firewalls/${ID}`]: one(reordered),
    });
    expect(await api.differences(WANTED)).toEqual([]);
    expect(await api.sync(WANTED)).toEqual([]);
    // Only reads: the list twice, and the check that the server is protected.
    expect(calls()).toEqual([LIST, LIST, `GET /v1/firewalls/${ID}`]);
  });

  it("sets the rules, the description and the status of a firewall that differs, and its servers", async () => {
    const differing = firewall({
      description: "Old.",
      status: "inactive",
      instances: "[999]",
      instanceStatus: [{ instanceId: 999, status: "ok" }],
      rules: {
        inbound: [
          answered({ protocol: "tcp", ports: ["22"], ipv4: ["203.0.113.0/24"], ipv6: ["::1/128"] }),
          answered({ protocol: "tcp", ports: ["8080"], ipv4: ["0.0.0.0/0"], ipv6: [] }),
          answered({ protocol: "tcp", ports: ["80", "443"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] }),
          answered({ protocol: "udp", ports: ["51820"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] }),
          DROP_RULE,
        ],
      },
    });
    const { api, calls, body } = setup({
      "GET /v1/firewalls?": page([differing]),
      [`PUT /v1/firewalls/${ID}`]: one(firewall()),
      [`PATCH /v1/firewalls/${ID}`]: one(firewall()),
      [`POST /v1/firewalls/${ID}/instances/101`]: { status: 201, ...LINKS },
      [`DELETE /v1/firewalls/${ID}/instances/999`]: LINKS,
      [`GET /v1/firewalls/${ID}`]: one(firewall()),
    });

    expect(await api.differences(WANTED)).toEqual([
      "Contabo's firewall shop-firewall lacks the rule ICMP from 0.0.0.0/0 and ::/0.",
      "Contabo's firewall shop-firewall has a rule OpsCrew did not write: TCP port 8080 from 0.0.0.0/0 and any IPv6 address.",
      `The description of Contabo's firewall shop-firewall is "Old.", not "OpsCrew's firewall of shop.".`,
      "Contabo's firewall shop-firewall is inactive, so it filters nothing.",
      "Contabo's firewall shop-firewall does not protect server 101.",
      "Contabo's firewall shop-firewall also protects server 999.",
    ]);
    expect(calls()).toEqual([LIST]);

    expect(await api.sync(WANTED)).toEqual([
      "Added the rule ICMP from 0.0.0.0/0 and ::/0 to Contabo's firewall shop-firewall.",
      "Removed the rule TCP port 8080 from 0.0.0.0/0 and any IPv6 address from Contabo's firewall shop-firewall.",
      "Set the description of Contabo's firewall shop-firewall.",
      "Turned on Contabo's firewall shop-firewall.",
      "Added server 101 to Contabo's firewall shop-firewall.",
      "Removed server 999 from Contabo's firewall shop-firewall.",
    ]);
    expect(calls().slice(1)).toEqual([
      LIST,
      `PUT /v1/firewalls/${ID}`,
      `PATCH /v1/firewalls/${ID}`,
      `POST /v1/firewalls/${ID}/instances/101`,
      `DELETE /v1/firewalls/${ID}/instances/999`,
      `GET /v1/firewalls/${ID}`,
    ]);
    // Every wanted rule, and never Contabo's own.
    expect(body(`PUT /v1/firewalls/${ID}`)).toEqual({ rules: { inbound: WANTED.rules.map(sent) } });
    expect(body(`PATCH /v1/firewalls/${ID}`)).toEqual({
      description: WANTED.description,
      status: "active",
    });
  });

  it.each([
    ["a list of objects", [INSTANCE_101]],
    ["a list of numbers", [101]],
    ["a JSON-encoded string", "[101]"],
  ])(
    "reads the servers when Contabo answers them as %s, and their statuses too",
    async (_, instances) => {
      const read = firewall({
        instances,
        instanceStatus: JSON.stringify([{ instanceId: 101, status: "ok" }]),
      });
      const { api, calls } = setup({
        "GET /v1/firewalls?": page([read]),
        [`GET /v1/firewalls/${ID}`]: one(read),
      });
      expect(await api.sync(WANTED)).toEqual([]);
      expect(calls()).toEqual([LIST, `GET /v1/firewalls/${ID}`]);
    },
  );

  it.each([
    ["the documented body", { status: 201, ...LINKS }, LINKS],
    ["no body", { status: 204 }, { status: 204 }],
  ])("adds and removes servers when Contabo answers with %s", async (_, assigned, unassigned) => {
    const { api } = setup({
      "GET /v1/firewalls?": page([firewall({ instances: [999], instanceStatus: [] })]),
      [`POST /v1/firewalls/${ID}/instances/101`]: assigned,
      [`DELETE /v1/firewalls/${ID}/instances/999`]: unassigned,
      [`GET /v1/firewalls/${ID}`]: one(firewall()),
    });
    expect(await api.sync(WANTED)).toEqual([
      "Added server 101 to Contabo's firewall shop-firewall.",
      "Removed server 999 from Contabo's firewall shop-firewall.",
    ]);
  });

  it("uses only the firewall with the exact name, since Contabo's name filter matches substrings", async () => {
    const { api, calls } = setup({
      "GET /v1/firewalls?": page([firewall({ firewallId: OTHER_ID, name: `${NAME}-db` })]),
    });
    expect(await api.differences(WANTED)).toEqual(["Contabo has no firewall named shop-firewall."]);
    expect(await api.remove(NAME)).toBe(false);
    expect(calls()).toEqual([LIST, LIST]);
  });

  it("stops plainly when a server is not protected within the wait", async () => {
    const processing = firewall({
      instanceStatus: [{ instanceId: 101, status: "processing", errorMessage: null }],
    });
    const { api, time } = setup({
      "GET /v1/firewalls?": page([processing]),
      [`GET /v1/firewalls/${ID}`]: one(processing),
    });
    const error = await failure(api.sync(WANTED));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "Contabo's firewall shop-firewall did not protect server 101 (processing) within 10 minutes.",
    );
    expect(error.hint).toContain("Customer Control Panel");
    expect(time.waits.reduce((sum, ms) => sum + ms, 0)).toBe(600_000);
  });

  it("stops plainly when Contabo fails to protect a server, with its reason", async () => {
    const failed = firewall({
      instanceStatus: [
        { instanceId: 101, status: "error_processing", errorMessage: "rules could not be set" },
      ],
    });
    const { api } = setup({
      "GET /v1/firewalls?": page([failed]),
      [`GET /v1/firewalls/${ID}`]: one(failed),
    });
    const error = await failure(api.sync(WANTED));
    expect(error.message).toBe(
      "Contabo's firewall shop-firewall could not protect server 101 (error_processing): rules could not be set",
    );
  });

  it("refuses an empty source list, which Contabo reads as any source, and a server id that is not one", async () => {
    const { api, fake } = setup({});
    const open = await failure(
      api.sync({
        ...WANTED,
        rules: [{ protocol: "tcp", ports: ["22"], ipv4: [], ipv6: ["::1/128"] }],
      }),
    );
    expect(open.code).toBe("INVALID_INPUT");
    expect(open.message).toContain("Contabo reads an empty list as any source");
    const odd = await failure(api.sync({ ...WANTED, serverIds: ["../101"] }));
    expect(odd.code).toBe("INVALID_INPUT");
    expect(fake.calls).toEqual([]);
  });

  it("stops before any change when two firewalls have the name", async () => {
    const { api, calls } = setup({
      "GET /v1/firewalls?": page([firewall(), firewall({ firewallId: OTHER_ID, description: "" })]),
    });
    const error = await failure(api.sync(WANTED));
    expect(error.message).toBe("Contabo has 2 firewalls named shop-firewall.");
    expect(error.hint).toContain("Customer Control Panel");
    await failure(api.remove(NAME));
    expect(calls()).toEqual([LIST, LIST]);
  });

  it("reports a refusal through the client's errors, without the credentials", async () => {
    const { api } = setup({
      "GET /v1/firewalls?": page([firewall({ description: "Old." })]),
      [`PATCH /v1/firewalls/${ID}`]: {
        status: 422,
        body: { statusCode: 422, message: [`not allowed for ${CREDENTIALS_ENV.CNTB_OAUTH2_USER}`] },
      },
    });
    const error = await failure(api.sync(WANTED));
    expect(error.message).toContain(`Contabo answered HTTP 422 to PATCH /v1/firewalls/${ID}`);
    expect(error.message).not.toContain(CREDENTIALS_ENV.CNTB_OAUTH2_USER);
  });
});

describe("firewalls.remove", () => {
  it("removes every server the firewall with the exact name protects, then deletes it", async () => {
    const { api, calls } = setup({
      "GET /v1/firewalls?": page([
        firewall({ firewallId: OTHER_ID, name: `${NAME}-db` }),
        // Server 102 is listed only in the statuses.
        firewall({
          instances: "[101]",
          instanceStatus: [
            { instanceId: 101, status: "ok" },
            { instanceId: 102, status: "processing" },
          ],
        }),
      ]),
      // The documented answer, and an empty one.
      [`DELETE /v1/firewalls/${ID}/instances/101`]: LINKS,
      [`DELETE /v1/firewalls/${ID}/instances/102`]: { status: 204 },
      [`DELETE /v1/firewalls/${ID}`]: { status: 204 },
    });
    expect(await api.remove(NAME)).toBe(true);
    expect(calls()).toEqual([
      LIST,
      `DELETE /v1/firewalls/${ID}/instances/101`,
      `DELETE /v1/firewalls/${ID}/instances/102`,
      `DELETE /v1/firewalls/${ID}`,
    ]);
  });

  it("deletes a firewall that protects no server at once", async () => {
    const { api, calls } = setup({
      "GET /v1/firewalls?": page([firewall({ instances: [], instanceStatus: "[]" })]),
      [`DELETE /v1/firewalls/${ID}`]: { status: 204 },
    });
    expect(await api.remove(NAME)).toBe(true);
    expect(calls()).toEqual([LIST, `DELETE /v1/firewalls/${ID}`]);
  });

  it("deletes nothing when there is none", async () => {
    const { api, calls } = setup({ "GET /v1/firewalls?": page([]) });
    expect(await api.remove(NAME)).toBe(false);
    expect(calls()).toEqual([LIST]);
  });
});
