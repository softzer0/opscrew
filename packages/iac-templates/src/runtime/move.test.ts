// Feature 018: a live service's move between the app's servers (T1811, ADR 0022). Until the
// switch the service runs on both servers and the app keeps the old copy's address.
import { type DeployPlan, DeployPlanSchema, type Move } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { appVariables } from "../catalog";
import { withPlacement, withServices } from "../catalog/__fixtures__/plans";
import { publishedOnNetwork, renderCompose, renderServerCompose } from "./index";

type Compose = {
  services: Record<string, Record<string, unknown> & { ports?: string[]; depends_on?: object }>;
};

function services(content: string): Compose["services"] {
  return (parse(content) as Compose).services;
}

/** Postgres (`db`) and Valkey (`cache`), with the extra server `data`. */
const BASE = withServices([{ kind: "postgres" }, { kind: "valkey" }]);

/** `db` placed on `server` (absent: the app's), moving as `move` says. */
function moving(server: string | undefined, move: Omit<Move, "service" | "copy">): DeployPlan {
  const placed = withPlacement(BASE, {
    servers: { data: "hetzner" },
    placed: server === undefined ? { cache: "data" } : { db: server },
  });
  return DeployPlanSchema.parse({
    ...placed,
    move: { service: "db", copy: "dump", ...move },
  });
}

/** The app's DATABASE_URL in `plan`, with a stand-in password. */
function databaseUrl(plan: DeployPlan): string | undefined {
  const service = plan.services.find((s) => s.name === "db");
  if (service === undefined) throw new Error("no db");
  return appVariables({ plan, service, secretRef: () => "pw" }).DATABASE_URL;
}

describe("a move from the app's server to an extra server", () => {
  for (const step of ["started", "deployed"] as const) {
    it(`runs the service on both servers and keeps the app on the old copy (${step})`, () => {
      const plan = moving("data", { from: "app", to: "data", step });
      // The old copy stays in the app's project, unpublished, and the app still waits for it.
      const app = services(renderCompose(plan).content);
      expect(Object.keys(app)).toEqual(["app", "db", "cache"]);
      expect(app.db?.ports).toBeUndefined();
      expect(app.db?.volumes).toEqual(["/srv/data/shop/db:/var/lib/postgresql/data"]);
      expect(app.app?.depends_on).toEqual({
        db: { condition: "service_healthy" },
        cache: { condition: "service_healthy" },
      });
      // The new copy on data, published on its private address.
      const data = services(renderServerCompose(plan, "data").content);
      expect(Object.keys(data)).toEqual(["db"]);
      expect(data.db?.ports).toEqual(["10.200.4.2:5432:5432"]);
      expect(databaseUrl(plan)).toBe("postgresql://app:pw@db:5432/app");
    });
  }

  it("drops the old copy and points the app at the new one once switched", () => {
    const plan = moving("data", { from: "app", to: "data", step: "switched" });
    expect(Object.keys(services(renderCompose(plan).content))).toEqual(["app", "cache"]);
    expect(Object.keys(services(renderServerCompose(plan, "data").content))).toEqual(["db"]);
    expect(databaseUrl(plan)).toBe("postgresql://app:pw@10.200.4.2:5432/app");
  });
});

describe("a move from an extra server back to the app's server", () => {
  it("keeps the old copy published on the extra server and the app on its address", () => {
    const plan = moving(undefined, { from: "data", to: "app", step: "deployed" });
    // The new copy runs on the app's server, empty and unpublished.
    const app = services(renderCompose(plan).content);
    expect(Object.keys(app)).toEqual(["app", "db"]);
    expect(app.db?.ports).toBeUndefined();
    // The old copy keeps its place and port on data, next to what else runs there.
    const data = services(renderServerCompose(plan, "data").content);
    expect(Object.keys(data)).toEqual(["db", "cache"]);
    expect(data.db?.ports).toEqual(["10.200.4.2:5432:5432"]);
    expect(publishedOnNetwork(plan, "data")).toEqual([
      { service: "db", port: 5432, address: "10.200.4.2" },
      { service: "cache", port: 6379, address: "10.200.4.2" },
    ]);
    expect(publishedOnNetwork(plan, "app")).toEqual([]);
    expect(databaseUrl(plan)).toBe("postgresql://app:pw@10.200.4.2:5432/app");
  });

  it("drops the old copy from the extra server once switched", () => {
    const plan = moving(undefined, { from: "data", to: "app", step: "switched" });
    expect(Object.keys(services(renderServerCompose(plan, "data").content))).toEqual(["cache"]);
    expect(publishedOnNetwork(plan, "data")).toEqual([
      { service: "cache", port: 6379, address: "10.200.4.2" },
    ]);
    expect(databaseUrl(plan)).toBe("postgresql://app:pw@db:5432/app");
  });
});

it("renders a plan without a move as before", () => {
  const plan = withPlacement(BASE, { servers: { data: "hetzner" }, placed: { db: "data" } });
  const switched = moving("data", { from: "app", to: "data", step: "switched" });
  expect(renderCompose(switched)).toEqual(renderCompose(plan));
  expect(renderServerCompose(switched, "data")).toEqual(renderServerCompose(plan, "data"));
});
