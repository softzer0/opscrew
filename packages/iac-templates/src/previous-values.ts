import type { DeployPlan } from "@opscrew/plan-schema";

/**
 * The app secrets whose framework reads earlier values beside the current one (025 research R8),
 * and the variable that holds them: Laravel's `APP_PREVIOUS_KEYS` (a comma list tried after
 * `APP_KEY`) and Better Auth's `BETTER_AUTH_SECRETS` (`<version>:<value>,…`, the first current).
 * A credential rotation keeps the old value there.
 */
export const PREVIOUS_VALUES: Readonly<Record<string, string>> = {
  APP_KEY: "APP_PREVIOUS_KEYS",
  BETTER_AUTH_SECRET: "BETTER_AUTH_SECRETS",
};

/**
 * The previous-value variables the app is given beside `plan.app.env`: that of each secret of
 * {@link PREVIOUS_VALUES} OpsCrew generates (`source: generated`), unless the plan names it
 * itself. Empty until a rotation keeps an old value: the targets leave it unset then.
 */
export function previousValueVariables(plan: Pick<DeployPlan, "app">): string[] {
  const named = new Set(plan.app.env.map((variable) => variable.name));
  return plan.app.env.flatMap((variable) => {
    const previous = PREVIOUS_VALUES[variable.name];
    return variable.source === "generated" && previous !== undefined && !named.has(previous)
      ? [previous]
      : [];
  });
}
