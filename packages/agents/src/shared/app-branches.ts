import { type AppBranchBase, appBranch } from "@opscrew/plan-schema";

/**
 * The 100 names OpsCrew tries, in order, for the app `key`'s branch `base` (plan-schema's
 * `appBranch`; `key` undefined: the repository's first app): that branch, then numbered from 2.
 * The first app's are `<base>-2`, `<base>-3`, …: a key starts with a letter, so none of them is a
 * further app's branch. A further app's are `<base>-<key>_2`, …, since `-2` would make app `a`'s
 * second branch app `a-2`'s first, and no key holds `_`.
 */
export function appBranchNames(base: AppBranchBase, key: string | undefined): string[] {
  const first = appBranch(base, key);
  const separator = key === undefined ? "-" : "_";
  return [first, ...Array.from({ length: 99 }, (_, i) => `${first}${separator}${i + 2}`)];
}

/** How a hint names the numbered {@link appBranchNames}: `<branch>-<n>` or `<branch>_<n>`. */
export function numberedBranches(base: AppBranchBase, key: string | undefined): string {
  return `${appBranch(base, key)}${key === undefined ? "-" : "_"}<n>`;
}
