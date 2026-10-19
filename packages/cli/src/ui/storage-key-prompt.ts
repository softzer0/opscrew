import type { StorageKey, StorageKeyQuestion } from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { UiPrompts } from "./prompts";

function cancelledKey(): OpsCrewError {
  return new OpsCrewError("APPROVAL_REFUSED", "You cancelled entering the bucket's key.", {
    hint: "Run `opscrew provision` again when you have the key; it continues where it stopped.",
  });
}

/**
 * The interactive question `provision` asks once for the key of the app's bucket at a provider:
 * the console steps to create it, then its access key ID and its secret, both typed into masked
 * prompts. The key is returned to the phase and never printed.
 */
export function createStorageKeyPrompt(
  prompts: UiPrompts,
  print: (text: string) => void,
): (question: StorageKeyQuestion) => Promise<StorageKey> {
  return async (question) => {
    print(
      [
        "",
        `Create a key for the bucket ${question.bucket} on ${question.provider}:`,
        ...question.steps.map((step, i) => `  ${i + 1}. ${step}`),
        "",
        "",
      ].join("\n"),
    );
    const accessKeyId = await prompts.password({ message: "Access key ID" });
    if (prompts.isCancel(accessKeyId)) throw cancelledKey();
    const secretAccessKey = await prompts.password({ message: "Secret access key" });
    if (prompts.isCancel(secretAccessKey)) throw cancelledKey();
    return { accessKeyId, secretAccessKey };
  };
}
