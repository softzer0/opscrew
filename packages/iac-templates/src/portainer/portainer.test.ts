import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { PORTAINER_PASSWORD_FILE, renderPortainerCompose } from "./index";

const plan = testPlan({ provider: "own", portainer: { access: "local" } });

describe("renderPortainerCompose", () => {
  const first = renderPortainerCompose(plan, { initialAdmin: true });
  const compose = parse(first.content);
  const service = compose.services.portainer;

  it("runs the pinned Portainer CE as its own project, reachable only from the server", () => {
    expect(first.path).toBe("opscrew/runtime/portainer/compose.yaml");
    expect(compose.name).toBe("opscrew-portainer");
    expect(service.image).toBe("portainer/portainer-ce:2.33.1");
    expect(service.ports).toEqual(["127.0.0.1:9443:9443"]);
    expect(first.content).not.toMatch(/8000|9000|0\.0\.0\.0/);
    expect(service.command).toContain("--http-disabled");
    expect(service.restart).toBe("unless-stopped");
  });

  it("mounts the Docker socket and the portainer_data volume", () => {
    expect(service.volumes).toEqual([
      "/var/run/docker.sock:/var/run/docker.sock",
      "portainer_data:/data",
    ]);
    expect(compose.volumes).toEqual({ portainer_data: {} });
  });

  it("creates the admin from the password file on first start", () => {
    expect(service.command).toEqual([
      "--http-disabled",
      "--admin-password-file",
      "/run/secrets/portainer_admin_password",
    ]);
    expect(service.secrets).toEqual(["portainer_admin_password"]);
    expect(compose.secrets).toEqual({
      portainer_admin_password: { file: `./${PORTAINER_PASSWORD_FILE}` },
    });
  });

  it("drops the password file once the admin exists (Portainer refuses a missing file)", () => {
    const later = parse(renderPortainerCompose(plan, { initialAdmin: false }).content);
    expect(later.services.portainer.command).toEqual(["--http-disabled"]);
    expect(later.services.portainer.secrets).toBeUndefined();
    expect(later.secrets).toBeUndefined();
    expect(later.services.portainer.volumes).toEqual(service.volumes);
  });

  it("is hardened like the app's infrastructure services", () => {
    expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    expect(service.privileged).toBeUndefined();
  });

  it("pins the plan's version on every target", () => {
    const hetzner = testPlan({ portainer: { access: "local" } });
    expect(
      parse(renderPortainerCompose(hetzner, { initialAdmin: false }).content).services.portainer
        .image,
    ).toBe("portainer/portainer-ce:2.33.1");
  });

  it("needs Portainer settings in the plan", () => {
    expect(() => renderPortainerCompose(testPlan(), { initialAdmin: true })).toThrow(
      /no Portainer settings/,
    );
  });

  it("matches the snapshot", () => {
    expect(first.content).toMatchSnapshot();
  });
});
