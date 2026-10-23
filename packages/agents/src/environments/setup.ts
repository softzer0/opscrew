import { listText } from "@opscrew/core";
import type { BranchMatches, BranchRole } from "./branches";

/** The environments of a setup, in their order before prod. */
const ROLES = ["dev", "staging"] as const satisfies readonly BranchRole[];

/** The repository's dev and staging branches, in order: the environments a setup adds before prod. */
function before(matches: BranchMatches): { role: (typeof ROLES)[number]; branch: string }[] {
  return ROLES.flatMap((role) => {
    const branch = matches[role];
    return branch === undefined ? [] : [{ role, branch }];
  });
}

/** The matching branches, as the proposal names them (`main, develop and staging`). */
export function matchedBranches(matches: BranchMatches): string {
  return listText([matches.prod, matches.dev, matches.staging].flatMap((b) => b ?? []));
}

/** `dev ← develop, staging ← staging, prod ← main`: each environment and the branch it follows. */
export function followedBranches(matches: BranchMatches, trunk: string): string {
  return [...before(matches), { role: "prod", branch: trunk }]
    .map(({ role, branch }) => `${role} ← ${branch}`)
    .join(", ");
}

/**
 * The interview's note when the repository has branches named like environments (FR-1537): both
 * setups, promotion first recommended, each with the commands that make it once prod is designed.
 * `trunk` is the branch prod follows. `undefined` without a dev or staging branch.
 */
export function setupNote(matches: BranchMatches, trunk: string): string | undefined {
  const roles = before(matches);
  if (roles.length === 0) return undefined;
  const chain = [...roles.map(({ role }) => role), "prod"];
  const first = chain[0] as string;
  const promotion = [
    `\`opscrew env add ${first}\``,
    ...chain.slice(1, -1).map((role, i) => `\`opscrew env add ${role} --from ${chain[i]}\``),
    `\`opscrew env set prod --from ${chain.at(-2)}\``,
  ];
  const branches = roles.map(
    ({ role, branch }) => `\`opscrew env add ${role} --branch ${branch}\``,
  );
  return [
    `Your repository has branches named like environments: ${matchedBranches(matches)}. Once prod is designed, \`opscrew env add\` adds the others in one of two setups:`,
    `- Promotion first (recommended): one image moves ${chain.join(" → ")}, and only ${first} follows a branch (${trunk}). Each environment gets exactly the image the one before it ran: ${listText(promotion)}, in that order.`,
    `- Each environment follows its own branch (${followedBranches(matches, trunk)}), and each branch builds its own image: ${listText(branches)}.`,
  ].join("\n");
}
