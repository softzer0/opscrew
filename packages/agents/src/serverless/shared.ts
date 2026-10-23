/**
 * What provision does the same way for both server-less targets (feature 016): the site's deploy
 * secrets in GitHub Actions.
 */
import { siteEnvSecret } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubSetup } from "../provision/credentials";
import { buildAppEnvironment, setDeploySecrets } from "../provision/secrets";
import { deploySecretsStep } from "../provision/steps";
import type { ProvisionServices } from "../provision/types";

/**
 * Stores the site's deploy secrets in GitHub Actions after one `github-secrets` approval that lists
 * their names, and says whether GitHub Actions has them after this run (as `deploySecretsStep`
 * does: with `store` false, whether an earlier run from this computer stored them, else a warning).
 * They are the app's values, one `OPSCREW_ENV_<NAME>` per variable of `plan.app.env`
 * (`siteEnvSecret`, with the environment's prefix: `deploySecretName`), and the target's own
 * deploy secrets in `deploy` (Cloudflare's deploy token and account id), by their names before the
 * prefix. All are repository secrets: the build job runs outside any GitHub environment, and
 * provision never moves a site's secrets into one (`environment.secrets` stays unset). Values are
 * registered with the redactor and never shown; `done` says what is set up already when the user
 * refuses.
 */
export async function storeSiteSecrets(
  deps: PhaseDeps,
  input: {
    github: GitHubSetup;
    plan: DeployPlan;
    services: ProvisionServices;
    /** Store them in this run (false with `--no-secrets`). */
    store: boolean;
    deploy?: Record<string, string>;
    done: string;
  },
): Promise<boolean> {
  const { github, plan } = input;
  return deploySecretsStep(deps, {
    store: input.store,
    plan,
    save: async () => {
      const environment = await buildAppEnvironment(deps, plan, input.services);
      const values: Record<string, string> = {
        ...environment.values.app,
        ...environment.values.build,
      };
      const site = Object.fromEntries(
        plan.app.env.flatMap(({ name }) => {
          const value = values[name];
          return value === undefined ? [] : [[siteEnvSecret(name), value]];
        }),
      );
      await setDeploySecrets(
        deps,
        github,
        plan,
        { ...input.deploy, ...site },
        environment.names,
        "provision",
        { record: plan.target.provider, refusedState: input.done },
      );
    },
    where: { host: plan.target.provider, owner: github.owner, repo: github.repo },
    noun: "app",
  });
}
