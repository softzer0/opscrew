import { type InterviewAnswers, parseMoney } from "@opscrew/agents";
import type { Money, Question } from "@opscrew/plan-schema";
import { cancelled, clackPrompts, type UiPrompts } from "./prompts";

export interface AskQuestionsOptions {
  /** Prompts to ask with (default clack). */
  prompts?: UiPrompts;
}

const moneyText = (money: Money) => `${money.amount} ${money.currency}`;

/**
 * A question the terminal can ask: an interview {@link Question}, or a follow-up with its own id
 * (the questions about a server the user already has, `server.host` and so on).
 */
export type AskableQuestion = Omit<Question, "id"> & { id: string };

function message(question: AskableQuestion): string {
  return question.help === undefined ? question.prompt : `${question.prompt}\n${question.help}`;
}

/**
 * Asks the interview questions one by one in the terminal, pre-filled with each question's
 * default, and returns the answers keyed by question id. When the domain is left empty the DNS
 * provider question is skipped (answered `none`). Cancelling throws a user-facing error.
 */
export async function askQuestions(
  questions: readonly AskableQuestion[],
  options: AskQuestionsOptions = {},
): Promise<InterviewAnswers> {
  const prompts = options.prompts ?? clackPrompts;
  const answers: InterviewAnswers = {};
  const check = <T>(value: T | symbol): T => {
    if (prompts.isCancel(value)) throw cancelled("the interview", "opscrew interview");
    return value as T;
  };

  for (const question of questions) {
    if (question.id === "dnsProvider" && answers.domain === "") {
      answers.dnsProvider = "none";
      continue;
    }
    const choices = (question.options ?? []).map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint === undefined ? {} : { hint: option.hint }),
    }));
    const fallback = question.default;
    switch (question.kind) {
      case "single-select":
        answers[question.id] = check(
          await prompts.select({
            message: message(question),
            options: choices,
            ...(typeof fallback === "string" ? { initialValue: fallback } : {}),
          }),
        );
        break;
      case "multi-select":
        answers[question.id] = check(
          await prompts.multiselect({
            message: message(question),
            options: choices,
            initialValues: Array.isArray(fallback) ? fallback : [],
            required: question.required,
          }),
        );
        break;
      case "money": {
        const initial =
          typeof fallback === "object" && !Array.isArray(fallback) ? moneyText(fallback) : "";
        answers[question.id] = check(
          await prompts.text({
            message: message(question),
            placeholder: "10 EUR",
            ...(initial === "" ? {} : { initialValue: initial }),
            validate: (value) => {
              if ((value ?? "").trim() === "") {
                return question.required ? "Enter an amount, for example 10 EUR." : undefined;
              }
              return parseMoney(value) === undefined
                ? "Write an amount such as 10 EUR or 20 USD."
                : undefined;
            },
          }),
        );
        answers[question.id] = String(answers[question.id] ?? "").trim();
        break;
      }
      case "text": {
        const initial = typeof fallback === "string" ? fallback : "";
        answers[question.id] = check(
          await prompts.text({
            message: message(question),
            ...(initial === "" ? {} : { initialValue: initial }),
            validate: (value) =>
              question.required && (value ?? "").trim() === ""
                ? "This answer is required."
                : undefined,
          }),
        );
        answers[question.id] = String(answers[question.id] ?? "").trim();
        break;
      }
      case "confirm":
        answers[question.id] = check(
          await prompts.confirm({
            message: message(question),
            initialValue: typeof fallback === "boolean" ? fallback : true,
          }),
        );
        break;
    }
  }
  return answers;
}
