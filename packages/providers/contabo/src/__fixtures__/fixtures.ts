import { readFileSync } from "node:fs";
import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { CONTABO_API_URL, CONTABO_AUTH_URL } from "../client";

/** Reads a JSON fixture from this directory. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
}

/** The four credentials, synthetic, by environment variable. */
export const CREDENTIALS_ENV = {
  CNTB_OAUTH2_CLIENT_ID: fakeSecret("generic-password", "cntb-client-id"),
  CNTB_OAUTH2_CLIENT_SECRET: fakeSecret("generic-password", "cntb-client-secret"),
  CNTB_OAUTH2_USER: fakeSecret("generic-password", "cntb-user"),
  CNTB_OAUTH2_PASS: fakeSecret("generic-password", "cntb-pass"),
} as const;

/** The same credentials as the client takes them. */
export const CREDENTIALS = {
  clientId: CREDENTIALS_ENV.CNTB_OAUTH2_CLIENT_ID,
  clientSecret: CREDENTIALS_ENV.CNTB_OAUTH2_CLIENT_SECRET,
  user: CREDENTIALS_ENV.CNTB_OAUTH2_USER,
  password: CREDENTIALS_ENV.CNTB_OAUTH2_PASS,
};

/** The route of Contabo's login. */
export const LOGIN = `POST ${CONTABO_AUTH_URL}`;

/** Contabo's login answering with the access token `value`, valid for `expiresIn` seconds. */
export function token(value: string, expiresIn = 300): FakeReply {
  return {
    body: {
      access_token: value,
      expires_in: expiresIn,
      refresh_expires_in: 1800,
      refresh_token: `refresh-${value}`,
      token_type: "Bearer",
      scope: "openid",
    },
  };
}

/**
 * Core's fake fetch with routes relative to Contabo's API (`/v1/compute/instances?page=1`) and a
 * login answering `access-1` unless `routes` sets {@link LOGIN}.
 */
export function contaboFetch(routes: Record<string, FakeReply | FakeReply[]>) {
  return fakeFetch({ [LOGIN]: token("access-1"), ...routes }, { base: CONTABO_API_URL });
}

/** A list answer of one page. */
export function page(data: unknown[]): { body: unknown } {
  return {
    body: { data, _links: {}, _pagination: { size: 100, totalElements: data.length, totalPages: 1, page: 1 } },
  };
}

/** An instance answer (`GET /v1/compute/instances/{id}`) in `status`. */
export function instance(
  id: number,
  status: string,
  extra: Record<string, unknown> = {},
): { body: unknown } {
  return {
    body: {
      data: [{ instanceId: id, name: `vmi${id}`, displayName: "shop", status, cancelDate: "", ...extra }],
      _links: { self: `/v1/compute/instances/${id}` },
    },
  };
}

/** A query parameter of a recorded call. */
export function param(call: { url: string } | undefined, name: string): string | null {
  return call === undefined ? null : new URL(call.url).searchParams.get(name);
}

/** A clock that the recorded sleeps move forward, so waits time out as they would. */
export function fakeTime(start = Date.parse("2026-11-11T10:00:00Z")) {
  let time = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}
