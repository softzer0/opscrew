import { readFileSync } from "node:fs";
import { type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { DIGITALOCEAN_API_URL } from "../client";

/** Reads a JSON fixture from this directory. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
}

/** Core's fake fetch with routes relative to the DigitalOcean API (`/v2/sizes?page=1`). */
export function digitaloceanFetch(routes: Record<string, FakeReply | FakeReply[]>) {
  return fakeFetch(routes, { base: DIGITALOCEAN_API_URL });
}

/** A query parameter of a recorded call. */
export function param(call: { url: string } | undefined, name: string): string | null {
  return call === undefined ? null : new URL(call.url).searchParams.get(name);
}

/** Records requested sleeps without waiting. */
export function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/** A clock that advances by every recorded sleep, for polling tests. */
export function fakeClock(startMs = Date.UTC(2026, 9, 12, 10, 0, 0)) {
  let current = startMs;
  const waits: number[] = [];
  return {
    waits,
    now: () => current,
    sleep: async (ms: number) => {
      waits.push(ms);
      current += ms;
    },
  };
}

/** An action document in the shape of `GET /v2/actions/{id}`. */
export function action(id: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    action: {
      id,
      status,
      type: "snapshot",
      started_at: "2026-10-12T10:00:00Z",
      completed_at: status === "completed" ? "2026-10-12T10:20:00Z" : null,
      resource_id: 3164444,
      resource_type: "droplet",
      region_slug: "fra1",
      region: { slug: "fra1" },
      ...extra,
    },
  };
}
