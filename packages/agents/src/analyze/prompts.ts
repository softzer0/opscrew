import type { ProjectFacts } from "@opscrew/plan-schema";
import type { FactsSummary } from "./summary";

/** System prompt of the Analyst agent (read-only repository reviewer). */
export const ANALYST_SYSTEM_PROMPT = `You are the OpsCrew Analyst. OpsCrew deploys a user's app from their repository to their own cloud server (Hetzner Cloud, Docker, Caddy). Your job is to check the facts OpsCrew detected about the repository and explain the app in plain English for a non-expert.

Rules:
- You are read-only. You can read, list and search files inside the project directory. You cannot edit files, run commands or use the network, and you must not try.
- Never read \`.env\` files (\`.env\`, \`.env.local\`, \`.env.production\` and similar), private keys, certificates or credential files (\`*.pem\`, \`*.key\`, \`id_rsa\`, \`id_ed25519\`, \`*.p12\`, service-account JSON). \`.env.example\` and \`.env.sample\` are fine.
- Never print, quote or guess secret values (API keys, tokens, passwords, connection strings). Refer to configuration by environment variable name only.
- Focus on deployment facts: what kind of app it is, how it is built and started, which port it listens on, whether it has a health-check endpoint, which databases and services it needs, and what could go wrong when it runs in production.
- Keep the summary short (3 to 6 sentences), concrete and free of marketing language.
- Do not invent problems. Only report a risk when you saw evidence for it in the code.`;

/**
 * User prompt of the Analyst: the detected facts as JSON (names only, never values), the
 * deterministic summary and risks, and the task. Pass the result through the redactor before use.
 */
export function buildAnalystPrompt(facts: ProjectFacts, deterministic: FactsSummary): string {
  const risks =
    deterministic.risks.length > 0
      ? deterministic.risks.map((r) => `- ${r}`).join("\n")
      : "- (none)";
  return `OpsCrew detected these facts about the repository in the current directory:

\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

Deterministic summary:
${deterministic.summary}

Risks OpsCrew already found (they are always reported; do not repeat them):
${risks}

Task:
1. Read the code you need (package manifests, entry points, server setup, routes, configuration) to check the facts above.
2. Write \`summary\`: a plain-English description of what the app does and how it runs.
3. Write \`risks\`: additional deployment risks you found evidence for, one sentence each, saying what to do about it. Use an empty list when there are none.
4. Only when a fact above is clearly wrong, set \`corrections\` with the right value for \`appKind\` (one of static-spa, ssr, api, fullstack, worker, unknown), \`port\`, \`startCommand\` or \`healthEndpoint\` (a path starting with \`/\`). Leave out every field that is already correct.`;
}
