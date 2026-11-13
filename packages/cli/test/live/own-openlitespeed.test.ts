/**
 * The live test of the OpenLiteSpeed edge on a server the user already owns (feature 027, ADR 0031,
 * SC-2706, docs/e2e.md "Your own server with OpenLiteSpeed"): nginx's pass (`own-edge-pass.ts`)
 * with `target.edge: openlitespeed`, and one step more after the forced renewal: a deploy empties
 * the app's page cache.
 */
import { minutes } from "./cloud";
import { edgeContainer, edgePass } from "./own-edge-pass";

/** The folder of an app's page cache in the OpenLiteSpeed container (ADR 0031 D4). */
const CACHE_ROOT = "/usr/local/lsws/cachedata";

edgePass({
  edge: "openlitespeed",
  name: "OpenLiteSpeed",
  gate: "OPSCREW_E2E_OPENLITESPEED",
  docs: "Your own server with OpenLiteSpeed",
  label: "own server, OpenLiteSpeed",
  folder: "ols",
  reloads: "restarted gracefully",
  extra: {
    title:
      "a deploy empties the app's page cache: a kept answer is gone after it, the cache's own files stay",
    timeoutMs: minutes(40),
    body: async (run) => {
      const cache = `${CACHE_ROOT}/${run.app()}`;
      const container = edgeContainer("openlitespeed");
      const inEdge = (command: string) =>
        run.shell().ok(`docker exec ${container} sh -c '${command}'`);
      const before = await run.shell().ok(`echo ${container}`);
      // A kept answer, as OpenLiteSpeed files one, and the cache's own file beside it.
      await inEdge(
        `mkdir -p ${cache}/e2e && echo kept > ${cache}/e2e/answer && touch ${cache}/.cacheman-e2e`,
      );
      await run.mergeChange("e2e: a change, deployed to empty the page cache");
      if ((await run.shell().ok(`echo ${container}`)) !== before) {
        throw new Error("The deploy replaced the OpenLiteSpeed container, which proves nothing.");
      }
      const left = await inEdge(
        `if [ -e ${cache}/e2e ]; then echo kept; elif [ -e ${cache}/.cacheman-e2e ]; then echo emptied; else echo all gone; fi`,
      );
      if (left !== "emptied") {
        throw new Error(
          `After the deploy the app's page cache is "${left}", not emptied with the cache's own file kept.`,
        );
      }
      await inEdge(`rm -f ${cache}/.cacheman-e2e`);
      run.log("the deploy emptied the app's page cache and left the cache's own files");
    },
  },
});
