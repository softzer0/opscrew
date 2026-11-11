import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The CLI's and the MCP server's sources, which read the cloud providers from the registry. */
const ROOTS = {
  cli: fileURLToPath(new URL("./", import.meta.url)),
  "mcp-server": fileURLToPath(new URL("../../mcp-server/src/", import.meta.url)),
};

/** A cloud provider id written into the code, quoted or in a text. */
const PROVIDER_ID = /\b(hetzner|digitalocean)\b/;

/** Lines that may name an id, matched by their content, with the reason. */
const EXEMPT: { file: string; line: string; why: string }[] = [
  {
    file: "cli/commands/snapshot.ts",
    line: '"hetzner",',
    why: "a choice of `snapshot offsite on --to`: an object-storage provider, not a server",
  },
  {
    file: "cli/commands/snapshot.ts",
    line: '"digitalocean",',
    why: "a choice of `snapshot offsite on --to`: an object-storage provider, not a server",
  },
  {
    file: "cli/commands/snapshot.ts",
    line: "With --to hetzner or digitalocean: the bucket's region",
    why: "the help of `snapshot offsite on --region`, about the object-storage choices",
  },
  {
    file: "cli/commands/snapshot.ts",
    line: "needs --to: r2 (Cloudflare R2), hetzner or digitalocean, where the copies' bucket is.",
    why: "the error naming the object-storage choices of `snapshot offsite on --to`",
  },
  {
    file: "cli/commands/snapshot.ts",
    line: ", or with hetzner or digitalocean.`",
    why: "the hint naming the object-storage choices of `snapshot offsite on --to`",
  },
  {
    file: "mcp-server/tools/interview.ts",
    line: 'question ("garage", "hetzner", "digitalocean" or "r2",',
    why: "the interview's objectStorage answer: where OpsCrew creates the app's bucket",
  },
  {
    file: "cli/commands/retarget.ts",
    line: "opscrew retarget --to digitalocean   start the move",
    why: "a help example of one move",
  },
  {
    file: "cli/commands/rotate.ts",
    line: "opscrew rotate hetzner                  after you set a new HCLOUD_TOKEN",
    why: "a help example of one rotation",
  },
];

/** The source files under `dir`, without tests and fixtures. */
async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !/\.test\.tsx?$/.test(file) && !/__(fixtures|snapshots)__/.test(file));
}

describe("cloud provider ids in the CLI and the MCP server", () => {
  it("appear only in the object-storage choices and two help examples; the rest reads the registry", async () => {
    const found: string[] = [];
    for (const [name, root] of Object.entries(ROOTS)) {
      for (const file of await sources(root)) {
        const relative = `${name}/${path.relative(root, file).split(path.sep).join("/")}`;
        const lines = (await readFile(file, "utf8")).split("\n");
        lines.forEach((line, index) => {
          if (!PROVIDER_ID.test(line)) return;
          const exempt = EXEMPT.some(
            (allowed) => allowed.file === relative && line.includes(allowed.line),
          );
          if (!exempt) found.push(`${relative}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(found).toEqual([]);
  });
});
