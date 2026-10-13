import { defineConfig } from "tsup";

export default defineConfig({
  entry: { opscrew: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // Workspace packages are consumed from TypeScript source, so they are bundled. Everything in
  // the `opscrew` package's `dependencies` (commander, zod, the Claude Agent SDK, the MCP SDK...)
  // stays external, which tsup does by default; the two SDKs are listed to make that explicit.
  noExternal: [/^@opscrew\//],
  external: ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk"],
  banner: { js: "#!/usr/bin/env node" },
});
