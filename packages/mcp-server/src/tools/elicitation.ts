import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { approvalRequestLines } from "@opscrew/agents";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalKind,
  ApprovalRequest,
  Clock,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";

/** How long OpsCrew waits for the user to answer one dialog. */
export const ELICITATION_TIMEOUT_MS = 30 * 60_000;

/** `_meta` that makes Claude Code ask for permission on every call, even in auto modes. */
export const REQUIRES_USER = { "anthropic/requiresUserInteraction": true } as const;

/** Per-call context the SDK passes to a tool callback (what the dialogs use). */
export interface CallExtra {
  requestId?: string | number;
  signal?: AbortSignal;
}

/** True when the connected client declared form-mode MCP elicitation. */
export function clientSupportsElicitation(server: McpServer): boolean {
  const elicitation = server.server.getClientCapabilities()?.elicitation;
  if (elicitation === undefined) return false;
  // An empty capability object means form mode (backwards compatibility).
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/**
 * Stops a change before anything runs when the client cannot show the approval dialog: through
 * MCP only the user approves, in a dialog, never the model. `terminal` is the command to run.
 */
export function requireDialogs(server: McpServer, terminal: string): void {
  if (clientSupportsElicitation(server)) return;
  throw new OpsCrewError(
    "APPROVAL_REFUSED",
    "This MCP client cannot show OpsCrew's approval dialog (MCP elicitation), so OpsCrew will not apply the plan. Nothing was changed.",
    {
      hint: `Ask the user to review the plan and run \`${terminal}\` in a terminal in the project directory.`,
    },
  );
}

/**
 * The stop when the SSH host key of the user's own server was never confirmed and the client
 * cannot show the dialog that confirms it: `command` (`design`, `drift`) does it in a terminal.
 */
export function hostKeyNeedsTerminal(command: string, unchanged: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew must confirm the SSH host key of the user's server once before it connects, and this MCP client cannot show the confirmation dialog. ${unchanged}`,
    {
      hint: `Ask the user to run \`npx opscrew ${command}\` in a terminal in the project directory: it shows the server's fingerprint to check against the server and pins it. Then call this tool again.`,
    },
  );
}

const ElicitedAnswer = z.object({
  approve: z.boolean().optional(),
  confirmation: z.string().optional(),
});

/** The text of the approval dialog: the title, what `approvalRequestLines` shows, how to approve. */
export function approvalMessage(request: ApprovalRequest): string {
  return [
    `OpsCrew asks for your approval: ${request.title}`,
    "",
    ...approvalRequestLines(request),
    request.confirmPhrase === undefined
      ? "Approve only if you reviewed the change above. Your coding agent cannot approve this for you."
      : `To approve, type "${request.confirmPhrase}" exactly. Anything else cancels.`,
  ].join("\n");
}

/**
 * Asks the human through MCP elicitation (a dialog in the client, not the model). Each request
 * becomes a form with one yes/no field, or a text field when the user must type `confirmPhrase`.
 * It never asks for secret values. Declines, cancels, wrong phrases and client errors all refuse.
 */
export class ElicitationApprovalHandler implements ApprovalHandler {
  /** Every request and its outcome, in order. */
  readonly decisions: { kind: ApprovalKind; approved: boolean }[] = [];

  constructor(
    private readonly server: McpServer,
    private readonly options: {
      clock: Clock;
      redact: (text: string) => string;
      extra?: CallExtra;
    },
  ) {}

  private approver(): string {
    const client = this.server.server.getClientVersion()?.name;
    return `user via ${client ?? "MCP client"} (elicitation)`;
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = await this.ask(request);
    this.decisions.push({ kind: request.kind, approved: decision.approved });
    return decision;
  }

  private async ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decide = (approved: boolean, extra: Partial<ApprovalDecision> = {}) => ({
      approved,
      approver: this.approver(),
      decidedAt: this.options.clock.now().toISOString(),
      ...extra,
    });
    const phrase = request.confirmPhrase;
    const requestedSchema: ElicitRequestFormParams["requestedSchema"] = {
      type: "object" as const,
      properties:
        phrase === undefined
          ? {
              approve: {
                type: "boolean" as const,
                title: "Approve",
                description: request.title,
                default: false,
              },
            }
          : {
              confirmation: {
                type: "string" as const,
                title: `Type "${phrase}" to approve`,
                description: request.title,
              },
            },
      required: [phrase === undefined ? "approve" : "confirmation"],
    };
    const extra = this.options.extra;
    let result: Awaited<ReturnType<McpServer["server"]["elicitInput"]>>;
    try {
      result = await this.server.server.elicitInput(
        { mode: "form", message: this.options.redact(approvalMessage(request)), requestedSchema },
        {
          timeout: ELICITATION_TIMEOUT_MS,
          ...(extra?.requestId !== undefined ? { relatedRequestId: extra.requestId } : {}),
          ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
        },
      );
    } catch {
      return decide(false, {
        reason: "the approval dialog could not be shown or was not answered",
      });
    }
    if (result.action !== "accept") {
      return decide(false, {
        reason: result.action === "decline" ? "declined by the user" : "cancelled by the user",
      });
    }
    const answer = ElicitedAnswer.safeParse(result.content ?? {});
    if (!answer.success) return decide(false, { reason: "the approval answer was not understood" });
    if (phrase !== undefined) {
      const typed = (answer.data.confirmation ?? "").trim();
      return typed === phrase
        ? decide(true, { confirmation: typed })
        : decide(false, { confirmation: typed, reason: "confirmation phrase did not match" });
    }
    return answer.data.approve === true
      ? decide(true)
      : decide(false, { reason: "declined by the user" });
  }
}

/** The approval handler of a tool call: every request becomes a dialog for the user. */
export function dialogHandler(
  server: McpServer,
  deps: Pick<ResolvedMcpDeps, "clock" | "redactor">,
  extra: CallExtra,
): ElicitationApprovalHandler {
  return new ElicitationApprovalHandler(server, {
    clock: deps.clock,
    redact: deps.redactor.redact,
    extra,
  });
}
