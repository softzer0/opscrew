import { confirm, isCancel, multiselect, select, text } from "@clack/prompts";
import { OpsCrewError } from "@opscrew/core";

/** One choice of a select prompt. */
export interface UiChoice {
  value: string;
  label: string;
  hint?: string;
}

/**
 * The terminal prompts the CLI asks with. The default is clack; tests pass scripted fakes. A
 * prompt returns a symbol when the user cancels (Ctrl+C), recognised by `isCancel`.
 */
export interface UiPrompts {
  select(options: {
    message: string;
    options: UiChoice[];
    initialValue?: string;
  }): Promise<string | symbol>;
  multiselect(options: {
    message: string;
    options: UiChoice[];
    initialValues?: string[];
    required?: boolean;
  }): Promise<string[] | symbol>;
  text(options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string | undefined) => string | undefined;
  }): Promise<string | symbol>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
  isCancel(value: unknown): value is symbol;
}

/** The real prompts, from `@clack/prompts`. */
export const clackPrompts: UiPrompts = {
  select: (options) => select<string>(options),
  multiselect: (options) => multiselect<string>(options),
  text: (options) => text(options),
  confirm: (options) => confirm(options),
  isCancel,
};

/** Thrown when the user cancels a prompt; nothing has been written at that point. */
export function cancelled(what: string, rerun: string): OpsCrewError {
  return new OpsCrewError("APPROVAL_REFUSED", `You cancelled ${what}, so nothing was written.`, {
    hint: `Run \`${rerun}\` again when you are ready.`,
  });
}
