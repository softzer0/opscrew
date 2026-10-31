/**
 * `status`'s lines without the deploys' section (`deployStateReport`), for the tests of the
 * sections around it: the section, and the empty line before it.
 */
export function withoutDeploys(lines: readonly string[]): string[] {
  const at = lines.findIndex((line) => line.startsWith("Deploys (read from "));
  if (at === -1) return [...lines];
  const end = lines.indexOf("", at);
  return [...lines.slice(0, at - 1), ...(end === -1 ? [] : lines.slice(end))];
}
