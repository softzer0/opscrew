/**
 * The live test of the nginx edge on a server the user already owns (feature 014, docs/e2e.md
 * "Your own server with nginx"): certbot's first certificate and a forced renewal under load, an
 * addition served, testssl.sh through nginx, a second app on the same edge and a different proxy
 * refused while both are there, origin TLS on nginx behind Cloudflare's proxy, a switch to Caddy
 * and back within the stated interruption, and a destroy that removes the certificates. The pass
 * itself is `own-edge-pass.ts`, shared with OpenLiteSpeed's.
 */
import { edgePass } from "./own-edge-pass";

edgePass({
  edge: "nginx",
  name: "nginx",
  gate: "OPSCREW_E2E_OWN_NGINX",
  docs: "Your own server with nginx",
  label: "own server, nginx",
  folder: "nginx",
  reloads: "reloaded",
});
