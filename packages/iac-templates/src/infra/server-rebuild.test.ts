import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import { MODULE_FILES } from "./modules";

/** The body of `resource "<type>" "this"` in `source`. */
function resourceBody(source: string, type: string): string {
  return new RegExp(`resource "${type}" "this" \\{\\n([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
}

/** The `lifecycle` block of a resource's body. */
function lifecycle(body: string, type: string): string {
  const block = /\n {2}lifecycle \{\n([\s\S]*?)\n {2}\}/.exec(body);
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
    const body = resourceBody(MODULE_FILES[file] ?? "", type);
    // The attribute the module sets from its `image` variable (`image`, Contabo's `image_id`).
    const image = /^ {2}(\w+) += var\.image$/m.exec(body)?.[1];
    expect(image).toBeDefined();
    const ignored = /ignore_changes = \[([^\]]*)\]/.exec(lifecycle(body, type));
    expect(ignored?.[1]?.split(",").map((name) => name.trim())).toContain(image);
  });
});
