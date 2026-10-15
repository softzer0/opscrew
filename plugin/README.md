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

On a server you already have, the changes OpsCrew makes on the server are a plan of their own that
you approve in a dialog, and you confirm the server's SSH host key the first time. OpsCrew never asks
for a password or passphrase. Your server's address is kept on your computer and never appears in
the tools' results, in files or in pull requests: the tools show "your server" instead. An address
you type into the chat during the interview does reach Claude, though; to keep it out of the chat,
answer the interview in a terminal with `npx opscrew interview`, then continue in Claude Code.

In a Portainer you already run, the changes OpsCrew makes there are a stack plan of their own that
you approve in a dialog, and you confirm Portainer's certificate fingerprint in a dialog the first
time (Claude never confirms it for you). The access token comes only from `PORTAINER_API_KEY` in your
shell, and the tools show "your Portainer" instead of its address. Removing the app and deleting its
data stay in your terminal (`npx opscrew destroy`). See
[An existing Portainer as a deploy target](../docs/guide/portainer-target.md).

## Local development

Build the CLI (`pnpm --filter opscrew build`) and point the MCP config at it:

```json
{ "mcpServers": { "opscrew": { "command": "node", "args": ["/path/to/opscrew/packages/cli/dist/opscrew.js", "mcp"] } } }
```

Then run `claude --plugin-dir ./plugin` from the repository root, and `node plugin/validate.mjs` to
check the plugin files.
