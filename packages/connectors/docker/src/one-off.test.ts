import { describe, expect, it } from "vitest";
import { dockerClient } from "./client";
import { ContainerLeftError, runOneOff } from "./one-off";
import { FakeDocker } from "./testing";

const IMAGE = "busybox:1.37";

describe("runOneOff", () => {
  it("runs a container to its end and removes it", async () => {
    const docker = new FakeDocker();
    docker.images.add(IMAGE);
    docker.onStart = () => ({ exitCode: 0, stdout: "done\n" });
    const result = await runOneOff(dockerClient(docker), { image: IMAGE, cmd: ["true"] });
    expect(result).toEqual({ exitCode: 0, stdout: "done\n", stderr: "" });
    expect(docker.containers.size).toBe(0);
  });

  it("says the container is left when its removal fails after it ran", async () => {
    const docker = new FakeDocker();
    docker.images.add(IMAGE);
    docker.onStart = () => ({ exitCode: 0 });
    docker.fail("DELETE", /^\/containers\//, 500, "driver failed removing the container");
    const error = await runOneOff(dockerClient(docker), { image: IMAGE, cmd: ["true"] }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ContainerLeftError);
    const left = error as ContainerLeftError;
    expect(left.message).toContain("OpsCrew could not remove its one-off container");
    expect(left.hint).toBe(
      `Remove it on the Docker host with \`docker rm -f ${left.id.slice(0, 12)}\`, then run the command again.`,
    );
    expect(docker.containers.has(left.id)).toBe(true);
  });
});
