import { password } from "@clack/prompts";
import type { EnvAnswer, EnvQuestion } from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { UiPrompts } from "./prompts";

/** Masked text prompt for secret values; returns a symbol when the user cancels. */
export type SecretPrompt = (options: { message: string }) => Promise<string | symbol>;

/** The real masked prompt, from `@clack/prompts`. */
export const clackSecretPrompt: SecretPrompt = (options) => password(options);

const USE_LOCAL = "use-local";
const TYPE = "type";
const SKIP = "skip";

function cancelledEnv(): OpsCrewError {
  return new OpsCrewError(
    "APPROVAL_REFUSED",
    "You cancelled entering the production environment, so no deploy secrets were stored.",
    {
      hint: "Run `opscrew provision` again to enter the values; it continues where it stopped.",
    },
  );
}

/**
 * The interactive question `provision` asks for each production environment value: reuse the
 * local `.env` value (only when there is one and the user picks it), type a value (masked for
 * secrets) or leave it unset. Values are returned to the phase and never printed.
 */
export function createEnvPrompt(
  prompts: UiPrompts,
  secretPrompt?: SecretPrompt,
): (question: EnvQuestion) => Promise<EnvAnswer> {
  return async (question) => {
    if (question.localValueAvailable) {
      const choice = await prompts.select({
        message: `Production value for ${question.name}`,
        options: [
          { value: USE_LOCAL, label: "Use the value from your local .env" },
          { value: TYPE, label: "Type a different value for production" },
          { value: SKIP, label: "Leave it unset" },
        ],
        initialValue: USE_LOCAL,
      });
      if (prompts.isCancel(choice)) throw cancelledEnv();
      if (choice === USE_LOCAL) return { useLocal: true };
      if (choice === SKIP) return { skip: true };
    }
    const message = `Production value for ${question.name} (leave empty to skip)`;
    const answer =
      question.secret && secretPrompt !== undefined
        ? await secretPrompt({ message })
        : await prompts.text({ message });
    if (prompts.isCancel(answer)) throw cancelledEnv();
    const value = typeof answer === "string" ? answer : "";
    return value.trim() === "" ? { skip: true } : { value };
  };
}
