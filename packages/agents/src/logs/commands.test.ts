import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  dockerCommand,
  dockerLogLine,
  listArgs,
  logsArgs,
  parseSince,
  remoteFollow,
  remoteRead,
} from "./commands";

/** Names that must never reach a command: shell syntax, options, spaces, empty. */
const UNCHECKED = [
  "shop-app-1; reboot",
  "shop-app-1 && reboot",
  "$(reboot)",
  "`reboot`",
  "shop app",
  "-v",
  "--follow",
  "shop-app-1\nreboot",
  "shop|app",
  "'shop'",
  "",
];

describe("the fixed docker commands", () => {
  it("lists a part's containers by the Compose labels of its project and service", () => {
    expect(dockerCommand(listArgs("shop", "worker"))).toBe(
      "docker ps -a --filter label=com.docker.compose.project=shop --filter label=com.docker.compose.service=worker --filter label=com.docker.compose.oneoff=False --format '{{.Names}}'",
    );
  });

  it("reads a container's latest lines with their times, since a time, and following", () => {
    expect(dockerCommand(logsArgs("shop-app-1", { tail: 200 }))).toBe(
      "docker logs --timestamps --tail 200 shop-app-1",
    );
    expect(
      dockerCommand(
        logsArgs("shop-app-1", { tail: 50, since: "1761642000.000000124", follow: true }),
      ),
    ).toBe("docker logs --timestamps --tail 50 --since 1761642000.000000124 --follow shop-app-1");
  });

  it("follows over SSH inside the wrapper that ends the follower when ssh goes (spike result 8)", () => {
    const args = logsArgs("shop-app-1", { tail: 200, follow: true });
    expect(remoteFollow(args, false)).toBe(
      "docker logs --timestamps --tail 200 --follow shop-app-1 & p=$!; while kill -0 $PPID 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null; wait $p",
    );
  });

  it("through sudo, watches the login shell's parent, which the outer shell passes in", () => {
    const args = logsArgs("shop-app-1", { tail: 200, follow: true });
    expect(remoteFollow(args, true)).toBe(
      `sudo -n sh -c 'docker logs --timestamps --tail 200 --follow shop-app-1 & p=$!; while kill -0 "$0" 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null; wait $p' "$PPID"`,
    );
    expect(remoteRead(logsArgs("shop-app-1", { tail: 200 }), true)).toBe(
      "sudo -n docker logs --timestamps --tail 200 shop-app-1",
    );
    expect(remoteRead(logsArgs("shop-app-1", { tail: 200 }), false)).toBe(
      "docker logs --timestamps --tail 200 shop-app-1",
    );
  });

  it("builds no command from an unchecked name, project, service, tail or since", () => {
    for (const name of UNCHECKED) {
      expect(() => logsArgs(name, { tail: 200 }), name).toThrow(OpsCrewError);
      expect(() => listArgs(name, "app"), name).toThrow(OpsCrewError);
      expect(() => listArgs("shop", name), name).toThrow(OpsCrewError);
    }
    for (const tail of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => logsArgs("shop-app-1", { tail }), String(tail)).toThrow(OpsCrewError);
    }
    for (const since of ["15m", "1761642000;reboot", "-1", "1761642000.1", "$(date +%s)", ""]) {
      expect(() => logsArgs("shop-app-1", { tail: 1, since }), since).toThrow(OpsCrewError);
    }
  });
});

describe("parseSince", () => {
  it("reads 30s, 15m, 2h and 3d as seconds", () => {
    expect(parseSince("30s")).toBe(30);
    expect(parseSince("15m")).toBe(900);
    expect(parseSince("2h")).toBe(7_200);
    expect(parseSince("3d")).toBe(259_200);
  });

  it("refuses anything else, with the forms it takes", () => {
    for (const value of ["10", "1w", "-5m", "5 m", "0s", "", "1.5h", "2026-10-28"]) {
      const error = (() => {
        try {
          parseSince(value);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error, value).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
      expect((error as OpsCrewError).message).toContain("30s, 15m, 2h or 3d");
    }
  });
});

describe("dockerLogLine", () => {
  it("splits Docker's timestamp from the text, and skips what has none", () => {
    expect(dockerLogLine("stdout", "2026-10-28T09:00:00.000000001Z GET / 200")).toEqual({
      stream: "stdout",
      time: "2026-10-28T09:00:00.000000001Z",
      line: "GET / 200",
    });
    expect(dockerLogLine("stderr", "2026-10-28T09:00:00.000000001Z ")).toEqual({
      stream: "stderr",
      time: "2026-10-28T09:00:00.000000001Z",
      line: "",
    });
    expect(dockerLogLine("stderr", "Error response from daemon: No such container")).toBe(
      undefined,
    );
  });
});
