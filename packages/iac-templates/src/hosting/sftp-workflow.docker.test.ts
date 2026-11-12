// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
/**
 * The SFTP workflow's deploy script against a real OpenSSH SFTP-only host: one `alpine:3.24`
 * container runs sshd with a chrooted, SFTP-only user, holds the app's folder as `opscrew
 * provision` leaves it, and runs the script as GitHub Actions would, with `curl` answering as the
 * hostname's web server does (the release its `current` serves) and `sleep` returning at once.
 * Five releases deploy, the sixth fails its check and is switched back from, and a reader looks
 * at `current` all along. It pulls the image and installs packages, so it runs only with
 * OPSCREW_DOCKER_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { serverPlan } from "../workflow/__fixtures__/plans";
import { renderSftpPhpLines, renderSftpWorkflow, sftpUrl } from "./index";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the SFTP deploy on alpine: ${reason}`);

const APP = "/srv/sftp/web/home/web/opscrew/notes-prod";
const ENV_PHP = "/home/web/opscrew/notes-prod/shared/env.php";

/** The host, the app's folder as provision leaves it, the shims, the deploys, and what is left. */
function script(php: { htaccess: string; userIni: string }): string {
  return `set -eu
apk add --no-cache openssh-server openssh-client bash coreutils sed grep tar >/dev/null
ssh-keygen -A >/dev/null
adduser -D -h /home/web web
sed -i 's/^web:!/web:*/' /etc/shadow
install -d -m 0755 -o root -g root /srv/sftp/web
install -d -m 0755 -o web -g web /srv/sftp/web/home/web
ssh-keygen -q -t ed25519 -N '' -f /root/ci
install -d -m 0755 /etc/ssh/keys
install -m 0644 /root/ci.pub /etc/ssh/keys/web
cat > /etc/ssh/sshd_config <<'CONF'
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthorizedKeysFile /etc/ssh/keys/%u
Subsystem sftp internal-sftp
Match User web
  ChrootDirectory /srv/sftp/%u
  ForceCommand internal-sftp -d /home/%u
CONF
/usr/sbin/sshd -E /tmp/sshd.log
app=${APP}
install -d -o web -g web /srv/sftp/web/home/web/opscrew "$app" "$app/releases" "$app/releases/0-0" "$app/releases/0-0/public" "$app/shared" "$app/state"
ln -s releases/0-0 "$app/current"
cat > "$app/shared/env.htaccess" <<'LINES'
${php.htaccess}LINES
cat > "$app/shared/env.user.ini" <<'LINES'
${php.userIni}LINES
chown -hR web:web "$app"
mkdir /shims
cat > /shims/curl <<'SHIM'
#!/bin/sh
# The hostname's web server: no certificate yet, and each answer names the release current serves.
case "$*" in *"-D -"*) ;; *) exit 60 ;; esac
served=$(grep -o 'X-OpsCrew-Release "[^"]*"' ${APP}/current/public/.htaccess 2>/dev/null | cut -d '"' -f 2)
code=200
if [ -f /tmp/broken ]; then code=500; fi
printf 'HTTP/1.1 %s Status\\r\\nServer: LiteSpeed\\r\\nX-OpsCrew-Release: %s\\r\\n\\r\\n' "$code" "$served"
SHIM
printf '#!/bin/sh\\nexit 0\\n' > /shims/sleep
chmod +x /shims/curl /shims/sleep
# A reader of current, all along.
(n=0; while [ ! -f /tmp/stop ]; do [ -e "$app/current/public" ] || echo missing >> /tmp/reader.log; n=$((n + 1)); done; echo "reads $n" >> /tmp/reader.log) &
known=$(ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null)
deploy() {
  rm -rf /work
  mkdir -p /work/tmp /work/src/public
  printf '<?php echo %s;\\n' "$1" > /work/src/public/index.php
  printf 'RewriteRule ^old$ /new [R=301,L]\\n' > /work/src/public/.htaccess
  tar -cf /work/tmp/release.tar -C /work/src .
  set +e
  env GITHUB_RUN_ID="$1" GITHUB_RUN_ATTEMPT=1 RUNNER_TEMP=/work/tmp \\
    SFTP_URL='${sftpUrl({ host: "127.0.0.1", port: 22, user: "web" }, "opscrew/notes-prod")}' \\
    SFTP_KEY="$(cat /root/ci)" KNOWN_HOSTS="$known" PATH="/shims:$PATH" \\
    bash /t/deploy.sh > "/tmp/deploy-$1.log" 2>&1
  echo "deploy $1: exit $?"
  set -e
}
for run in 101 102 103 104; do deploy $run; done
# A file of root's in release 101-1: the SFTP user can't remove that release.
mkdir "$app/releases/101-1/locked"
touch "$app/releases/101-1/locked/file"
deploy 105
echo "--- status 105"
cat "$app/state/status"
echo "--- log 105"
grep '::warning::' /tmp/deploy-105.log
# A re-run of an earlier run: refused, and current stays.
deploy 100
echo "--- status 100"
cat "$app/state/status"
echo "--- current 100: $(readlink "$app/current")"
grep '::error::' /tmp/deploy-100.log
touch /tmp/broken
deploy 106
touch /tmp/stop
sleep 1
echo "releases: $(ls "$app/releases" | tr '\\n' ' ')"
echo "current: $(readlink "$app/current")"
echo "--- status"
cat "$app/state/status"
echo "--- htaccess"
cat "$app/current/public/.htaccess"
echo "--- user.ini"
cat "$app/current/public/.user.ini"
echo "--- reader"
cat /tmp/reader.log
echo "--- left"
ls -A "$app"
echo "--- 106"
cat /tmp/deploy-106.log
`;
}

describe.skipIf(reason !== undefined)("the SFTP deploy script on an OpenSSH SFTP-only host", () => {
  it("deploys, keeps 3 (warning of one it can't remove), refuses an older run, switches back from a failed release, and never leaves current missing", {
    timeout: 300_000,
  }, () => {
    const base = serverPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      target: {
        provider: "hosting",
        panel: "sftp",
        app: "php",
        webRoot: "public",
        php: { version: "8.3", via: "account" },
      },
      services: [],
      externalServices: [],
      dns: { provider: "none", domain: "shop.example.com", proxied: false, www: false },
      security: { ...base.security, httpAllowedFrom: "any" },
    });
    const flow = parse(renderSftpWorkflow(plan).content) as {
      jobs: { deploy: { steps: { name?: string; run?: string }[] } };
    };
    const deploy = flow.jobs.deploy.steps.find(
      (s) => s.name === "Upload, switch and check the release",
    );
    const dir = mkdtempSync(join(tmpdir(), "opscrew-sftp-deploy-"));
    try {
      writeFileSync(join(dir, "deploy.sh"), deploy?.run ?? "");
      writeFileSync(join(dir, "run.sh"), script(renderSftpPhpLines(ENV_PHP)));
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--label",
          "opscrew-test=sftp",
          "-v",
          `${dir}:/t:ro`,
          "alpine:3.24",
          "sh",
          "/t/run.sh",
        ],
        { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      );
      const out = result.stdout;
      expect(result.status, `${out}\n${result.stderr}`).toBe(0);
      for (const run of [101, 102, 103, 104, 105]) expect(out).toContain(`deploy ${run}: exit 0`);
      expect(out).toContain("deploy 100: exit 1");
      expect(out).toContain("deploy 106: exit 1");
      // 105-1 serves and is recorded although 101-1, which the SFTP user can't remove, stays.
      const at = "at=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\n";
      expect(/--- status 105\n([\s\S]*?)--- log 105/.exec(out)?.[1]).toMatch(
        new RegExp(
          `^running=105-1\\nprevious=104-1\\nkept=104-1,103-1,102-1,101-1\\nattempt=105-1\\nresult=deployed\\nreason=\\n${at}$`,
        ),
      );
      expect(out).toContain(
        "--- log 105\n::warning::OpsCrew couldn't remove release 101-1 from the host; remove opscrew/notes-prod/releases/101-1 there yourself.\n",
      );
      // An older run's release is refused before anything is uploaded or switched.
      expect(/--- status 100\n([\s\S]*?)--- current 100/.exec(out)?.[1]).toMatch(
        new RegExp(
          `^running=105-1\\nprevious=104-1\\nkept=104-1,103-1,102-1,101-1\\nattempt=100-1\\nresult=refused\\nreason=it is older than release 105-1, which runs\\n${at}$`,
        ),
      );
      expect(out).toContain(
        "--- current 100: releases/105-1\n::error::Release 100-1 refused: it is older than release 105-1, which runs.",
      );
      // The running release and the 3 before it, and 101-1 left behind; the placeholder and 106-1
      // are gone.
      expect(out).toContain("releases: 101-1 102-1 103-1 104-1 105-1 \n");
      expect(out).toContain("current: releases/105-1\n");
      const status = /--- status\n([\s\S]*?)--- htaccess/.exec(out)?.[1] ?? "";
      expect(status).toMatch(
        new RegExp(
          `^running=105-1\\nprevious=104-1\\nkept=104-1,103-1,102-1,101-1\\nattempt=106-1\\nresult=failed\\nreason=shop\\.example\\.com/api/health didn't answer 2xx or 3xx with it \\(it answered 500 with release 106-1\\); switched back to 105-1\\n${at}$`,
        ),
      );
      const htaccess = /--- htaccess\n([\s\S]*?)--- user\.ini/.exec(out)?.[1] ?? "";
      expect(htaccess).toBe(
        [
          "# BEGIN OpsCrew",
          "RewriteEngine On",
          "RewriteCond %{HTTP_HOST} !^shop\\.example\\.com(:[0-9]+)?$ [NC]",
          "RewriteRule ^ - [F]",
          "Options -Indexes",
          '<FilesMatch "^\\.">',
          "Require all denied",
          "</FilesMatch>",
          'Header always set X-Content-Type-Options "nosniff"',
          'Header always set X-Frame-Options "SAMEORIGIN"',
          'Header always set Referrer-Policy "strict-origin-when-cross-origin"',
          'Header always set X-OpsCrew-Release "105-1"',
          renderSftpPhpLines(ENV_PHP).htaccess.trimEnd(),
          "# END OpsCrew",
          "# BEGIN OpsCrew: app",
          "RewriteRule ^old$ /new [R=301,L]",
          "# END OpsCrew: app",
          "",
        ].join("\n"),
      );
      expect(out).toContain(`--- user.ini\n${renderSftpPhpLines(ENV_PHP).userIni}--- reader`);
      expect(out).toMatch(/--- reader\nreads \d+\n--- left/);
      // Nothing temporary is left beside current.
      expect(out).toContain("--- left\ncurrent\nreleases\nshared\nstate\n--- 106");
      expect(out).toContain(
        "::error::Release 106-1 failed: shop.example.com/api/health didn't answer 2xx or 3xx",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
