# Deploy to a Plesk account

OpsCrew deploys to a [Plesk](https://www.plesk.com/) customer account through Plesk's XML API,
with a small deploy script, the agent, running on the account. How it works, what fits and what it
changes are in [Deploy to a hosting account](hosting-accounts.md); this page is what is particular
to Plesk.

Plesk is tested against a fake of its documented API so far, not on a live account.

## The variables

| Variable | What to set |
|---|---|
| `OPSCREW_HOSTING_URL` | Your Plesk's address with its port, such as `https://panel.example.com:8443`. It must start with `https://` |
| `OPSCREW_HOSTING_USER` | Your Plesk login |
| `OPSCREW_HOSTING_TOKEN` | An API key your host made for you, or your Plesk password |
| `OPSCREW_SFTP_HOST` | The account's SFTP address |
| `OPSCREW_SFTP_USER` | The account's SFTP user |
| `OPSCREW_SFTP_KEY` | The path of your SSH key file on your computer, such as `~/.ssh/id_ed25519`; never the key itself |

Plesk's API for customers can't write files, so OpsCrew writes the agent and the app's settings
over SFTP (port 22), with the `OPSCREW_SFTP_*` variables. The interview shows the SFTP host's key
for you to confirm. The token reaches what your Plesk login reaches; OpsCrew uses it only on your
computer, as [The panel's token](hosting-accounts.md#the-panels-token) says.

## What you do in Plesk

Plesk's API for customers makes hostnames and databases only. The rest is a step for you in Plesk,
listed in the plan with the exact values to enter. Provision stops after listing them; run it again
once you have done them, and it continues:

- **The agent's scheduled task,** and the app's cron jobs: in **Websites & Domains → Scheduled
  Tasks → Add Task**, choose "Run a command", paste the command the plan shows and set Run to
  "Cron style" with the schedule it shows (`* * * * *` for the agent).
- **The hostname's PHP version,** when the app needs another version than the account's.

At destroy, the plan lists the scheduled tasks for you to remove the same way.

## Its limits

- **No SFTP, no deploy:** without the `OPSCREW_SFTP_*` variables, provision stops before any change.
- **The certificate is yours:** OpsCrew neither requests nor reads it on Plesk. Get a free one in
  **Websites & Domains → *your hostname* → SSL/TLS Certificates** (Install, then Get it free);
  until then the app answers over HTTP. `npx opscrew status` reminds you to check it in Plesk.
- **Node.js and Python apps** aren't offered on Plesk.
