import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { runHostChecks } from "./checks";
import { serviceHostChecks } from "./services";

const ok = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, stdout, stderr: "" });

const MYSQL = { name: "mysql", title: "MySQL", login: ["MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"] };
const KAFKA = { name: "kafka", title: "Apache Kafka", login: [] };

/** A shell on the server answering by the command's service (`…service=<name>…`). */
function remote(answers: Record<string, { ports?: CommandResult; login?: CommandResult }>) {
  const commands: string[] = [];
  const shell: RemoteExec = {
    host: "203.0.113.10",
    async run(command) {
      commands.push(command);
      const service = /com\.docker\.compose\.service=([a-z0-9-]+)/.exec(command)?.[1] ?? "";
      const answer = answers[service];
      const result = command.includes("{{.Ports}}") ? answer?.ports : answer?.login;
      if (result === undefined) throw new Error(`unexpected command ${command}`);
      return result;
    },
  };
  return { shell, commands };
}

describe("serviceHostChecks", () => {
  it("passes a service without a published port whose login is set, and checks no login of an internal-only one", async () => {
    const { shell, commands } = remote({
      mysql: {
        ports: ok("3306/tcp, 33060/tcp\n"),
        login: ok("MYSQL_PASSWORD\nMYSQL_ROOT_PASSWORD\n"),
      },
      kafka: { ports: ok("9092/tcp\n") },
    });
    const results = await runHostChecks(shell, serviceHostChecks("shop", [MYSQL, KAFKA]));
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["service-mysql-port", "pass"],
      ["service-mysql-login", "pass"],
      ["service-kafka-port", "pass"],
    ]);
    expect(results[1]?.message).toBe(
      "MySQL (mysql) requires its login: MYSQL_PASSWORD and MYSQL_ROOT_PASSWORD are set.",
    );
    // Only the names of the variables that are set ever come back from the server.
    const login = commands.find((c) => c.includes("docker inspect")) ?? "";
    expect(login).toContain("label=com.docker.compose.project=shop");
    expect(login).toContain("sed -n -E 's/^(MYSQL_PASSWORD|MYSQL_ROOT_PASSWORD)=.+$/\\1/p'");
  });

  it("fails a published service port and a login that is not set", async () => {
    const { shell } = remote({
      mysql: {
        ports: ok("0.0.0.0:3306->3306/tcp, [::]:3306->3306/tcp\n"),
        login: ok("MYSQL_PASSWORD\n"),
      },
    });
    const [port, login] = await runHostChecks(shell, serviceHostChecks("shop", [MYSQL]));
    expect(port).toMatchObject({
      status: "fail",
      severity: "critical",
      message:
        "MySQL (mysql) publishes 0.0.0.0:3306->3306/tcp, [::]:3306->3306/tcp, so it can be reached from outside the server.",
    });
    expect(port?.remediation).toContain("opscrew/runtime/compose.yaml");
    expect(login).toMatchObject({
      status: "fail",
      severity: "high",
      message: "MySQL (mysql) runs without MYSQL_ROOT_PASSWORD, so its login is not set.",
    });
  });

  it("passes a port published on the server's loopback only, which nothing outside reaches", async () => {
    const { shell } = remote({
      kafka: { ports: ok("127.0.0.1:9092->9092/tcp, [::1]:9092->9092/tcp\n") },
    });
    const [port] = await runHostChecks(shell, serviceHostChecks("shop", [KAFKA]));
    expect(port).toMatchObject({ status: "pass" });
    const { shell: open } = remote({
      kafka: { ports: ok("127.0.0.1:9092->9092/tcp, 0.0.0.0:9093->9093/tcp\n") },
    });
    const [public9093] = await runHostChecks(open, serviceHostChecks("shop", [KAFKA]));
    expect(public9093).toMatchObject({
      status: "fail",
      message:
        "Apache Kafka (kafka) publishes 0.0.0.0:9093->9093/tcp, so it can be reached from outside the server.",
    });
  });

  it("warns when the service has no container on the server yet", async () => {
    const { shell } = remote({ mysql: { ports: ok(""), login: ok("", 1) } });
    const results = await runHostChecks(shell, serviceHostChecks("shop", [MYSQL]));
    expect(results.map((r) => r.status)).toEqual(["warn", "warn"]);
    expect(results[0]?.message).toBe(
      "MySQL (mysql) has no container on the server yet; the deploy workflow starts it.",
    );
  });
});
