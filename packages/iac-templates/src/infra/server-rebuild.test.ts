import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import { MODULE_FILES } from "./modules";

/** The `lifecycle` block of `resource "<type>" "this"` in `source`. */
function lifecycle(source: string, type: string): string {
  const resource = new RegExp(`resource "${type}" "this" \\{\\n([\\s\\S]*?)\\n\\}`).exec(source);
  const block = /\n {2}lifecycle \{\n([\s\S]*?)\n {2}\}/.exec(resource?.[1] ?? "");
  if (!block?.[1]) throw new Error(`no lifecycle block in ${type}.this`);
  return block[1];
}

// `opscrew restore --server` rebuilds the server in place from a snapshot through the provider's
// API (024 D5), so the state's image no longer matches the server's: the next provision must
// plan no replacement for it.
describe("the server modules after a rebuild from a snapshot", () => {
  it.each(
    CLOUD_PROVIDERS.map(({ terraform }) => [
      `${terraform.module.name}/main.tf`,
      terraform.serverResourceType,
    ]),
  )("%s ignores changes to the server's image", (file, type) => {
    const ignored = /ignore_changes = \[([^\]]*)\]/.exec(lifecycle(MODULE_FILES[file] ?? "", type));
    expect(ignored?.[1]?.split(",").map((name) => name.trim())).toContain("image");
  });
});
