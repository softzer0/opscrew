import { errorMessage, OpsCrewError } from "@opscrew/core";
import { type ContainerSpec, DockerApiError, type DockerClient } from "./client";

/** What a one-off container printed, and how it ended. */
export interface OneOffResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A step of a one-off container failed (`cause`), and the container (`id`) could not be removed
 * afterwards either: it is still on the Docker host.
 */
export class ContainerLeftError extends OpsCrewError {
  readonly id: string;

  constructor(cause: unknown, id: string) {
    const short = id.slice(0, 12);
    super(
      "COMMAND_FAILED",
      `${errorMessage(cause).replace(/\.?$/, ".")} OpsCrew could not remove its one-off container ${short} either.`,
      {
        hint: `Remove it on the Docker host with \`docker rm -f ${short}\`, then run the command again.`,
        cause,
      },
    );
    this.name = "ContainerLeftError";
    this.id = id;
  }
}

/** Creates a container of `spec` (not started), pulling its image when the host lacks it. */
export async function createPulled(client: DockerClient, spec: ContainerSpec): Promise<string> {
  try {
    return await client.createContainer(spec);
  } catch (error) {
    if (!(error instanceof DockerApiError && error.status === 404)) throw error;
    await client.pullImage(spec.image);
    return client.createContainer(spec);
  }
}

/**
 * Runs a one-off container of `spec` to its end, pulling its image when the host lacks it, and
 * removes it afterwards, also when a step fails ({@link ContainerLeftError} when that removal fails
 * too). `before` runs once it is created and before it starts, such as an archive `PUT`.
 */
export async function runOneOff(
  client: DockerClient,
  spec: ContainerSpec,
  before?: (id: string) => Promise<void>,
): Promise<OneOffResult> {
  const id = await createPulled(client, spec);
  let result: OneOffResult;
  try {
    await before?.(id);
    await client.startContainer(id);
    const exitCode = await client.waitContainer(id);
    result = { exitCode, ...(await client.containerLogs(id)) };
  } catch (error) {
    try {
      await client.removeContainer(id);
    } catch {
      throw new ContainerLeftError(error, id);
    }
    throw error;
  }
  await client.removeContainer(id);
  return result;
}
