# OpsCrew in Claude Code: the plugin

The OpsCrew plugin lets you run OpsCrew from a Claude Code chat: the security scan, the interview,
the design with real prices, the code changes and the deploy. Your Claude Code session does the
reasoning and talks to you. OpsCrew's MCP server supplies safe, deterministic tools and never calls
a model itself, so the plugin needs no extra API key.

Every change still waits for your approval of its exact plan, in a dialog that only you can answer.

## Install

Inside a Claude Code session:

```text
/plugin marketplace add softzer0/opscrew
/plugin install opscrew@opscrew
```

Or from your shell:

```bash
claude plugin marketplace add softzer0/opscrew
claude plugin install opscrew@opscrew
```

The first command adds OpsCrew's plugin marketplace, the `softzer0/opscrew` repository on GitHub.
The second installs the `opscrew` plugin from it.

## What it runs

When Claude Code installs the plugin, it also installs the OpsCrew CLI at the plugin's version
(`opscrew` from npm) and its dependencies, exactly as the plugin's `package-lock.json` pins them,
with npm and without running any install script. The plugin then starts OpsCrew's MCP server on
your computer from that copy:

```bash
node ${CLAUDE_PLUGIN_ROOT}/node_modules/opscrew/dist/opscrew.js mcp
```

You need Node.js 22 or newer and npm on your `PATH`. The download is about 35 MB. The MCP server
never calls a model, so it needs none of the Claude Agent SDK that the CLI's own AI steps install
once, when you first run one.

The server runs with your shell's environment, so it reads the same tokens as the CLI
(`HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN` and the others the guide's pages name).
Set them before you start Claude Code. Tool results never contain a token or a secret.

## The skills

| Skill | What it does |
|---|---|
| `/opscrew:opscrew-deploy` | The whole flow: scan, analyze, interview, design, prepare the code, provision and verify |
| `/opscrew:opscrew-scan` | The free security scan, with guided fixes |
| `/opscrew:opscrew-adapt` | Prepares the app's code for its deployment |

Claude also uses them on its own when you ask things like "deploy my app" or "is my app secure?".
Every target works from the chat: a cloud server, [a server you already have](own-server.md),
[your Portainer](portainer-target.md), [your own computer](localhost.md),
[Cloudflare's hosting](cloudflare-hosting.md) and [GitHub Pages](github-pages.md).

## How approvals work

- **Only you approve.** A tool that changes something shows its plan, its hash and what it costs in
  a dialog (MCP elicitation). Claude cannot answer the dialog for you, and Claude Code asks your
  permission before every such tool call, even in its auto modes.
- **Destroying plans** need you to type the resource's name in the dialog.
- **A client without dialogs** changes nothing: the tool stops and names the command to run in your
  terminal instead.
- **Your app's secrets** never pass through the chat. You enter them in your own terminal
  (`npx opscrew provision`), or OpsCrew reads them from the file `OPSCREW_APP_ENV_FILE` names.
  Never paste a token or a secret into the chat.
- **First connections:** an SSH host key or a Portainer certificate is confirmed by you in a
  dialog, never by Claude.
- **Removing an app** (`npx opscrew destroy`) stays in your terminal.

## Data and privacy

The MCP server runs on your computer, sends nothing to OpsCrew and has no telemetry. It talks only
to the services your steps need, with your own tokens: see
[Data and the services it talks to](https://github.com/softzer0/opscrew/tree/main/plugin#data-and-the-services-it-talks-to)
in the plugin's README, and OpsCrew's [privacy policy](https://opscrew.dev/privacy/).

## From the chat or from the terminal

Both work on the same files in your repository, so you can switch at any point: answer the
interview in a terminal with `npx opscrew interview` (it keeps addresses you type out of the chat),
then continue in Claude Code, or the other way round.

The plugin's own page, with the files it ships, is
[the plugin's README](https://github.com/softzer0/opscrew/tree/main/plugin).
