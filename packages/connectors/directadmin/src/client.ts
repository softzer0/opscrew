import type { FetchLike, HostingPanelAccess } from "@opscrew/contracts";
import {
  changedApiHint,
  fetchText,
  httpsOrigin,
  OpsCrewError,
  type PanelClientOptions,
  parseAnswer,
  Redactor,
} from "@opscrew/core";
import { z } from "zod";

/*
 * DirectAdmin's two APIs, both with HTTP basic auth and a login key as the password
 * (https://docs.directadmin.com/developer/api/):
 * - the JSON API under `/api/…`, specified in OpenAPI 2.0 at `/static/swagger.json` on every
 *   server (read from https://demo.directadmin.com:2222/static/swagger.json on 2026-11-12); errors
 *   are a JSON object with a `type` (`UNAUTHORIZED`, `ACCESS_DENIED`, `NOT_FOUND`, …);
 * - the legacy `/CMD_API_*` calls, which answer URL-encoded values: `error=0|1&text=…&details=…`
 *   for an action and `list[]=…` for a list
 *   (https://docs.directadmin.com/developer/api/legacy-api.html). Their `json=yes` form has no
 *   documented shape, so the documented URL-encoded answers are what this client reads.
 */

/** Where the user makes the login key OpsCrew uses, as a next step. */
const LOGIN_KEY_HINT =
  "In DirectAdmin, open Login Keys, create a key for OpsCrew that may call the API, then set OPSCREW_HOSTING_TOKEN to it and OPSCREW_HOSTING_USER to the account's user name.";

/** A JSON API error answer: its HTTP status, its `type` and the file manager's reasons. */
export class DirectAdminApiError extends OpsCrewError {
  constructor(
    code: "CREDENTIALS_INVALID" | "PROVIDER_ERROR",
    readonly status: number,
    /** The answer's `type` (`NOT_FOUND`, `ALREADY_EXISTS`, …), when it had one. */
    readonly type: string | undefined,
    /** The file manager's `reason` for each path (`NOT_FOUND`, `ALREADY_EXISTS`, …). */
    readonly reasons: readonly string[],
    message: string,
    hint: string,
  ) {
    super(code, message, { hint });
    this.name = "DirectAdminApiError";
  }
}

const errorBodySchema = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  path: z.string().optional(),
  reason: z.string().optional(),
  output: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
});

type Method = "GET" | "POST" | "DELETE";

/** An answer as {@link fetchText} reads it. */
type Answer = Awaited<ReturnType<typeof fetchText>>;

/** One JSON API request. */
interface JsonCall<S extends z.ZodType> {
  /** What OpsCrew was doing, after "to" ("list the account's databases"). */
  what: string;
  method: Method;
  path: string;
  query?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /** The success answer; `z.undefined()` for a 204. */
  schema: S;
  timeoutMs?: number;
}

/**
 * Typed requests to one DirectAdmin account. Every failure is an `OpsCrewError` whose text has
 * the login key and every registered secret masked.
 */
export class DirectAdminClient {
  readonly user: string;
  private readonly origin: string;
  private readonly authorization: string;
  private readonly fetch: FetchLike | undefined;
  private readonly redactor: Redactor;
  private readonly timeoutMs: number | undefined;

  constructor(access: HostingPanelAccess, options: PanelClientOptions = {}) {
    this.origin = httpsOrigin(access.url, "https://panel.example.com:2222");
    this.user = access.user;
    this.redactor = options.redactor ?? new Redactor();
    this.redactor.addLiteral(access.token, "OPSCREW_HOSTING_TOKEN");
    this.authorization = `Basic ${Buffer.from(`${access.user}:${access.token}`).toString("base64")}`;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs;
  }

  /** Registers a secret sent in a request (a database password) so no error can show it. */
  addSecret(value: string, label: string): void {
    this.redactor.addLiteral(value, label);
  }

  /** A JSON API call; its success answer validated against `call.schema`. */
  async json<S extends z.ZodType>(call: JsonCall<S>): Promise<z.output<S>> {
    const response = await this.send(call.what, call.method, call.path, call.query, {
      ...(call.body === undefined
        ? {}
        : { body: JSON.stringify(call.body), contentType: "application/json" }),
      ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
    });
    const text = response.text;
    if (!response.ok) throw this.apiError(response.status, text, call.what);
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw this.unexpected(call.what, "an answer that is not JSON");
    }
    return parseAnswer(call.schema, json, "DirectAdmin", call.what);
  }

  /**
   * Uploads one file with the file manager (`POST /api/filemanager-actions/upload`, multipart,
   * swagger.json): `dir` must exist; `perm` is octal with a leading zero ("0600").
   */
  async upload(
    what: string,
    target: { dir: string; name: string; perm: string },
    content: Uint8Array,
  ): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(content)]), target.name);
    const response = await this.send(
      what,
      "POST",
      "/api/filemanager-actions/upload",
      { dir: target.dir, name: target.name, perm: target.perm, overwrite: "false" },
      { body: form },
    );
    if (!response.ok) throw this.apiError(response.status, response.text, what);
  }

  /**
   * A file's bytes as text (`GET /api/filemanager/download`, swagger.json), or undefined when the
   * answer is 404 (no such file).
   */
  async download(what: string, path: string): Promise<string | undefined> {
    const response = await this.send(what, "GET", "/api/filemanager/download", { path });
    if (response.status === 404) return undefined;
    if (!response.ok) throw this.apiError(response.status, response.text, what);
    return response.text;
  }

  /**
   * A legacy `/CMD_API_*` call: a GET with `params` in the query, or a POST with them as a form.
   * Its URL-encoded answer, after `error=1` became an error.
   */
  async legacy(
    what: string,
    command: string,
    method: "GET" | "POST",
    params: Record<string, string>,
  ): Promise<URLSearchParams> {
    const response =
      method === "GET"
        ? await this.send(what, "GET", `/${command}`, params)
        : await this.send(what, "POST", `/${command}`, undefined, {
            body: new URLSearchParams(params).toString(),
            contentType: "application/x-www-form-urlencoded",
          });
    const text = response.text;
    if (response.status === 401) throw this.rejected(what);
    if (!response.ok) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `DirectAdmin could not ${what} (HTTP ${response.status}).`,
        { hint: this.statusHint(response.status) },
      );
    }
    if (text.trimStart().startsWith("<")) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `DirectAdmin answered with a web page instead of the API's answer when asked to ${what}.`,
        {
          hint: `Check that OPSCREW_HOSTING_URL is DirectAdmin's address (port 2222) and that the login key may call ${command}.`,
        },
      );
    }
    const answer = new URLSearchParams(text);
    if (answer.get("error") === "1") {
      const detail = [answer.get("text"), answer.get("details")]
        .map((part) => plain(part ?? ""))
        .filter((part) => part !== "")
        .join(": ");
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        this.redactor.redact(`DirectAdmin could not ${what}${detail === "" ? "" : `: ${detail}`}.`),
        { hint: "Fix what DirectAdmin reports, in the panel if needed, then try again." },
      );
    }
    return answer;
  }

  private async send(
    what: string,
    method: Method,
    path: string,
    query: Record<string, string> | undefined,
    options: { body?: string | FormData; contentType?: string; timeoutMs?: number } = {},
  ): Promise<Answer> {
    const url = new URL(path, this.origin);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const headers: Record<string, string> = { Authorization: this.authorization };
    if (options.contentType !== undefined) headers["Content-Type"] = options.contentType;
    return fetchText(
      this.fetch,
      url.toString(),
      { method, headers, ...(options.body === undefined ? {} : { body: options.body }) },
      {
        service: "DirectAdmin",
        what,
        write: method !== "GET",
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
      },
    );
  }

  private rejected(what: string): DirectAdminApiError {
    return new DirectAdminApiError(
      "CREDENTIALS_INVALID",
      401,
      "UNAUTHORIZED",
      [],
      `DirectAdmin rejected the login key for ${this.user} (OPSCREW_HOSTING_TOKEN) when asked to ${what}.`,
      LOGIN_KEY_HINT,
    );
  }

  private unexpected(what: string, problem: string): OpsCrewError {
    return new OpsCrewError(
      "PROVIDER_ERROR",
      `DirectAdmin returned ${problem} when trying to ${what}.`,
      { hint: changedApiHint("DirectAdmin") },
    );
  }

  private apiError(status: number, text: string, what: string): DirectAdminApiError {
    if (status === 401) return this.rejected(what);
    let body: z.infer<typeof errorBodySchema> = {};
    try {
      const parsed = errorBodySchema.safeParse(JSON.parse(text));
      if (parsed.success) body = parsed.data;
    } catch {
      // Not JSON: the status alone is reported.
    }
    const reasons = body.errors?.map((error) => error.reason) ?? (body.reason ? [body.reason] : []);
    const details = [
      body.type,
      body.message,
      body.output,
      ...(body.errors ?? []).map((error) => `${error.path} ${error.reason}`),
      ...(body.reason === undefined ? [] : [`${body.path ?? ""} ${body.reason}`.trim()]),
    ]
      .map((part) => plain(part ?? ""))
      .filter((part) => part !== "")
      .join(", ");
    const suffix = details === "" ? "" : `: ${details}`;
    const message =
      status === 403
        ? `DirectAdmin refused to ${what}: the login key may not do this (HTTP 403)${suffix}.`
        : `DirectAdmin could not ${what} (HTTP ${status})${suffix}.`;
    return new DirectAdminApiError(
      "PROVIDER_ERROR",
      status,
      body.type,
      reasons,
      this.redactor.redact(message),
      this.statusHint(status),
    );
  }

  private statusHint(status: number): string {
    if (status === 403) {
      return "Allow this command for the login key in DirectAdmin's Login Keys, or ask your host to enable the feature for your account, then try again.";
    }
    if (status >= 500) return "Try again in a minute; if it keeps failing, ask your host.";
    return "Check the request in DirectAdmin and try again; if it keeps failing, please report it to OpsCrew.";
  }
}

/** A panel message as one plain line: tags dropped, spaces collapsed, at most 300 characters. */
function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
