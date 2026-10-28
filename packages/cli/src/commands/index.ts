import type { Command } from "commander";
import type { CliContext } from "../context";
import * as adapt from "./adapt";
import * as addon from "./addon";
import * as analyze from "./analyze";
import * as app from "./app";
import * as design from "./design";
import * as destroy from "./destroy";
import * as dns from "./dns";
import * as domain from "./domain";
import * as drift from "./drift";
import * as env from "./env";
import * as init from "./init";
import * as interview from "./interview";
import * as localhost from "./localhost";
import * as logs from "./logs";
import * as mcp from "./mcp";
import * as portainer from "./portainer";
import * as promote from "./promote";
import * as provision from "./provision";
import * as retarget from "./retarget";
import * as runner from "./runner";
import * as scan from "./scan";
import * as secrets from "./secrets";
import * as secure from "./secure";
import * as status from "./status";
import * as verify from "./verify";

/** A command module: adds one subcommand to the program. */
export interface CommandModule {
  register(program: Command, ctx: CliContext): void;
}

/** Every `opscrew` subcommand, in the order shown by `--help` (pipeline order, then tools). */
export const ALL_COMMANDS: readonly CommandModule[] = [
  init,
  scan,
  app,
  analyze,
  interview,
  design,
  env,
  adapt,
  provision,
  promote,
  dns,
  domain,
  secure,
  verify,
  drift,
  portainer,
  addon,
  retarget,
  destroy,
  status,
  logs,
  localhost,
  runner,
  secrets,
  mcp,
];
