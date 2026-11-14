import type { HostingPanelAccess } from "@opscrew/contracts";
import {
  fetchText,
  httpsOrigin,
  maybeDoneHint,
  OpsCrewError,
  type PanelClientOptions,
  parseAnswer,
  Redactor,
} from "@opscrew/core";
import { z } from "zod";
import { buildXml, parseXml } from "./xml";

/**
 * Plesk's XML API, the one remote API whose reference documents what a customer may call: the
 * `site`, `subdomain`, `database` and `webspace` operators each list "Plesk user: Administrator,
 * customer". The REST API (`/api/v2/`) accepts customers too, but its reference is generated on
 * each server and shown only to the administrator (Tools & Settings → Remote API (REST) → API
 * Reference and Playground), so no customer call of it is documented in public.
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-rest-api.79359/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-rest-api/reference.80000/
 *
 * Packets are POSTed to `/enterprise/control/agent.php` on the panel's port (8443) as `text/xml`,
 * with `KEY: <secret key>` or `HTTP_AUTH_LOGIN` and `HTTP_AUTH_PASSWD`.
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/creating-client-software/sending-request-packets.28727/
 * (and the PleskApiClient it links: https://github.com/plesk/api-examples/tree/master/php)
 */
export const PLESK_XML_API_PATH = "/enterprise/control/agent.php";

/**
 * A Plesk secret key (API key) as the XML API's create operation answers it
 * (`24f8c5e5-fcb5-bdfc-aac0-7bff0e800334`); any other token is the customer's password. REST API
 * keys are the same keys (`plesk bin secret_key` makes both).
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-secret-keys/creating-secret-keys.37131/
 */
const SECRET_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Error codes of the XML API.
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/error-codes/reduced-list-of-error-codes.33765/
 */
export const PLESK_ERRORS = {
  authenticationFailed: "1001",
  permissionDenied: "1006",
  alreadyExists: "1007",
  doesNotExist: "1013",
} as const;

/** The next step after a refused login. */
const LOGIN_HINT =
  "Check OPSCREW_HOSTING_USER (your Plesk login) and OPSCREW_HOSTING_TOKEN (its password, or a secret key made for this computer's IP address).";

/**
 * The next step when the API refuses a customer: the hosting plan's "Ability to use remote API"
 * permission (`remote_access_interface`).
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/creating-client-software/handling-errors.28729/
 * https://docs.plesk.com/en-US/obsidian/cli-win/using-command-line-utilities/service_plan_addonexe-hosting-plan-addons.66540/
 */
const PERMISSION_HINT =
  'Ask your hosting provider to allow "Ability to use remote API" in your hosting plan, and to let you manage what OpsCrew changes (websites, subdomains, databases).';

/** An operation's `result`, as every operator answers it (`resultType`, common.xsd). */
const ResultSchema = z.looseObject({
  status: z.enum(["ok", "error"]),
  errcode: z.string().optional(),
  errtext: z.string().optional(),
});
/** One `result` of an operation; the operation's own fields are read by the caller. */
export type PleskResult = z.infer<typeof ResultSchema>;

/** An empty element (`<get/>`) parses as `""`. */
const results = z.union([
  z.literal("").transform(() => []),
  z.looseObject({ result: z.array(ResultSchema).optional() }).transform((op) => op.result ?? []),
]);

/** A failure before any operation ran (a refused login, a malformed packet). */
const SystemSchema = z.looseObject({
  status: z.literal("error"),
  errcode: z.string(),
  errtext: z.string().optional(),
});

/** One request: a packet with one operation of one operator. */
export interface PleskRequest {
  /** `site`, `subdomain`, `database`, `webspace`. */
  operator: string;
  /** `get`, `add`, `del`, `add-db`, … */
  operation: string;
  /** The operation's children, in the order the schema requires. */
  body: Record<string, unknown>;
  /** What the request does, for errors: "add the hostname app.example.com". */
  what: string;
  /** A change: never retried, and a lost answer says it may have been done. */
  write: boolean;
}

/** Typed calls to Plesk's XML API; credentials never appear in an error. */
export interface PleskClient {
  /** The operation's results, ok and error alike; a failure of the whole packet throws. */
  call(request: PleskRequest): Promise<PleskResult[]>;
  /** The error for a result whose status is `error`. */
  failure(result: PleskResult, what: string): OpsCrewError;
  /** Registers a secret sent in a request (a database password), so no error shows it. */
  secret(value: string, label: string): void;
}

/** A client of the panel at `access.url` (`https://<host>:8443`), logged in as `access.user`. */
export function pleskClient(
  access: HostingPanelAccess,
  options: PanelClientOptions = {},
): PleskClient {
  const redactor = options.redactor ?? new Redactor();
  redactor.addLiteral(access.token, "OPSCREW_HOSTING_TOKEN");
  const origin = httpsOrigin(access.url, "https://panel.example.com:8443");
  const endpoint = `${origin}${PLESK_XML_API_PATH}`;
  const auth: Record<string, string> = SECRET_KEY.test(access.token)
    ? { KEY: access.token }
    : { HTTP_AUTH_LOGIN: access.user, HTTP_AUTH_PASSWD: access.token };

  const error = (code: "PROVIDER_ERROR" | "CREDENTIALS_INVALID", message: string, hint: string) =>
    new OpsCrewError(code, redactor.redact(message), { hint: redactor.redact(hint) });

  const failure = (result: PleskResult, what: string): OpsCrewError => {
    const reason = `${(result.errtext ?? "no reason given").replace(/\.$/, "")} (error ${result.errcode ?? "?"})`;
    return error(
      "PROVIDER_ERROR",
      `Plesk could not ${what}: ${reason}.`,
      result.errcode === PLESK_ERRORS.permissionDenied
        ? PERMISSION_HINT
        : "Check the account in Plesk, then try again.",
    );
  };

  return {
    failure,
    secret: (value, label) => redactor.addLiteral(value, label),
    async call(request) {
      const { operator, operation, what, write } = request;
      const packet = buildXml({ packet: { [operator]: { [operation]: request.body } } });
      const { status, ok, text } = await fetchText(
        options.fetch,
        endpoint,
        { method: "POST", headers: { "Content-Type": "text/xml", ...auth }, body: packet },
        { service: "Plesk", what, write, timeoutMs: options.timeoutMs },
      );
      const json = ok ? parseXml(text) : undefined;
      if (json === undefined) {
        throw error(
          "PROVIDER_ERROR",
          `Plesk answered HTTP ${status} without a readable packet when trying to ${what}.`,
          write
            ? maybeDoneHint("Plesk")
            : `Check that ${new URL(origin).host} is a Plesk panel and that it is running, then try again.`,
        );
      }
      const packetSchema = z.looseObject({
        packet: z.looseObject({ system: SystemSchema.optional() }),
      });
      const answer = parseAnswer(packetSchema, json, "Plesk", what).packet;
      const system = answer.system;
      if (system !== undefined) {
        if (system.errcode === PLESK_ERRORS.authenticationFailed) {
          throw error(
            "CREDENTIALS_INVALID",
            `Plesk refused the login of ${access.user}: ${system.errtext ?? "authentication failed"}.`,
            LOGIN_HINT,
          );
        }
        throw failure(system, what);
      }
      const operations = z.looseObject({ [operation]: results.optional() }).optional();
      const node = parseAnswer(operations, answer[operator], "Plesk", what);
      return node?.[operation] ?? [];
    },
  };
}
