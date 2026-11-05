import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import { sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { fakeShell, previewProject } from "../previews/__fixtures__/plan";
import { freshFacts } from "../testing";
import { previewRecipeDrift } from "./previews";

const SCRIPT = "#!/bin/sh\necho preview\n";
const COMPOSE = "services: {}\n";
const KEY_LINE =
  'restrict,command="/srv/apps/shop-preview/bin/opscrew-preview" ssh-ed25519 AAAAC3Nz opscrew-preview:acme/shop:shop-preview';

/** The preview server's facts: the recipe's files by their hashes, its values, cron and key. */
function serverFacts(files: Record<string, string>, more: Partial<HostFacts> = {}): HostFacts {
  const fresh = freshFacts();
  return HostFactsSchema.parse({
    ...fresh,
    deployUser: { groups: ["deploy", "docker"], keys: [], previewKeys: [KEY_LINE] },
    previews: [
      {
        app: "shop-preview",
        files: Object.fromEntries(Object.entries(files).map(([p, text]) => [p, sha256Hex(text)])),
        values: true,
        cron: ["17 * * * * /srv/apps/shop-preview/bin/opscrew-preview gc"],
        numbers: [42],
      },
    ],
    ...more,
  });
}

/** A preview project with the recipe committed in its environment's `previews/` folder. */
async function committed() {
  const project = await previewProject();
  const folder = join(project.deps.paths.artefactsDir, "previews");
  for (const [path, text] of [
    ["bin/opscrew-preview", SCRIPT],
    ["template/compose.yaml", COMPOSE],
  ] as const) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  }
  return project;
}

const shell = fakeShell(() => ({ exitCode: 0, stdout: "" }));

describe("previewRecipeDrift", () => {
  it("finds nothing when the server's recipe is the committed one", async () => {
    const { deps, plan } = await committed();
    const facts = serverFacts({ "bin/opscrew-preview": SCRIPT, "template/compose.yaml": COMPOSE });
    const notes: string[] = [];
    const found = await previewRecipeDrift(deps, plan, notes, {
      services: { remote: shell.remote },
      inspect: async () => facts,
    });
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("reads a Windows checkout's CRLF files as the same text, and leaves dot-files out", async () => {
    const { deps, plan } = await committed();
    const folder = join(deps.paths.artefactsDir, "previews");
    await writeFile(join(folder, "template/compose.yaml"), COMPOSE.replaceAll("\n", "\r\n"));
    await writeFile(join(folder, ".gitattributes"), "* text=auto\n");
    const facts = serverFacts({ "bin/opscrew-preview": SCRIPT, "template/compose.yaml": COMPOSE });
    const found = await previewRecipeDrift(deps, plan, [], {
      services: { remote: shell.remote },
      inspect: async () => facts,
    });
    expect(found).toEqual([]);
  });

  it("names each file that differs, is missing or extra, and a missing key, values or cleanup", async () => {
    const { deps, plan } = await committed();
    const facts = serverFacts(
      { "bin/opscrew-preview": "#!/bin/sh\necho edited\n", "template/extra.yaml": "x\n" },
      { deployUser: { groups: ["deploy"], keys: [], previewKeys: [] } },
    );
    facts.previews[0] = {
      ...(facts.previews[0] as HostFacts["previews"][number]),
      values: false,
      cron: [],
    };
    const found = await previewRecipeDrift(deps, plan, [], {
      services: { remote: shell.remote },
      inspect: async () => facts,
    });
    expect(found.map((d) => d.detail)).toEqual([
      "The server's recipe lacks template/compose.yaml. `opscrew provision --env preview` puts it back.",
      "bin/opscrew-preview on the server differs from the repository's recipe. `opscrew provision --env preview` puts it back.",
      "The server's recipe has template/extra.yaml, which the repository's lacks. `opscrew provision --env preview` puts it back.",
      "The previews' values file (values.env) is missing. `opscrew provision --env preview` puts it back.",
      "The hourly cleanup of idle previews is not in the deploy user's crontab. `opscrew provision --env preview` puts it back.",
      "The preview key is not in the deploy user's authorized_keys, so pull requests' preview jobs can't reach the server. `opscrew provision --env preview` puts it back.",
    ]);
    expect(found.every((d) => d.area === "previews" && d.restoredByProvision)).toBe(true);
  });

  it("says when the recipe is not on the server", async () => {
    const { deps, plan } = await committed();
    const found = await previewRecipeDrift(deps, plan, [], {
      services: { remote: shell.remote },
      inspect: async () => HostFactsSchema.parse(freshFacts()),
    });
    expect(found.map((d) => d.detail)).toEqual([
      "The previews' recipe is not on the server (/srv/apps/shop-preview). `opscrew provision --env preview` puts it back.",
    ]);
  });

  it("notes a recipe that is not committed yet instead of comparing", async () => {
    const { deps, plan } = await previewProject();
    const notes: string[] = [];
    const found = await previewRecipeDrift(deps, plan, notes, {
      services: { remote: shell.remote },
      inspect: async () => {
        throw new Error("the server should not be read");
      },
    });
    expect(found).toEqual([]);
    expect(notes).toEqual([
      "The previews' recipe is not in the repository yet (opscrew/environments/preview/previews/), so the one on the preview server was not compared; `opscrew provision --env preview` renders it.",
    ]);
  });
});
