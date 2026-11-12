/**
 * What the Contabo live test (`contabo.test.ts`, feature 026) needs besides the harness: its gate
 * and variables, the four credentials as OpsCrew reads them, what OpsCrew's output says on
 * Contabo, a failed step's wait for a fix, and the test's own reads and deletions at Contabo for
 * its checks and its cleanup. The
 * app's servers and their snapshots go through OpsCrew's connector; the firewall, SSH key and tag,
 * which the connector does not cover, and a cancel when OpsCrew's destroy failed, through
 * Contabo's API. The test never creates anything at Contabo itself, and no value of a credential
 * is ever printed.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppServer, FetchLike, ServerSnapshotApi } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { contaboConnector } from "@opscrew/provider-contabo";
import { z } from "zod";

/** The pass's gate: it runs only with `OPSCREW_E2E_CONTABO=1`. */
export const CONTABO_GATE = "OPSCREW_E2E_CONTABO";

/** Each of the test's credential variables, with the variable OpsCrew reads its value from. */
export const CONTABO_CREDENTIAL_VARIABLES = {
  OPSCREW_E2E_CONTABO_CLIENT_ID: "CNTB_OAUTH2_CLIENT_ID",
  OPSCREW_E2E_CONTABO_CLIENT_SECRET: "CNTB_OAUTH2_CLIENT_SECRET",
  OPSCREW_E2E_CONTABO_USER: "CNTB_OAUTH2_USER",
  OPSCREW_E2E_CONTABO_PASS: "CNTB_OAUTH2_PASS",
} as const;

type CredentialVariable = keyof typeof CONTABO_CREDENTIAL_VARIABLES;

/** Every variable the pass needs besides its gate. */
export const CONTABO_VARIABLES = [
  ...(Object.keys(CONTABO_CREDENTIAL_VARIABLES) as CredentialVariable[]),
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** The plan the pass buys, Cloud VPS 4, and its region (research R5). */
export const CONTABO_PLAN = "V153";
export const CONTABO_REGION = "EU";

/** The four credentials from the test's variables, under the names OpsCrew reads them from. */
export function contaboEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CONTABO_CREDENTIAL_VARIABLES).map(([variable, name]) => [
      name,
      env[variable]?.trim() ?? "",
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// What OpsCrew's output says.

/** The texts of `wanted` that `output` does not hold. */
export function unsaid(output: string, wanted: readonly string[]): string[] {
  return wanted.filter((text) => !output.includes(text));
}

/**
 * What `opscrew design` must say of the Contabo plan (US1): the price table's date, the setup fee,
 * the minimum term and that Contabo backs nothing up through OpsCrew.
 */
export function designTexts(asOf: string): string[] {
  const day = asOf.slice(0, 10);
  return [
    `Contabo's published price list dated ${day}`,
    `estimate as of ${day}`,
    "Plus a one-time setup fee of",
    "The contract runs at least 1 month; a removal ends it at the end of the term.",
    "Contabo offers no automatic backups through OpsCrew",
  ];
}

/**
 * What `opscrew destroy` must say of the app's server `app` (US2): Contabo cancels it at the end of
 * its term and bills it until then, OpsCrew shuts it down and deletes the rest at once, and its
 * disk and snapshots go with the term.
 */
export function cancelTexts(app: string): string[] {
  return [
    `Contabo does not delete the server ${app} at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.`,
    "OpsCrew shuts it down now and deletes the app's other resources",
    "Its disk and its Contabo snapshots go when the term ends",
    `Shutting the server ${app} down`,
  ];
}

/** The day destroy showed that the contract of the server `app` ends (`31 December 2026`). */
export function shownEndDate(output: string, app: string): string | undefined {
  const escaped = app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `The Contabo server ${escaped} is cancelled: its contract ends on (\\d{1,2} \\w+ \\d{4}), and Contabo bills it until then\\.`,
  ).exec(output)?.[1];
}

/** `2026-12-31` as destroy shows it, `31 December 2026`. */
export function dayText(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The id `opscrew snapshot --server` printed ("Took the snapshot <instance>:<snapshot> of …"). */
export function serverSnapshotId(output: string): string | undefined {
  return [...output.matchAll(/Took the snapshot (\S+) of the server /g)].at(-1)?.[1];
}

/** Whether a printed plan buys a Contabo server: `+ create` or `± replace` of a `contabo_instance`. */
export function createsServer(output: string): boolean {
  return /^\s*(?:\+ create|± replace)\s+\S*\bcontabo_instance\./m.test(output);
}

/**
 * The lines of provision's output that take a server over or say one is cancelled (FR-2607): a
 * first provision of a new app finds none.
 */
export function takeoverLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes("takes it over with an import") ||
        line.includes("OpsCrew cannot take back a cancelled"),
    );
}

/**
 * The provider's login caches (`files`, its `homeCacheFiles`) still under the home folder `env`
 * names, as the engine finds it (ADR 0029, D9): after a run, none may be left.
 */
export function leftLogins(
  env: Record<string, string | undefined>,
  files: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  const home =
    env.HOME ||
    env.USERPROFILE ||
    (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : "");
  return home ? files.map((file) => join(home, file)).filter((path) => exists(path)) : [];
}

// ---------------------------------------------------------------------------------------------
// Waiting for a fix (research R5): the server is paid for its month either way.

/** How long a failed step from 3 on may wait for a fix, in hours; unset or 0, it does not wait. */
export const CONTABO_PAUSE_VARIABLE = "OPSCREW_E2E_CONTABO_PAUSE_HOURS";

/** The longest wait, 25 days: the cleanup still cancels the server before its month ends. */
const MAX_PAUSE_HOURS = 600;

/** The wait {@link CONTABO_PAUSE_VARIABLE} sets, in milliseconds. */
export function pauseMs(env: Record<string, string | undefined>): number {
  const value = env[CONTABO_PAUSE_VARIABLE]?.trim() ?? "";
  if (value === "") return 0;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_PAUSE_HOURS) {
    throw new Error(
      `${CONTABO_PAUSE_VARIABLE}="${value}" is not a number of hours from 0 to ${MAX_PAUSE_HOURS}.`,
    );
  }
  return hours * 3_600_000;
}

/** What {@link untilFixed} needs besides the step; the last four stand in for the offline tests. */
export interface FixWait {
  /** The folder the files `retry` and `give-up` are created in. */
  folder: string;
  /** Until when a failed attempt waits (milliseconds since the epoch). */
  until: number;
  log: (message: string) => void;
  /** The failure as the log may show it (scrubbed). */
  describe: (error: unknown) => string;
  exists?: (path: string) => Promise<boolean>;
  remove?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** How often a failed step looks for the file `retry` or `give-up`. */
const FIX_POLL_MS = 30_000;

/**
 * Runs `body`, given the attempt's number from 1. When it fails before `until`, the step waits for
 * a fix: it logs the failure and what to do, then looks every 30 seconds for the file `retry` in
 * `folder` (deleted, then `body` runs again) or `give-up` (the failure is thrown). The failure is
 * thrown too once `until` has passed.
 */
export async function untilFixed(
  body: (attempt: number) => Promise<void>,
  wait: FixWait,
): Promise<void> {
  const { folder, until, log, describe } = wait;
  const exists =
    wait.exists ??
    ((path: string) =>
      access(path).then(
        () => true,
        () => false,
      ));
  const remove = wait.remove ?? ((path: string) => rm(path, { force: true }));
  const sleep =
    wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = wait.now ?? Date.now;
  const retry = join(folder, "retry");
  const giveUp = join(folder, "give-up");
  for (let attempt = 1; ; attempt++) {
    try {
      await body(attempt);
      return;
    } catch (error) {
      if (now() >= until) throw error;
      log(`attempt ${attempt} failed: ${describe(error)}`);
      log(
        `waiting for a fix until ${new Date(until).toISOString()}; nothing at Contabo is cancelled meanwhile. Fix the cause and rebuild the CLI, then create ${retry} to run the step again, or ${giveUp} to end the run (its cleanup cancels the server).`,
      );
      for (;;) {
        if (await exists(giveUp)) throw error;
        if (await exists(retry)) break;
        if (now() >= until) throw error;
        await sleep(FIX_POLL_MS);
      }
      await remove(retry);
      log(`running the step again (attempt ${attempt + 1})`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Contabo.

const CONTABO_API = "https://api.contabo.com";
const CONTABO_AUTH = "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";

const idSchema = z.union([z.number(), z.string()]).transform(String);
const tokenSchema = z.looseObject({ access_token: z.string().min(1), expires_in: z.number() });
/** A list answer: only each item's name is read; the rest is kept unread. */
const listSchema = z.looseObject({ data: z.array(z.looseObject({ name: z.string() })) });
/** One item's own answer (`GET <path>/{id}`), kept unread. */
const oneSchema = z.looseObject({ data: z.tuple([z.looseObject({})]) });

/**
 * One of the app's resources at Contabo: its id and name, and everything else Contabo answered,
 * unread, for the checks to narrow.
 */
export interface ContaboItem {
  id: string;
  name: string;
  fields: Record<string, unknown>;
}

/** The kinds of the app's resources at Contabo besides its servers, each by its name. */
const KINDS = {
  firewall: {
    path: "/v1/firewalls",
    idField: "firewallId",
    name: (app: string) => `${app}-firewall`,
    what: "the firewall",
  },
  secret: {
    path: "/v1/secrets",
    idField: "secretId",
    name: (app: string) => `${app}-deploy`,
    what: "the SSH key",
  },
  tag: {
    path: "/v1/tags",
    idField: "tagId",
    name: (app: string) => `opscrew-app:${app}`,
    what: "the tag",
  },
} as const;

type Kind = keyof typeof KINDS;

/**
 * The test's account at Contabo, with the credentials `env` holds under OpsCrew's names
 * ({@link contaboEnv}): nothing is called until a method runs. `fetch` stands in for the network in
 * the offline tests.
 */
export class ContaboAccount {
  #servers: ServerSnapshotApi | undefined;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly env: Record<string, string>,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  /** OpsCrew's own server API for Contabo. */
  private servers(): ServerSnapshotApi {
    this.#servers ??= contaboConnector({
      env: this.env,
      redactor: new Redactor(),
      fetch: this.fetch,
    }).servers;
    if (this.#servers === undefined) throw new Error("The four Contabo credentials are not set.");
    return this.#servers;
  }

  /** The app's servers, as OpsCrew finds them (by its tag, or by the app's name untagged). */
  appServers(app: string): Promise<AppServer[]> {
    return this.servers().findAppServers(app);
  }

  /** The app's firewall `<app>-firewall`, if Contabo has it. */
  firewall(app: string): Promise<ContaboItem | undefined> {
    return this.named("firewall", app);
  }

  /**
   * The app's SSH key `<app>-deploy`, if Contabo has it, with its value: a list answers none, only
   * the secret's own answer does (research R6).
   */
  async secret(app: string): Promise<ContaboItem | undefined> {
    const listed = await this.named("secret", app);
    if (listed === undefined) return undefined;
    const path = `${KINDS.secret.path}/${encodeURIComponent(listed.id)}`;
    const [fields] = oneSchema.parse(await this.call("GET", path)).data;
    return { ...listed, fields };
  }

  /**
   * What is left of `app` at Contabo besides its cancelled servers: a server not cancelled, its
   * firewall, SSH key and tag. Named, never with a value.
   */
  async left(app: string): Promise<string[]> {
    const left = (await this.appServers(app))
      .filter((server) => server.cancelledUntil === undefined)
      .map(
        (server) => `the server ${server.name} (id ${server.id}, ${server.status}), not cancelled`,
      );
    for (const kind of Object.keys(KINDS) as Kind[]) {
      if ((await this.named(kind, app)) !== undefined) {
        left.push(`${KINDS[kind].what} ${KINDS[kind].name(app)}`);
      }
    }
    return left;
  }

  /**
   * The cleanup at Contabo, after OpsCrew's destroy ran or failed: deletes OpsCrew's snapshots of
   * the app's servers, cancels (and shuts down) a server destroy did not cancel, deletes the
   * firewall, SSH key and tag left, and checks again. With `destroyed` (destroy finished), anything
   * it had to cancel or delete is a problem too. Two servers of the app is a problem: the test
   * never buys a second one. Returns the problems; logs what it does through `log`.
   */
  async cleanUp(
    app: string,
    destroyed: boolean,
    log: (message: string) => void,
  ): Promise<string[]> {
    const problems: string[] = [];
    const tryTo = async (what: string, body: () => Promise<void>) => {
      try {
        await body();
      } catch (error) {
        problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let servers: AppServer[] = [];
    await tryTo(`list the servers of ${app}`, async () => {
      servers = await this.appServers(app);
    });
    if (servers.length > 1) {
      problems.push(
        `Contabo has ${servers.length} servers of ${app} (ids ${servers.map((s) => s.id).join(", ")}); the test must never buy a second one`,
      );
    }
    for (const server of servers) {
      await tryTo(`delete the snapshots of the server ${server.id}`, async () => {
        for (const snapshot of await this.servers().listSnapshots(server.id)) {
          await this.servers().deleteSnapshot(snapshot.id);
          log(`deleted the snapshot ${snapshot.id} of the server ${server.name}`);
        }
      });
      if (server.cancelledUntil !== undefined) continue;
      await tryTo(`cancel the server ${server.id}`, async () => {
        log(`the server ${server.name} (id ${server.id}) is not cancelled: cancelling it`);
        await this.servers()
          .powerOff(server.id)
          .catch((error: Error) => log(`could not shut it down first: ${error.message}`));
        await this.call("POST", `/v1/compute/instances/${server.id}/cancel`, {});
        if (destroyed) {
          problems.push(
            `destroy did not cancel the server ${server.name}; the cleanup cancelled it`,
          );
        }
      });
    }
    for (const kind of Object.keys(KINDS) as Kind[]) {
      const { what, name, path } = KINDS[kind];
      await tryTo(`delete ${what} ${name(app)}`, async () => {
        const item = await this.named(kind, app);
        if (item === undefined) return;
        await this.call("DELETE", `${path}/${encodeURIComponent(item.id)}`);
        log(`deleted ${what} ${name(app)}`);
        if (destroyed) problems.push(`destroy left ${what} ${name(app)}; the cleanup deleted it`);
      });
    }
    await tryTo("check Contabo again", async () => {
      for (const thing of await this.left(app)) {
        problems.push(`Contabo still has ${thing}: remove it in Contabo's Customer Control Panel`);
      }
      for (const server of await this.appServers(app)) {
        if (server.cancelledUntil === undefined) continue;
        log(`the server ${server.name} (id ${server.id}) stays, cancelled, until its term ends`);
      }
    });
    return problems;
  }

  /** The resource of `kind` named for `app`, if Contabo has it: its id and name, the rest unread. */
  private async named(kind: Kind, app: string): Promise<ContaboItem | undefined> {
    const { path, idField, name } = KINDS[kind];
    const wanted = name(app);
    const query = new URLSearchParams({ page: "1", size: "100", name: wanted });
    const { data } = listSchema.parse(await this.call("GET", `${path}?${query}`));
    const item = data.find((entry) => entry.name === wanted);
    return item === undefined
      ? undefined
      : { id: idSchema.parse(item[idField]), name: item.name, fields: item };
  }

  /** One call to Contabo's API, with a fresh `x-request-id`; throws on an error status. */
  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    const response = await this.fetch(`${CONTABO_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "x-request-id": randomUUID(),
        Accept: "application/json",
        "User-Agent": "opscrew-e2e",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Contabo answered HTTP ${response.status} to ${method} ${path.split("?")[0]}`,
      );
    }
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  }

  /** An access token from Contabo's login (an OAuth2 password grant), kept until it expires. */
  private async token(): Promise<string> {
    if (this.#token !== undefined && Date.now() < this.#token.expiresAt) return this.#token.value;
    const response = await this.fetch(CONTABO_AUTH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: this.env.CNTB_OAUTH2_CLIENT_ID ?? "",
        client_secret: this.env.CNTB_OAUTH2_CLIENT_SECRET ?? "",
        username: this.env.CNTB_OAUTH2_USER ?? "",
        password: this.env.CNTB_OAUTH2_PASS ?? "",
      }).toString(),
    });
    if (!response.ok) throw new Error(`Contabo's login answered HTTP ${response.status}`);
    const token = tokenSchema.parse(await response.json());
    this.#token = {
      value: token.access_token,
      expiresAt: Date.now() + (token.expires_in - 30) * 1000,
    };
    return token.access_token;
  }
}
