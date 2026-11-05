import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGES } from "../pins";
import { BASE, previewPlan } from "./__fixtures__/plans";
import { commit, PreviewServer, shWorks } from "./__fixtures__/server";

/*
 * opscrew-preview on a real Docker: up, an update, list and down of a preview whose app is the
 * pinned unprivileged nginx image (it answers on port 8080), with the real shared edge (Caddy, with
 * a self-signed certificate in place of the Origin CA one, and kamal-proxy, published on loopback
 * ports here), and nothing of the preview left afterwards. Only
 * the registry login is faked (the image is public) and flock is a shim (Git for Windows has none).
 * Runs only with OPSCREW_DOCKER_TESTS=1, and never beside an OpsCrew edge this Docker already runs.
 */

function docker(...args: string[]) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 300_000 });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  if (!shWorks()) return "sh is not available";
  if (docker("version", "--format", "{{.Server.Version}}").status !== 0) {
    return "Docker is not available";
  }
  if (docker("network", "inspect", "opscrew-edge").status === 0) {
    return "this Docker already runs an OpsCrew edge (network opscrew-edge)";
  }
  return undefined;
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping opscrew-preview on Docker: ${reason}`);

/** The pinned unprivileged nginx by digest alone, as a preview's image (`<IMAGE_NAME>@sha256:<digest>`). */
const [APP_IMAGE, DIGEST] = IMAGES.nginx.ref.replace(/:[^:@]+@/, "@").split("@") as [
  string,
  string,
];

const NAME = "shop-preview-pr-1";

/** The app's health path: nginx's welcome page. */
const HEALTH_PATH = "/index.html";

/**
 * Under Git for Windows the script's paths (`/d/…`) reach Docker converted, but not the paths in
 * containers (Caddy's configuration, the health path). Other shells ignore it.
 */
const ENV = { MSYS2_ARG_CONV_EXCL: `/etc/caddy;${HEALTH_PATH}` };

describe.skipIf(reason !== undefined)(
  "opscrew-preview on a real Docker (OPSCREW_DOCKER_TESTS=1)",
  () => {
    let s: PreviewServer;
    let edge: string[] = [];
    /** The pinned images this test pulled, which it removes. */
    let pulled: string[] = [];

    beforeAll(() => {
      const base = previewPlan({
        postgres: false,
        processes: false,
        release: "true",
        seed: "echo seeded",
      });
      s = new PreviewServer(
        DeployPlanSchema.parse({
          ...base,
          app: { ...base.app, port: 8080, healthPath: HEALTH_PATH },
        }),
        { real: true },
      );
      edge = ["compose", "-p", "opscrew-edge", "-f", `${s.work}/srv/edge/compose.yaml`];
      pulled = [IMAGES.nginx.ref, IMAGES.caddy.ref, IMAGES.kamalProxy.ref, IMAGES.curl.ref].filter(
        (ref) => docker("image", "inspect", ref).status !== 0,
      );
      // The preview's image is nginx; the edge publishes on loopback ports only.
      s.write(
        `${s.recipe}/settings.env`,
        (s.read(`${s.recipe}/settings.env`) ?? "").replace(
          /^IMAGE_NAME=.*$/m,
          `IMAGE_NAME=${APP_IMAGE}`,
        ),
      );
      // A self-signed certificate in place of the Origin CA one the previews host plan installs.
      const key = generateP256().privateKey;
      const tls = `${s.work}/srv/edge/tls/${s.app}`;
      s.write(`${tls}/origin.pem`, selfSignedClientCertificate({ key, commonName: BASE, days: 1 }));
      s.write(`${tls}/origin.key`, key, 0o600);
      const compose = s.read(`${s.recipe}/template/edge/compose.yaml`) ?? "";
      const loopback = compose.replace(
        /- 80:80\n(\s+)- 443:443\n\s+- 443:443\/udp\n/,
        "- 127.0.0.1::80\n$1- 127.0.0.1::443\n",
      );
      expect(loopback).not.toBe(compose);
      s.write(`${s.recipe}/template/edge/compose.yaml`, loopback);
    });

    afterAll(() => {
      if (existsSync(`${s.work}/srv/edge/compose.yaml`)) docker(...edge, "down", "--volumes");
      docker("network", "rm", "opscrew-edge");
      for (const ref of pulled) docker("image", "rm", ref);
      s.remove();
    }, 300_000);

    /** The preview's address, from the random part its `.preview` keeps. */
    const address = () => `pr-1-${s.previewFields(1).random}.${BASE}`;
    /** What the edge's kamal-proxy serves for the preview's hostname, through the edge's network. */
    const served = () =>
      docker(
        ...edge,
        ...["exec", "-T", "caddy", "wget", "-qO-", "--header", `Host: ${address()}`],
        "http://kamal-proxy/",
      ).out;
    /** The ids of the preview's containers, networks or volumes. */
    const left = (kind: "container" | "network" | "volume") =>
      docker(
        ...(kind === "container" ? ["ps", "-a"] : [kind, "ls"]),
        ...["-q", "--filter", `label=com.docker.compose.project=${NAME}`],
      ).out;

    it("starts, updates, lists and removes a preview, and leaves nothing of it", () => {
      const up = s.run({
        key: `up 1 ${APP_IMAGE}@${DIGEST} ${commit("1")}`,
        stdin: "test-token",
        env: ENV,
      });
      expect(s.previewFields(1).random).toMatch(/^[a-z0-9]{10}$/);
      const first = address();
      expect(up, s.read(`${s.preview(1)}/up.log`)).toMatchObject({
        status: 0,
        stdout: `opscrew-preview: running ${first}\n`,
      });
      expect(served()).toContain("Welcome to nginx");
      // Caddy took the site with the certificate: it serves it for the address.
      const site = s.read(`${s.work}/srv/edge/sites/${NAME}.caddy`) ?? "";
      expect(site).toContain('X-Robots-Tag "noindex"');
      expect(site).toContain(`\n${first} {\n\ttls /etc/caddy/tls/shop-preview/origin.pem`);
      const caddy = docker(...edge, "ps", "-q", "caddy").out;
      expect(
        docker(
          ...["run", "--rm", "--network", `container:${caddy}`, IMAGES.curl.ref],
          ...["-sSk", "--resolve", `${first}:443:127.0.0.1`, `https://${first}/`],
        ).out,
      ).toContain("Welcome to nginx");
      expect(s.read(`${s.preview(1)}/.seeded`)).toBe("");
      expect(s.read(`${s.preview(1)}/up.log`)).toContain("seeded");

      const update = s.run({
        key: `up 1 ${APP_IMAGE}@${DIGEST} ${commit("2")}`,
        stdin: "test-token",
        env: ENV,
      });
      // At the same address.
      expect(update, s.read(`${s.preview(1)}/up.log`)).toMatchObject({
        status: 0,
        stdout: `opscrew-preview: running ${first}\n`,
      });
      expect(served()).toContain("Welcome to nginx");
      expect(left("container").split("\n")).toHaveLength(1);

      expect(s.run({ key: "list", env: ENV }).stdout).toMatch(
        new RegExp(
          `^1 running ${commit("2")} \\d+ \\d+ ${DIGEST} ${first.replaceAll(".", "\\.")}\nopscrew-preview: listed 1/3\n$`,
        ),
      );

      expect(s.run({ key: "down 1", env: ENV })).toMatchObject({
        status: 0,
        stdout: "opscrew-preview: removed 1\n",
      });
      expect(left("container")).toBe("");
      expect(left("network")).toBe("");
      expect(left("volume")).toBe("");
      expect(docker(...edge, "exec", "-T", "kamal-proxy", "kamal-proxy", "list").out).not.toContain(
        NAME,
      );
      expect(existsSync(`${s.work}/srv/edge/sites/${NAME}.caddy`)).toBe(false);
      expect(existsSync(s.preview(1))).toBe(false);
      expect(s.run({ key: "list", env: ENV }).stdout).toBe("opscrew-preview: listed 0/3\n");
    }, 600_000);
  },
);
