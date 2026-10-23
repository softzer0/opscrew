// Copies the root README.md, LICENSE and NOTICE into the package before `npm pack` (postpack
// removes them). npmjs.com resolves relative links against packages/cli, so README links into
// docs/guide/ are pointed at the published guide instead.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOCS_SITE = "https://docs.opscrew.dev/";

/**
 * Rewrites Markdown link targets `docs/guide/<slug>.md` (with an optional `#anchor`) to their
 * page on the docs site; `index.md` maps to the site root. Other links are left as they are.
 * @param {string} markdown
 * @returns {string}
 */
export function rewriteGuideLinks(markdown) {
  return markdown.replace(
    /\]\(docs\/guide\/([\w-]+)\.md(#[^)\s]*)?\)/g,
    (_match, slug, anchor = "") => `](${DOCS_SITE}${slug === "index" ? "" : `${slug}/`}${anchor})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of ["LICENSE", "NOTICE"]) copyFileSync(`../../${file}`, file);
  writeFileSync("README.md", rewriteGuideLinks(readFileSync("../../README.md", "utf8")));
}
