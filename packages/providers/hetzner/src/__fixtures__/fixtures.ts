import { readFileSync } from "node:fs";
import { type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { HETZNER_API_URL } from "../client";

/** Reads a JSON fixture from this directory. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
}

/** Core's fake fetch with routes relative to the Hetzner Cloud API (`/server_types?page=1`). */
export function hetznerFetch(routes: Record<string, FakeReply | FakeReply[]>) {
  return fakeFetch(routes, { base: HETZNER_API_URL });
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
