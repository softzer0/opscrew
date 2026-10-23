import { describe, expect, it } from "vitest";
import { FakePromoteGitHub, STAGING_IMAGE } from "./__fixtures__/world";
import { chooseImage, imageFactsOf, imageReference } from "./image";

describe("the image a promotion reads", () => {
  it("is the further app's own package, ghcr.io/<owner>/<repo>/<key>", async () => {
    const github = new FakePromoteGitHub();
    github.tags.set("opscrew-staging", STAGING_IMAGE);
    const docs = { github, owner: "acme", repo: "shop", key: "docs" };
    const input = { source: "staging", target: "prod", sourceDeployed: true };
    expect(await chooseImage(docs, input)).toEqual({ digest: STAGING_IMAGE, rollback: false });
    await imageFactsOf(docs, STAGING_IMAGE);
    expect(github.images).toEqual(["acme/shop/docs", "acme/shop/docs"]);
    expect(imageReference(docs, STAGING_IMAGE)).toBe(`ghcr.io/acme/shop/docs@${STAGING_IMAGE}`);

    // The repository's first app keeps the repository's own package.
    const first = { github, owner: "Acme", repo: "Shop" };
    await chooseImage(first, input);
    expect(github.images.at(-1)).toBe("Acme/Shop");
    expect(imageReference(first, STAGING_IMAGE)).toBe(`ghcr.io/acme/shop@${STAGING_IMAGE}`);
  });
});
