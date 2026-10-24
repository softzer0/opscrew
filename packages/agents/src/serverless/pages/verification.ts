/**
 * GitHub's domain verification record for a site on GitHub Pages: its value, which GitHub shows
 * only on the account's Pages settings page (spike result 13), and the one manual step, Verify.
 */
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { pagesVerificationRootDir, verificationRecordName } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../../context";
import type { ProvisionServices } from "../../provision/types";
import { readValidJson } from "../../shared";

/** The value of GitHub's verification record: letters and digits, as GitHub's page shows it. */
export const PagesVerificationSchema = z.string().regex(/^[A-Za-z0-9]+$/);

/** The verification root's committed values, where a later run finds the value again. */
const VerificationTfvarsSchema = z.looseObject({ verification: PagesVerificationSchema });

/**
 * The GitHub settings page where the domain is added and verified: the organization's for a
 * repository an organization owns, else the user's.
 */
export function verificationPage(owner: string, ownerType: string): string {
  return ownerType === "Organization"
    ? `https://github.com/organizations/${owner}/settings/pages`
    : "https://github.com/settings/pages";
}

/** The TXT record's name, as iac-templates renders it (destroy names it from here). */
export { verificationRecordName };

/** How to find the value on GitHub's page, for the prompt's caller and the stop's hint. */
function whereToFind(domain: string, page: string): string {
  return `On ${page}, click "Add a domain", enter ${domain} and copy the value of the TXT record GitHub shows (leave Verify for later: OpsCrew creates the record first).`;
}

/** `text` trimmed and checked as a verification value; a wrong one stops plainly. */
function checkedValue(text: string, from: string, domain: string, page: string): string {
  const value = text.trim().replace(/^"(.*)"$/, "$1");
  const parsed = PagesVerificationSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The verification value ${from} is not one GitHub gives: it is letters and digits only. Nothing was changed.`,
      { hint: whereToFind(domain, page) },
    );
  }
  return parsed.data;
}

/**
 * The verification record's value, before any change: `--pages-verification` (it replaces the
 * recorded one), else the one the verification root's `terraform.tfvars.json` holds from an
 * earlier run, else the user's answer in an interactive run. Without one it stops
 * (`PHASE_PRECONDITION`, nothing changed), naming the page and the flag.
 */
export async function pagesVerificationValue(
  deps: Pick<PhaseDeps, "paths" | "interactive">,
  input: {
    plan: DeployPlan;
    domain: string;
    page: string;
    given: string | undefined;
    ask: ProvisionServices["askPagesVerification"];
    command: string;
  },
): Promise<string> {
  const { domain, page } = input;
  if (input.given !== undefined) {
    return checkedValue(input.given, "given with --pages-verification", domain, page);
  }
  const recorded = await readValidJson(
    join(deps.paths.root, pagesVerificationRootDir(input.plan), "terraform.tfvars.json"),
    VerificationTfvarsSchema,
  );
  if (recorded !== undefined) return recorded.verification;
  if (deps.interactive && input.ask !== undefined) {
    return checkedValue(await input.ask({ domain, page }), "you entered", domain, page);
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `GitHub's domain verification record for ${domain} needs its value, which GitHub shows only on its settings page. Nothing was changed.`,
    {
      hint: `${whereToFind(domain, page)} Then run \`${input.command} --pages-verification <value>\`.`,
    },
  );
}

/** The one step GitHub offers no API for, said once the verification record exists. */
export function verifyStepNote(input: { owner: string; domain: string; page: string }): string {
  return `One step is yours, because GitHub has no API for it: once the TXT record ${verificationRecordName(input.owner, input.domain)} resolves (usually within minutes), open ${input.page} and click Verify next to ${input.domain}. A verified domain can be used only by your account's GitHub Pages sites, so no one else can take it over.`;
}
