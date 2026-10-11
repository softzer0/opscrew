import type { Playbook } from "./types";

/** Fallback playbook: framework-neutral instructions for every kind of code change. */
export const genericPlaybook: Playbook = {
  id: "generic",
  title: "Generic app",
  guidance: [
    "Keep the app's behaviour exactly as it is; only make it ready to run in a container.",
    "Follow the code style already used in the file you edit.",
    "The container receives its configuration through environment variables at run time.",
  ],
  steps: {
    dockerfile:
      "Write a production Dockerfile at the listed path: a pinned official base image, a separate build stage when the app has a build step, dependencies installed from the lockfile, the app started with its production start command, listening on the PORT environment variable, and a non-root USER. Never copy .env files into the image.",
    dockerignore:
      "List .git, .env, .env.* (but keep !.env.example), dependency folders, build output, caches, logs and the opscrew/ and .opscrew/ folders so they never reach the image.",
    "health-endpoint":
      'Add a GET endpoint at the health path that answers HTTP 200 with a small JSON body such as {"status":"ok"}. It must not need authentication, must not call the database or other services, and must not be cached. Register it before any authentication middleware.',
    "port-config":
      "Read the listening port from the PORT environment variable and keep the current number as the default when PORT is not set. Listen on all interfaces (0.0.0.0), not only localhost, so the container is reachable.",
    "env-example":
      "Create the listed .env.example with one line per environment variable the app reads, in the form NAME= with an empty value. Never copy a value from .env or anywhere else.",
    "build-config":
      "Adjust the build configuration so the production build works inside the container and produces exactly what the start command runs. Do not change development settings.",
    "secret-removal":
      "Replace the hard-coded secret in the listed file with a read from an environment variable that has a clear UPPER_SNAKE_CASE name. Do not keep the old value anywhere: not as a fallback, not in a comment, not in a test. Add the variable name (without a value) to .env.example when that file exists. Say in your notes that the exposed value must be rotated.",
    other: "Make the change described in the reason, keeping the app's behaviour unchanged.",
  },
  checks: {
    dockerfile: [
      "The image builds with `docker build .` from the repository root.",
      "The final stage sets a non-root USER and starts the production server.",
    ],
    dockerignore: [".env and .git are excluded; .env.example is not."],
    "health-endpoint": [
      "A GET request to the health path returns status 200 without credentials.",
      "The handler does not touch the database or any external service.",
    ],
    "port-config": [
      "Starting the app with PORT=8081 makes it listen on port 8081.",
      "Without PORT it still listens on the previous port.",
    ],
    "env-example": ["Every variable has a name and an empty value; no real values appear."],
    "build-config": [
      "The production build command succeeds and the start command uses its output.",
    ],
    "secret-removal": [
      "The secret value no longer appears anywhere in the repository files you touched.",
      "The code reads the value from an environment variable instead.",
    ],
    other: ["The change described in the reason is in place and nothing else changed."],
  },
};
