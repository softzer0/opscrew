import { defineConfig } from "tsup";

export default defineConfig({
  entry: { opscrew: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // Workspace packages are consumed from TypeScript source, so they are bundled. Everything in
  // the `opscrew` package's `dependencies` and `peerDependencies` (commander, zod, the MCP SDK,
  // the Claude Agent SDK...) stays external, which tsup does by default; the two SDKs are listed
  // to make that explicit. The Claude Agent SDK is an optional peer that runtime-claude imports
  // only when an AI step runs, installing it once when it is missing.
  noExternal: [/^@opscrew\//],
  external: ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk"],
  banner: { js: "#!/usr/bin/env node" },
});
