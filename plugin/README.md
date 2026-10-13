# OpsCrew plugin for Claude Code

Use OpsCrew from inside Claude Code: security scans, deployment planning with real prices, code
preparation and deploys to your own cloud. Your Claude Code session does the reasoning; OpsCrew's MCP
server provides safe, deterministic tools and never calls a model itself, so no extra API key is
needed for the plugin.

## Install

```bash
claude plugin marketplace add opscrew/opscrew
claude plugin install opscrew@opscrew
```

Or inside a Claude Code session: `/plugin marketplace add opscrew/opscrew`, then
`/plugin install opscrew@opscrew`.

The plugin starts the OpsCrew MCP server with `npx -y opscrew@0.1.0 mcp`, so Node.js 22+ must be
installed. On native Windows, if the server fails to start, change `plugin/.mcp.json` to use
`"command": "cmd", "args": ["/c", "npx", "-y", "opscrew@0.1.0", "mcp"]`.

## Skills

| Skill | What it does |
|---|---|
| `/opscrew:opscrew-deploy` | The full flow: scan → analyze → interview → design → prepare code → provision → verify |
| `/opscrew:opscrew-scan` | Free security scan and guided fixes |
| `/opscrew:opscrew-adapt` | Prepare the code for container deployment |

Claude also uses these skills on its own when you ask things like "deploy my app" or "is my app
secure?".

## Safety

Infrastructure changes always go through an OpsCrew plan that you approve. Production secrets are
entered in your own terminal (`npx opscrew provision`) and go straight to GitHub's encrypted secret
store; they never pass through the chat.

## Local development

Build the CLI (`pnpm --filter opscrew build`) and point the MCP config at it:

```json
{ "mcpServers": { "opscrew": { "command": "node", "args": ["/path/to/opscrew/packages/cli/dist/opscrew.js", "mcp"] } } }
```

Then run `claude --plugin-dir ./plugin` from the repository root, and `node plugin/validate.mjs` to
check the plugin files.
