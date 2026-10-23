import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rewriteGuideLinks } from "../scripts/prepack.mjs";

describe("rewriteGuideLinks", () => {
  it("points a guide page at the docs site", () => {
    expect(rewriteGuideLinks("[Own](docs/guide/own-server.md)")).toBe(
      "[Own](https://docs.opscrew.dev/own-server/)",
    );
  });

  it("points the guide index at the site root", () => {
    expect(rewriteGuideLinks("[Guide](docs/guide/index.md)")).toBe(
      "[Guide](https://docs.opscrew.dev/)",
    );
  });

  it("keeps an anchor", () => {
    expect(rewriteGuideLinks("[TLS](docs/guide/tls-and-caa.md#caa)")).toBe(
      "[TLS](https://docs.opscrew.dev/tls-and-caa/#caa)",
    );
  });

  it("leaves absolute and non-guide links alone", () => {
    const text = "[Site](https://opscrew.dev/docs/guide/x.md) [ADR](docs/adr/0011.md) [L](LICENSE)";
    expect(rewriteGuideLinks(text)).toBe(text);
  });

  it("rewrites every guide link in the root README", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("](docs/guide/");
    const out = rewriteGuideLinks(readme);
    expect(out).not.toContain("](docs/guide/");
    expect(out).toContain("](https://docs.opscrew.dev/own-server/)");
  });
});
