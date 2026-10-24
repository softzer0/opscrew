# OpsCrew plugin for Claude Code

Use OpsCrew from inside Claude Code: security scans, deployment planning with real prices, code
preparation and deploys to your own cloud. Your Claude Code session does the reasoning; OpsCrew's MCP
server provides safe, deterministic tools and never calls a model itself, so no extra API key is
needed for the plugin.

## Install

```bash
claude plugin marketplace add softzer0/opscrew
claude plugin install opscrew@opscrew
```

Or inside a Claude Code session: `/plugin marketplace add softzer0/opscrew`, then
`/plugin install opscrew@opscrew`.

When Claude Code installs the plugin, it also installs the OpsCrew CLI at the plugin's version
(`opscrew` 0.1.0 from npm) and its dependencies, exactly as `package-lock.json` pins them, with npm
and without running any install script. The plugin's MCP server then runs that copy:
`node ${CLAUDE_PLUGIN_ROOT}/node_modules/opscrew/dist/opscrew.js mcp`. You need Node.js 22+ and npm
on your PATH. The download is about 350 MB, most of it the Claude Code binary that the Claude Agent
SDK brings for the CLI's own AI steps; the MCP server itself never calls a model.

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

## Data and the services it talks to

The MCP server runs on your computer. It never calls a model and sends nothing to OpsCrew: there is
no OpsCrew service and no telemetry. What it writes stays in your repository (`opscrew/`) and in
the local state folder `.opscrew/`, which `opscrew init` offers to add to `.gitignore`.

**Personal data:** the interview can ask for a contact email for certificates and alerts. It is
stored in `opscrew/requirements.yaml` in your repository and given to your server's certificate
setup. Domain registrars use your account's own contact; OpsCrew never collects registrant details.

It talks to these services, with the tokens you set in your own environment, and only for the
steps you run:

- **GitHub** (api.github.com): your repository, pull requests, Actions secrets and workflows.
- **Hetzner Cloud and DigitalOcean:** servers, firewalls, volumes, object storage, and live prices
  for the cost estimates.
- **Cloudflare:** DNS records, TLS settings, rules and Workers; DNS-over-HTTPS lookups
  (cloudflare-dns.com) when it checks a site.
- **Porkbun, Namecheap and GoDaddy**, only in the `domain` steps: availability, prices, purchases
  and nameservers.
- **Your own servers** over SSH, and **your Portainer** through its API, when you deploy there.
- **OSV** (api.osv.dev): the scan sends your dependencies' names and versions to look up known
  vulnerabilities.
- **npm and container registries** (Docker Hub, ghcr.io and others), read anonymously for the
  package and image versions OpsCrew pins.
- **Your live site:** `verify` and `secure` send it HTTP requests and connect to its ports.

## Privacy

OpsCrew's privacy policy: [opscrew.dev/privacy](https://opscrew.dev/privacy/).

## Local development

With `claude --plugin-dir ./plugin`, Claude Code loads the folder in place and doesn't install its
dependencies: run `npm ci --ignore-scripts` in `plugin/` first. Or build the CLI
(`pnpm --filter opscrew build`) and point the MCP config at it:

```json
{ "mcpServers": { "opscrew": { "command": "node", "args": ["/path/to/opscrew/packages/cli/dist/opscrew.js", "mcp"] } } }
```

Then run `claude --plugin-dir ./plugin` from the repository root, and `node plugin/validate.mjs` to
check the plugin files.
