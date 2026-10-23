import type { EnvAnswer, EnvQuestion } from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { UiPrompts } from "./prompts";

const USE_LOCAL = "use-local";
const TYPE = "type";
const SKIP = "skip";

function cancelledEnv(environment: string): OpsCrewError {
  const prod = environment === "prod";
  return new OpsCrewError(
    "APPROVAL_REFUSED",
    `You cancelled entering the ${prod ? "production environment" : `${environment} environment's values`}, so no deploy secrets were stored.`,
    {
      hint: `Run \`opscrew provision${prod ? "" : ` --env ${environment}`}\` again to enter the values; it continues where it stopped.`,
    },
  );
}

/**
 * The interactive question `provision` asks for each value of the environment's app: reuse the
 * value in its local file (`.env` for prod, `.env.<env>` for another; only when there is one and
 * the user picks it), type a value (always masked for a secret) or leave it unset. Prod's values
 * are called production values, another environment's are named for it. Values are returned to
 * the phase and never printed.
 */
export function createEnvPrompt(prompts: UiPrompts): (question: EnvQuestion) => Promise<EnvAnswer> {
  return async (question) => {
    const prod = question.environment === "prod";
    const valueFor = prod
      ? `Production value for ${question.name}`
      : `Value for ${question.name} in the ${question.environment} environment`;
    if (question.localValueAvailable) {
      const choice = await prompts.select({
        message: `${valueFor}${question.optional ? " (optional)" : ""}`,
        options: [
          { value: USE_LOCAL, label: `Use the value from your local ${question.localFile}` },
          {
            value: TYPE,
            label: prod
              ? "Type a different value for production"
              : `Type a different value for the ${question.environment} environment`,
          },
          {
            value: SKIP,
            label: question.optional
              ? "Leave it unset and keep the app's default"
              : "Leave it unset",
          },
        ],
        initialValue: USE_LOCAL,
      });
      if (prompts.isCancel(choice)) throw cancelledEnv(question.environment);
      if (choice === USE_LOCAL) return { useLocal: true };
      if (choice === SKIP) return { skip: true };
    }
    const message = question.optional
      ? `${valueFor} (optional: leave empty to keep the app's default)`
      : `${valueFor} (leave empty to skip)`;
    const answer = question.secret
      ? await prompts.password({ message })
      : await prompts.text({ message });
    if (prompts.isCancel(answer)) throw cancelledEnv(question.environment);
    const value = typeof answer === "string" ? answer : "";
    return value.trim() === "" ? { skip: true } : { value };
  };
}
