/**
 * gixy-ng against OpsCrew's `runGixy` (T1408), once, on Docker: gixy-ng is installed in a throwaway
 * container of the pinned Python image (`pip install gixy-ng`, at the release this pass confirmed)
 * and stands in for a gixy-ng installed on this computer. It checks what `runGixy` relies on: the
 * `gixy` command, `-f json`, the report's fields and the exit code (1 with findings, 0 without);
 * then `runGixy` turns the report into advice for an nginx additions file OpsCrew generates (a
 * `vercel.json` translation), for one with a known finding, and for a clean one.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon (it installs
 * from PyPI). The container is removed afterwards.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "@opscrew/contracts";
import { EDGE_PROXIES, IMAGES, translateVercelRouting } from "@opscrew/iac-templates";
import { runGixy } from "@opscrew/secops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, dockerSkipReason, LABEL, TEN_MINUTES, TWO_MINUTES } from "./docker-support";
import { dockerOk, tempDir, unique } from "./edge-support";

const SKIP = dockerSkipReason();
if (SKIP !== undefined) console.warn(`Skipping gixy-ng on Docker: ${SKIP}.`);

/** The gixy-ng release this pass confirmed `runGixy` against. */
const GIXY_NG = "0.2.57";

/** An additions file with a finding gixy-ng reports: the client's own Host header to the app. */
const SPOOFED_HOST =
  "location /x/ {\n\tproxy_set_header Host $http_host;\n\tproxy_pass http://kamal-proxy;\n}\n";

describe.skipIf(SKIP !== undefined)("gixy-ng and runGixy (014)", () => {
  const container = unique("gixy");
  let work = "";

  beforeAll(async () => {
    work = await tempDir("opscrew-gixy-");
    await mkdir(path.join(work, "opscrew", "proxy"), { recursive: true });
    await dockerOk(
      [
        "run",
        "-d",
        "--name",
        container,
        "--label",
        LABEL,
        "-v",
        `${work}:/work`,
        IMAGES.python.ref,
        "sleep",
        "3600",
      ],
      "starting the Python container",
    );
    await dockerOk(
      [
        "exec",
        container,
        "pip",
        "install",
        "-q",
        "--disable-pip-version-check",
        "--root-user-action=ignore",
        `gixy-ng==${GIXY_NG}`,
      ],
      "installing gixy-ng",
      TEN_MINUTES,
    );
  }, TEN_MINUTES);

  afterAll(async () => {
    await docker(["rm", "-f", container]);
  }, TWO_MINUTES);

  /** gixy-ng as if installed here: `gixy` runs in the container, on the file's path there. */
  const gixy: CommandRunner = {
    run: (command, args, options) =>
      docker(
        [
          "exec",
          container,
          command,
          ...args.map((arg) => arg.replace(work, "/work").replaceAll("\\", "/")),
        ],
        options?.timeoutMs ?? TWO_MINUTES,
      ),
  };

  /** Writes `text` as the app's nginx additions and runs `runGixy` on it. */
  async function advise(name: string, text: string) {
    const file = path.join(work, "opscrew", "proxy", name);
    await writeFile(file, text);
    return runGixy(file, gixy, { which: (bin) => bin });
  }

  it(
    "is the gixy command, with a JSON report of the fields runGixy reads and exit code 1 on a finding",
    async () => {
      await writeFile(path.join(work, "spoofed.nginx"), SPOOFED_HOST);
      await writeFile(
        path.join(work, "clean.nginx"),
        'add_header X-Robots-Tag "noindex" always;\n',
      );
      const found = await docker(["exec", container, "gixy", "-f", "json", "/work/spoofed.nginx"]);
      expect(found.exitCode).toBe(1);
      const report = JSON.parse(found.stdout) as Record<string, unknown>[];
      expect(report).toHaveLength(1);
      expect(report[0]).toMatchObject({
        plugin: "host_spoofing",
        summary: expect.any(String),
        severity: "MEDIUM",
        description: expect.any(String),
        reference: expect.stringMatching(/^https:\/\//),
        line: 2,
        config: expect.stringContaining("proxy_set_header Host $http_host;"),
      });
      const clean = await docker(["exec", container, "gixy", "-f", "json", "/work/clean.nginx"]);
      expect(clean.exitCode).toBe(0);
      expect(JSON.parse(clean.stdout)).toEqual([]);
    },
    TWO_MINUTES,
  );

  it(
    "gives a known finding as advice with its severity, reason and reference",
    async () => {
      const advice = await advise("additions.nginx", SPOOFED_HOST);
      expect(advice).toEqual([
        {
          id: "gixy-ng/host_spoofing",
          title: "The proxied Host header may be spoofed.",
          status: "warn",
          severity: "medium",
          message: expect.stringContaining("$host"),
          remediation: "See https://gixy.getpagespeed.com/checks/host-spoofing/",
          source: "gixy-ng",
        },
      ]);
      expect(
        await advise("additions.nginx", 'add_header X-Robots-Tag "noindex" always;\n'),
      ).toEqual([]);
    },
    TWO_MINUTES,
  );

  it(
    "reads a generated additions file (a vercel.json translation), with no advice that applies to it",
    async () => {
      const { text } = translateVercelRouting(
        {
          source: "vercel.json",
          sha256: "0".repeat(64),
          redirects: [
            { index: 0, source: "/old/:path*", destination: "/new/:path*", statusCode: 308 },
          ],
          rewrites: [{ index: 0, source: "/blog/:slug", destination: "/posts/:slug" }],
          headers: [
            {
              index: 0,
              source: "/assets/(.*)",
              headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
            },
          ],
          cleanUrls: true,
          unsupported: [],
        },
        { proxy: "nginx", hostnames: ["shop.example.com"], upstream: EDGE_PROXIES.nginx.upstream },
      );
      expect(text).toContain("location");
      const advice = await advise("additions.nginx", text);
      console.info(`gixy-ng on a generated additions file: ${JSON.stringify(advice)}`);
      // gixy-ng 0.2.57 gives http_splitting and regex_redos on OpsCrew's own lines: all noise.
      for (const result of advice) {
        expect(result).toMatchObject({ status: "warn", source: "gixy-ng" });
        expect(["gixy-ng/http_splitting", "gixy-ng/regex_redos"]).toContain(result.id);
        expect(result.noise).toBeDefined();
      }
    },
    TWO_MINUTES,
  );
});
