import {
  createSdkMcpServer,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { AnyToolDefinition, ToolContext } from "@opscrew/contracts";

/** Name of OpsCrew's in-process MCP server; its tools appear to the model as `mcp__opscrew__*`. */
export const MCP_SERVER_NAME = "opscrew";

/** The name the model and the tool policy see for an in-process tool. */
export function mcpToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

function textResult(text: string, isError: boolean) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Adapts OpsCrew tool definitions to SDK MCP tools. Inputs are re-validated with the tool's full
 * zod schema, handler errors become error results, and every returned text is redacted.
 */
export function toSdkTools(
  tools: readonly AnyToolDefinition[],
  ctx: ToolContext,
  redact: (text: string) => string,
): SdkMcpToolDefinition[] {
  return tools.map((definition) =>
    tool(definition.name, definition.description, definition.inputSchema.shape, async (args) => {
      const parsed = definition.inputSchema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`)
          .join("; ");
        return textResult(redact(`Invalid input for ${definition.name}: ${issues}`), true);
      }
      try {
        const result = await definition.handler(parsed.data, ctx);
        return textResult(redact(result.text), result.isError === true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(redact(`${definition.name} failed: ${message}`), true);
      }
    }),
  ) as SdkMcpToolDefinition[];
}

/** Builds the in-process MCP server that exposes `tools` to the model. */
export function createToolServer(
  tools: readonly AnyToolDefinition[],
  ctx: ToolContext,
  redact: (text: string) => string,
) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    tools: toSdkTools(tools, ctx, redact),
  });
}
