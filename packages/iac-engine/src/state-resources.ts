/** `data.…` at the root or inside modules (`module.a["k"].module.b.data.…`). */
const DATA_SOURCE = /^(?:module\.[^.[]+(?:\[[^\]]*\])?\.)*data\./;

/** The managed resource addresses in `state list` output, sorted (data sources left out). */
export function managedAddresses(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !DATA_SOURCE.test(line))
    .sort();
}
