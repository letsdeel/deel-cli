// Static (non-generated) command registry. These are hand-written because they
// don't map 1:1 to a single API operation the way generated commands do.

import type { CommandDef } from "citty";
import { authCommand } from "./auth.ts";
import { jobCommand } from "./job.ts";

export { authCommand, jobCommand };

// Keyed by the top-level command name; merged into the root command tree.
// The keys MUST stay in sync with RESERVED_COMMANDS (src/core/constants.ts),
// which prevents a derived API command from colliding with one of these.
export const staticCommands: Record<string, CommandDef> = {
  auth: authCommand,
  job: jobCommand,
};
