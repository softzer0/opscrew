/**
 * Several apps in one repository (feature 016, US6): `opscrew app add`, `app list` and
 * `app remove`, the choice of app (`--app <key>`, `--app .` for the first app), and the check that
 * no two apps or environments of a repository share a name or a GitHub Pages site.
 */
export { addApp } from "./add";
export { type AppChoiceDeps, appFlag, FIRST_APP, resolveApp } from "./choice";
export { type AppSummary, listApps } from "./list";
export { type RemoveAppOptions, removeApp } from "./remove";
