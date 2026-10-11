import type { Playbook } from "./types";

/** Static single-page apps (Vite, Create React App, Angular) served by Caddy in the container. */
export const staticSpaPlaybook: Playbook = {
  id: "static-spa",
  title: "Static single-page app (served by Caddy)",
  guidance: [
    "The app is built with Node and served as static files by Caddy on port 8080 with a fallback to index.html, so it needs no server code, health endpoint or port setting.",
    "Everything in a static bundle is public. Variables such as VITE_*, REACT_APP_* or PUBLIC_* are baked into the files that browsers download.",
  ],
  steps: {
    "health-endpoint":
      "Do not add server code: Caddy answers `/` with index.html. Mark this change skipped and say so in your notes.",
    "port-config":
      "Do not change the dev-server port: the container serves the built files on port 8080. Mark this change skipped and say so in your notes.",
    "build-config":
      "Make sure the production build writes to the framework's output folder (`dist` for Vite, `build` for Create React App, `dist/<project>/browser` for Angular) and that the base path is `/`.",
    "secret-removal":
      "A secret cannot be hidden in a static app. If the value is a publishable key meant for browsers (for example a Supabase anon key or a Stripe publishable key), move it to a build-time variable (VITE_*, REACT_APP_*) and say so in your notes. Otherwise remove it from the frontend and note that the call must move to a backend or serverless function that holds the secret. In both cases say the exposed value must be rotated.",
  },
  checks: {
    "build-config": [
      "`npm run build` (or the detected package manager) writes index.html to the output folder.",
    ],
    "secret-removal": [
      "The value is gone from the source; only publishable keys remain, read from build-time variables.",
    ],
  },
};
