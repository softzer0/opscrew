import type { Command } from "commander";
import type { CliContext } from "../context";
import * as adapt from "./adapt";
import * as analyze from "./analyze";
import * as design from "./design";
import * as destroy from "./destroy";
import * as dns from "./dns";
import * as domain from "./domain";
import * as drift from "./drift";
import * as init from "./init";
import * as interview from "./interview";
import * as mcp from "./mcp";
import * as provision from "./provision";
import * as retarget from "./retarget";
import * as scan from "./scan";
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
  analyze,
  interview,
  design,
  adapt,
  provision,
  dns,
  domain,
  secure,
  verify,
  drift,
  retarget,
  destroy,
  status,
  mcp,
];
