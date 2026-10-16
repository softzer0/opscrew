import type { EnvAnswer, EnvQuestion } from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { UiPrompts } from "./prompts";

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
 * local `.env` value (only when there is one and the user picks it), type a value (always masked
 * for a secret) or leave it unset. Values are returned to the phase and never printed.
 */
export function createEnvPrompt(prompts: UiPrompts): (question: EnvQuestion) => Promise<EnvAnswer> {
  return async (question) => {
    if (question.localValueAvailable) {
      const choice = await prompts.select({
        message: `Production value for ${question.name}${question.optional ? " (optional)" : ""}`,
        options: [
          { value: USE_LOCAL, label: "Use the value from your local .env" },
          { value: TYPE, label: "Type a different value for production" },
          {
            value: SKIP,
            label: question.optional
              ? "Leave it unset and keep the app's default"
              : "Leave it unset",
          },
        ],
        initialValue: USE_LOCAL,
      });
      if (prompts.isCancel(choice)) throw cancelledEnv();
      if (choice === USE_LOCAL) return { useLocal: true };
      if (choice === SKIP) return { skip: true };
    }
    const message = question.optional
      ? `Production value for ${question.name} (optional: leave empty to keep the app's default)`
      : `Production value for ${question.name} (leave empty to skip)`;
    const answer = question.secret
      ? await prompts.password({ message })
      : await prompts.text({ message });
    if (prompts.isCancel(answer)) throw cancelledEnv();
    const value = typeof answer === "string" ? answer : "";
    return value.trim() === "" ? { skip: true } : { value };
  };
}
