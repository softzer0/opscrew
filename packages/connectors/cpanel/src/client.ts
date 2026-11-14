import type { HostingPanelAccess } from "@opscrew/contracts";
import {
  type ErrorCode,
  fetchText,
  httpsOrigin,
  isRecord,
  OpsCrewError,
  type PanelClientOptions,
  parseAnswer,
  Redactor,
} from "@opscrew/core";
import { z } from "zod";

const TOKEN_HINT =
  "Make an API token in cPanel under Security → Manage API Tokens, then set OPSCREW_HOSTING_TOKEN to it.";
const ADDRESS_HINT =
  "Check that OPSCREW_HOSTING_URL is the panel's address (https://<host>:2083), then try again.";
const REFUSAL_HINT = "Fix what cPanel names, then run the command again.";

/**
 * A call cPanel refused, with its own reason. cPanel answers HTTP 200 for these: UAPI with
 * `status: 0`, API2 with `event.result: 0`, an `error`, or a `data[]` item whose `result` (or
 * Cron's `status`) is 0, also when `event.result` is 1 (research R10).
 */
export class CpanelRefusal extends OpsCrewError {
  /** cPanel's reason, redacted. */
  readonly reason: string;

  constructor(message: string, reason: string) {
    super("PROVIDER_ERROR", message, { hint: REFUSAL_HINT });
    this.name = "CpanelRefusal";
    this.reason = reason;
  }
}

/** One call: its module and function, its parameters and the schema of its answer's `data`. */
export interface CpanelCall<S extends z.ZodType> {
  module: string;
  func: string;
  params?: Readonly<Record<string, string>>;
  /** What the call does, to end "… when trying to <what>" in errors. */
  what: string;
  /** A change: a UAPI one is sent as a POST form, and a lost answer says it may have been made. */
  write?: boolean;
  schema: S;
}

/** Typed calls to one cPanel account; every answer is validated and no error shows the token. */
export interface CpanelClient {
  /** UAPI (`/execute/<Module>/<function>`): a read by GET, a change (`write`) as a POST form. */
  uapi<S extends z.ZodType>(call: CpanelCall<S>): Promise<z.output<S>>;
  /** API2 (`/json-api/cpanel`, `cpanel_jsonapi_apiversion=2`), as a POST form. */
  api2<S extends z.ZodType>(call: CpanelCall<S>): Promise<z.output<S>>;
  /**
   * `Fileman::upload_files`: the file into `dir` (an absolute path, made when missing), replacing
   * a file of the same name, with `permissions` (`0600`).
   */
  upload(input: {
    dir: string;
    file: { name: string; content: Uint8Array };
    permissions: string;
    what: string;
  }): Promise<void>;
  /** Registers a secret with the client's redactor, so no error shows it. */
  registerSecret(value: string, label: string): void;
}

/** cPanel's 0 or 1, as a number or a string. */
export const flag = z.union([z.number(), z.string()]).transform(Number);

const UapiResultSchema = z.object({
  status: flag,
  data: z.unknown(),
  errors: z.array(z.string()).nullish(),
});
/** cPanel documents the result inside `result`; the spikes read either form. */
const UapiAnswerSchema = z.union([
  z.object({ result: UapiResultSchema }).transform((answer) => answer.result),
  UapiResultSchema,
]);

const Api2AnswerSchema = z.object({
  cpanelresult: z.object({
    data: z.unknown(),
    event: z.object({ result: flag }).optional(),
    error: z.string().nullish(),
  }),
});

const UploadSchema = z.object({
  uploads: z
    .array(z.object({ file: z.string().optional(), status: flag, reason: z.string().nullish() }))
    .default([]),
  failed: flag.default(0),
});

/**
 * The client for one cPanel account, authenticated with `Authorization: cpanel <user>:<token>`.
 * The token is registered with the redactor before any request, and every error's text passes
 * through it.
 */
export function cpanelClient(
  access: HostingPanelAccess,
  options: PanelClientOptions = {},
): CpanelClient {
  const base = httpsOrigin(access.url, "https://panel.example.com:2083");
  const user = access.user.trim();
  const token = access.token.trim();
  if (user === "") {
    throw new OpsCrewError("CREDENTIALS_MISSING", "OPSCREW_HOSTING_USER is not set.", {
      hint: "Set OPSCREW_HOSTING_USER to the cPanel account's user name.",
    });
  }
  if (token === "") {
    throw new OpsCrewError("CREDENTIALS_MISSING", "OPSCREW_HOSTING_TOKEN is not set.", {
      hint: TOKEN_HINT,
    });
  }
  const redactor = options.redactor ?? new Redactor();
  redactor.addLiteral(token, "OPSCREW_HOSTING_TOKEN");
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      "OPSCREW_HOSTING_TOKEN isn't a cPanel API token.",
      {
        hint: TOKEN_HINT,
      },
    );
  }
  const authorization = `cpanel ${user}:${token}`;

  const fail = (code: ErrorCode, message: string, hint: string) =>
    new OpsCrewError(code, redactor.redact(message), { hint: redactor.redact(hint) });

  const refusal = (what: string, reasons: readonly string[]) => {
    const reason = redactor.redact(reasons.join(" ").trim() || "no reason given");
    return new CpanelRefusal(
      redactor.redact(`cPanel refused to ${what}: ${reason.replace(/\.$/, "")}.`),
      reason,
    );
  };

  const parse = <S extends z.ZodType>(schema: S, value: unknown, what: string) =>
    parseAnswer(schema, value, "cPanel", what);

  /** Sends one request (a POST with a `body`, else a GET) and answers its JSON. */
  async function send(
    url: string,
    body: string | FormData | undefined,
    what: string,
    write: boolean,
  ): Promise<unknown> {
    const response = await fetchText(
      options.fetch,
      url,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: authorization,
          ...(typeof body === "string" && {
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        },
        ...(body !== undefined && { body }),
      },
      { service: "cPanel", what, write, timeoutMs: options.timeoutMs },
    );
    if (response.status === 401 || response.status === 403) {
      throw fail(
        "CREDENTIALS_INVALID",
        `cPanel refused the API token (HTTP ${response.status}) when trying to ${what}.`,
        `Check OPSCREW_HOSTING_USER and OPSCREW_HOSTING_TOKEN. ${TOKEN_HINT}`,
      );
    }
    if (!response.ok) {
      throw fail(
        "PROVIDER_ERROR",
        `cPanel answered HTTP ${response.status} when trying to ${what}.`,
        ADDRESS_HINT,
      );
    }
    try {
      return JSON.parse(response.text);
    } catch {
      throw fail(
        "PROVIDER_ERROR",
        `cPanel's answer wasn't JSON when trying to ${what}.`,
        ADDRESS_HINT,
      );
    }
  }

  /** UAPI's `data` after its `status` is read. */
  function uapiData(json: unknown, what: string): unknown {
    const result = parse(UapiAnswerSchema, json, what);
    if (result.status !== 1) throw refusal(what, result.errors ?? []);
    return result.data;
  }

  return {
    async uapi(call) {
      const url = `${base}/execute/${call.module}/${call.func}`;
      const query = new URLSearchParams(call.params).toString();
      const json = call.write
        ? await send(url, query, call.what, true)
        : await send(query === "" ? url : `${url}?${query}`, undefined, call.what, false);
      return parse(call.schema, uapiData(json, call.what), call.what);
    },

    async api2(call) {
      const body = new URLSearchParams({
        cpanel_jsonapi_user: user,
        cpanel_jsonapi_apiversion: "2",
        cpanel_jsonapi_module: call.module,
        cpanel_jsonapi_func: call.func,
        ...call.params,
      });
      const json = await send(
        `${base}/json-api/cpanel`,
        body.toString(),
        call.what,
        call.write === true,
      );
      const result = parse(Api2AnswerSchema, json, call.what).cpanelresult;
      const items = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
      const failed = items.find((item) => Number(item.result ?? item.status) === 0);
      if (result.event?.result === 0 || (result.error ?? "") !== "" || failed !== undefined) {
        const reason = result.error || failed?.reason || failed?.statusmsg;
        throw refusal(call.what, typeof reason === "string" ? [reason] : []);
      }
      return parse(call.schema, result.data, call.what);
    },

    async upload(input) {
      const form = new FormData();
      form.append("dir", input.dir);
      form.append("overwrite", "1");
      form.append("permissions", input.permissions);
      form.append("file-1", new Blob([Buffer.from(input.file.content)]), input.file.name);
      const json = await send(`${base}/execute/Fileman/upload_files`, form, input.what, true);
      const data = parse(UploadSchema, uapiData(json, input.what), input.what);
      const failed = data.uploads.find((upload) => upload.status !== 1);
      if (failed !== undefined || data.failed > 0) {
        throw refusal(input.what, failed?.reason ? [failed.reason] : []);
      }
    },

    registerSecret(value, label) {
      redactor.addLiteral(value, label);
    },
  };
}
