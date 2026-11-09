import { fakeSecret } from "@opscrew/core/testing";
import type { CredentialsRecord, DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  BETTER_AUTH_MARKERS,
  basicAuthStatusScript,
  beszelStatuses,
  beszelStatusScript,
  betterAuthScript,
  cookieHeader,
  cookieSessions,
  credentialOf,
  envValueScript,
  generatedSecret,
  generatesVariable,
  inContainerWithInput,
  LARAVEL_ROUTES,
  listedCredentials,
  listedWindowSeconds,
  loginAnswer,
  loginScript,
  passSkip,
  postStatusScript,
  promptKeys,
  ptyCommand,
  ROTATION_GATE,
  recordProblems,
  rotationHashes,
  selectedPasses,
  statedWindowSeconds,
  terminalLauncher,
  terminalPrompts,
  tunnelConnections,
  versionSecretNames,
  WINDOW_SLACK_SECONDS,
  windowAcceptor,
  withCookies,
  withExampleVariables,
  withGarageBucket,
  withServices,
} from "./rotation-support";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("the passes", () => {
  it("reads the gate's comma list, and the names that are no pass", () => {
    expect(selectedPasses(" services, keys,,tunnel ")).toEqual({
      passes: ["services", "keys", "tunnel"],
      unknown: [],
    });
    expect(selectedPasses("services,servises")).toEqual({
      passes: ["services"],
      unknown: ["servises"],
    });
    expect(selectedPasses(undefined)).toEqual({ passes: [], unknown: [] });
  });

  it("says why a pass is skipped: not named, then each missing variable", () => {
    const env = {
      [ROTATION_GATE]: "keys",
      OPSCREW_E2E_HCLOUD_TOKEN: "t",
      OPSCREW_E2E_GITHUB_REPO: "o/r",
      OPSCREW_E2E_GITHUB_TOKEN: "t",
      OPSCREW_E2E_CLOUDFLARE_TOKEN: "t",
      OPSCREW_E2E_DOMAIN: "e2e.example.com",
    };
    expect(passSkip(env, "keys")).toBeUndefined();
    expect(passSkip(env, "services")).toBe(`set ${ROTATION_GATE}=services`);
    expect(passSkip({ ...env, [ROTATION_GATE]: "portainer" }, "portainer")).toBe(
      "set OPSCREW_E2E_GHCR_READ_TOKEN",
    );
    expect(passSkip({ [ROTATION_GATE]: "sites" }, "sites", ["OPSCREW_E2E_GITHUB_REPO_C"])).toBe(
      "set OPSCREW_E2E_GITHUB_REPO_C",
    );
  });
});

describe("the plans and the values", () => {
  const plan = {
    app: { env: [{ name: "BETTER_AUTH_SECRET", source: "generated" }, { name: "MODE" }] },
    services: [{ name: "db", kind: "postgres" }],
    storage: { objectStorage: { provider: "r2", bucket: "shop-uploads", region: "auto" } },
  } as unknown as DeployPlan;

  it("adds the services a plan does not have, from the catalog", () => {
    const added = withServices(plan, { db: "postgres", cache: "valkey", mq: "rabbitmq" });
    expect(added.services.map((s) => [s.name, s.kind])).toEqual([
      ["db", "postgres"],
      ["cache", "valkey"],
      ["mq", "rabbitmq"],
    ]);
    expect(added.services[1]?.version).toMatch(/\d/);
    expect(added.services[1]?.options).toEqual({ mode: "cache" });
  });

  it("keeps the bucket in Garage, and needs one", () => {
    expect(withGarageBucket(plan).storage?.objectStorage).toEqual({
      provider: "garage",
      bucket: "shop-uploads",
      region: "auto",
    });
    expect(() => withGarageBucket({ ...plan, storage: {} } as DeployPlan)).toThrow(/no bucket/);
  });

  it("reads a generated value by its path, naming only the path when it is missing", () => {
    const password = fakeSecret("generic-password", "db");
    const json = { services: { db: { password } }, env: { APP_KEY: "" } };
    expect(generatedSecret(json, ["services", "db", "password"])).toBe(password);
    expect(() => generatedSecret(json, ["env", "APP_KEY"])).toThrow(/hold no env\.APP_KEY/);
    expect(() => generatedSecret(null, ["services"])).toThrow(/hold no services/);
  });

  it("says whether the plan generates a variable", () => {
    expect(generatesVariable(plan, "BETTER_AUTH_SECRET")).toBe(true);
    expect(generatesVariable(plan, "MODE")).toBe(false);
  });
});

describe("what a rotation printed", () => {
  it("collects every hash it asks to approve, once, in order", () => {
    const output = [
      `Rotation hash: ${HASH}`,
      `hint: Run \`opscrew rotate db\` again when you are ready (in a script: --approve ${HASH}).`,
      `Plan hash: ${OTHER}`,
      `Host plan hash: ${"c".repeat(64)}`,
      `Undo hash: ${"d".repeat(64)}`,
      `Its stack plan's hash: ${"e".repeat(64)} (2 changes).`,
    ].join("\n");
    expect(rotationHashes(output)).toEqual([HASH, OTHER, "c".repeat(64), "d".repeat(64)]);
    expect(rotationHashes("nothing to approve")).toEqual([]);
  });

  it("reads the longest window the plan states", () => {
    const plan = [
      "db (PostgreSQL), its password: a short swap: new connections the running app opens to PostgreSQL fail for about 30 seconds, from the change until the app's switch; open connections stay.",
      "mysql (MySQL), its password: seamless: MySQL accepts the old and the new value until the app runs on the new one, then only the new one.",
      "search (Meilisearch), its master key: a restart: Meilisearch restarts with the new value (about 5 seconds, answering no one meanwhile), and new connections the running app opens to it fail until its switch, about 35 seconds in all.",
    ].join("\n");
    expect(statedWindowSeconds(plan)).toBe(35);
    expect(statedWindowSeconds("cache (Valkey), its password: seamless: …")).toBe(0);
    expect(
      statedWindowSeconds(
        "garage (Garage), its key: seamless for the app: Garage restarts with the new value beside the old one (about 2 seconds, answering no one meanwhile)",
      ),
    ).toBe(2);
  });

  it("accepts failures within one window from the first, and none without a window", () => {
    const accept = windowAcceptor(30);
    expect(accept("2026-11-09T10:00:00.000Z")).toContain("within the window of about 30 seconds");
    expect(accept(`2026-11-09T10:00:${30 + WINDOW_SLACK_SECONDS}.000Z`)).toBeDefined();
    expect(accept("2026-11-09T10:01:30.000Z")).toBeUndefined();
    expect(windowAcceptor(0)("2026-11-09T10:00:00.000Z")).toBeUndefined();
  });

  it("parses rotate --json and finds a credential by name", () => {
    const stdout = JSON.stringify({
      app: "shop",
      environment: "staging",
      credentials: [
        {
          name: "db",
          kind: "service",
          rotation: { mode: "swap", seconds: 30 },
          changes: "DATABASE_URL follows.",
          date: { at: "2026-11-01T00:00:00.000Z", source: "first-deploy" },
        },
        { name: "hetzner", kind: "user-token", rotation: { mode: "replace" }, changes: "" },
      ],
    });
    const listed = listedCredentials(stdout);
    expect(credentialOf(listed, "db").rotation).toEqual({ mode: "swap", seconds: 30 });
    expect(listedWindowSeconds(listed, ["db", "hetzner"])).toBe(30);
    expect(listedWindowSeconds(listed, ["hetzner"])).toBe(0);
    expect(() => credentialOf(listed, "cache")).toThrow(/lists db, hetzner/);
    expect(() => listedCredentials(JSON.stringify({ credentials: [{}] }))).toThrow(/another shape/);
  });
});

describe("recordProblems", () => {
  const since = new Date("2026-11-09T10:00:00.000Z");
  const record: CredentialsRecord = {
    schemaVersion: 1,
    environments: {
      staging: {
        db: { generation: 2, rotatedAt: "2026-11-09T10:05:00.000Z" },
        mysql: { generation: 3, rotatedAt: "2026-11-09T10:05:00.000Z" },
        queue: { generation: 2, rotatedAt: "2026-11-01T10:05:00.000Z" },
      },
    },
  };

  it("names the entry missing, the wrong generation and an old date", () => {
    expect(recordProblems(record, "staging", { db: 2 }, since)).toEqual([]);
    expect(recordProblems(record, "staging", { mysql: 2, queue: 2, cache: 2 }, since)).toEqual([
      "the record has mysql at generation 3, not 2",
      "the record does not date queue's rotation in this run",
      "the record has no cache in staging",
    ]);
    expect(recordProblems(record, "prod", { db: 2 }, since)).toEqual([
      "the record has no db in prod",
    ]);
  });
});

describe("logging in with a value on standard input", () => {
  it("reads the value from stdin, never from its arguments, and says ok or refused", () => {
    for (const kind of ["postgres", "mysql", "valkey", "rabbitmq"] as const) {
      const script = loginScript(kind);
      expect(script.startsWith("IFS= read -r v;"), kind).toBe(true);
      expect(script).toContain("echo 'login ok'");
      expect(script).toContain("echo 'login refused'");
    }
    expect(loginScript("postgres", { user: "opscrew_monitor", database: "postgres" })).toContain(
      "-U opscrew_monitor -d postgres",
    );
    expect(loginScript("mysql")).toContain('MYSQL_PWD="$v" mysql -h 127.0.0.1 -uapp');
    // Not 127.0.0.1, which the PostgreSQL image trusts without a password.
    expect(loginScript("postgres")).toContain(`psql -h "$(hostname -i | cut -d ' ' -f1)" -U app`);
    expect(() => loginScript("postgres", { user: "app; rm" })).toThrow(/plain name/);
  });

  it("reads the login's answer", () => {
    expect(loginAnswer("login ok\n")).toBe(true);
    expect(loginAnswer("noise\nlogin refused")).toBe(false);
    expect(() => loginAnswer("")).toThrow(/neither/);
  });

  it("runs a script in a service's container with its stdin passed on", () => {
    const command = inContainerWithInput("shop", "db", "echo hi");
    expect(command).toContain("label=com.docker.compose.service=db");
    expect(command).toContain(`docker exec -i "$c" sh -c`);
    expect(command).toContain(Buffer.from("echo hi").toString("base64"));
    expect(() => inContainerWithInput("shop", "db;x", "echo")).toThrow(/plain name/);
  });

  it("compares a container's variable with the value on stdin, printing none", () => {
    const script = envValueScript("APP_PREVIOUS_KEYS");
    expect(script).toContain(`[ -z "\${APP_PREVIOUS_KEYS:-}" ]`);
    expect(script).toContain('[ "$APP_PREVIOUS_KEYS" = "$v" ]');
    expect(script).not.toContain("echo $APP");
    expect(() => envValueScript("x y")).toThrow(/variable/);
  });

  it("sends a login body or basic auth from stdin and prints only the status", () => {
    const post = postStatusScript("https://127.0.0.1:9443/api/auth", true);
    expect(post).toContain("--data-binary @-");
    expect(post).toContain("curl -sk");
    expect(post).toContain("-w '%{http_code}'");
    expect(() => postStatusScript("https://example.com/api/auth")).toThrow(/loopback/);
    const basic = basicAuthStatusScript("http://10.100.0.3:3000/api/user");
    expect(basic).toContain("-K -");
    expect(basic).toContain(`printf 'user = "admin:%s"\\n' "$pw"`);
  });

  it("signs in to Beszel's hub from stdin and prints the systems' statuses only", () => {
    const script = beszelStatusScript("http://127.0.0.1:8090", "admin@opscrew.invalid");
    expect(script.startsWith("IFS= read -r pw")).toBe(true);
    expect(script).toContain("/api/collections/users/auth-with-password");
    expect(script).toContain("-K -");
    expect(beszelStatuses("status up\nstatus down\nno sign-in\n")).toEqual(["up", "down"]);
    expect(() => beszelStatusScript("http://10.0.0.1:8090", "a@b")).toThrow(/loopback/);
  });
});

describe("the session checks", () => {
  it("keeps the cookies an answer sets, and drops a deleted one", () => {
    const session = fakeSecret("generic-password", "session");
    let jar = withCookies({}, [
      `laravel_session=${session}; path=/; httponly`,
      "XSRF-TOKEN=abc; path=/",
    ]);
    expect(cookieHeader(jar)).toBe(`laravel_session=${session}; XSRF-TOKEN=abc`);
    jar = withCookies(jar, "XSRF-TOKEN=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT");
    expect(jar).toEqual({ laravel_session: session });
    expect(withCookies(jar, undefined)).toEqual(jar);
  });

  it("adds the routes, keeps sessions in their cookie and lists the variables", () => {
    expect(LARAVEL_ROUTES).toContain("Route::get('/e2e-session'");
    expect(LARAVEL_ROUTES).toContain("Crypt::decryptString");
    expect(cookieSessions("x\n    'driver' => env('SESSION_DRIVER', 'database'),\n")).toBe(
      "x\n    'driver' => 'cookie',\n",
    );
    expect(() => cookieSessions("'driver' => 'file',")).toThrow(/SESSION_DRIVER/);
    expect(withExampleVariables("", ["BETTER_AUTH_SECRET"])).toBe("BETTER_AUTH_SECRET=\n");
    expect(withExampleVariables("A=1", ["A", "B"])).toBe("A=1\nB=\n");
  });
});

describe("a rotation in a terminal", () => {
  it("counts each prompt once, while it waits, colours and redraws aside", () => {
    const output = [
      "\u001b[36m◆\u001b[39m  Approve this change?\n│  ● Yes / ○ No",
      "\u001b[1A◇  Approve this change?\n│  Yes",
      "* Approve this change?",
      '◆  Type "shop" to approve, or anything else to cancel',
    ].join("\n");
    const prompts = terminalPrompts(output);
    expect(prompts).toEqual([
      { kind: "approve" },
      { kind: "approve" },
      { kind: "type", phrase: "shop" },
    ]);
    expect(promptKeys({ kind: "approve" })).toBe("y");
    expect(promptKeys({ kind: "type", phrase: "shop" })).toBe("shop\r");
  });

  it("runs the command in a pty with the platform's script", () => {
    expect(ptyCommand("linux", ["node", "/a b/opscrew.js", "rotate", "tunnel-token"])).toEqual({
      command: "script",
      args: ["-qefc", "'node' '/a b/opscrew.js' 'rotate' 'tunnel-token'", "/dev/null"],
    });
    expect(ptyCommand("darwin", ["node", "x.js"])).toEqual({
      command: "script",
      args: ["-q", "/dev/null", "node", "x.js"],
    });
  });

  it("writes a launcher that sets the run's settings, unsets CI and keeps the exit code", () => {
    const launcher = terminalLauncher(
      "/tmp/run/repo",
      {
        set: { OPSCREW_HOME: "/tmp/run/home", GITHUB_TOKEN: "it's" },
        unset: ["HCLOUD_TOKEN"],
      },
      ["node", "/cli/opscrew.js", "rotate", "tunnel-token"],
      "/tmp/run/exit",
    );
    expect(launcher).toContain("cd '/tmp/run/repo' || exit 1");
    expect(launcher).toContain(`export GITHUB_TOKEN='it'"'"'s'`);
    expect(launcher).toContain("unset HCLOUD_TOKEN CI");
    expect(launcher).toContain("echo $? > '/tmp/run/exit'");
    expect(() => terminalLauncher("/", { set: { "A B": "x" }, unset: [] }, ["x"], "/e")).toThrow(
      /variable/,
    );
  });
});

describe("Cloudflare's answers", () => {
  it("reads a tunnel's connectors and connections", () => {
    expect(
      tunnelConnections({
        result: [
          { id: "c1", conns: [{ id: "x1" }, { id: "x2" }] },
          { id: "c2", conns: null },
        ],
      }),
    ).toEqual({ connectors: ["c1", "c2"], connections: ["x1", "x2"] });
    expect(() => tunnelConnections({ result: "no" })).toThrow(/another shape/);
  });

  it("reads a Worker version's secrets by name", () => {
    expect(
      versionSecretNames({
        result: {
          resources: {
            bindings: [
              { type: "secret_text", name: "BETTER_AUTH_SECRETS" },
              { type: "plain_text", name: "MODE" },
              { type: "secret_text", name: "BETTER_AUTH_SECRET" },
            ],
          },
        },
      }),
    ).toEqual(["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS"]);
    expect(versionSecretNames({ result: { resources: {} } })).toEqual([]);
  });
});

describe("the Better Auth check", () => {
  it("reads its values from the environment and prints only its markers", () => {
    const script = betterAuthScript();
    expect(script).toContain("process.env.E2E_USER_PASSWORD");
    expect(script).not.toContain("BETTER_AUTH_SECRET=");
    for (const marker of Object.values(BETTER_AUTH_MARKERS)) expect(script).toContain(marker);
  });
});
