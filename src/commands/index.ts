// Static (non-generated) command registry. These are hand-written because they
// don't map 1:1 to a single API operation the way generated commands do.

import type { CommandDef } from "citty";
import { authCommand } from "./auth.ts";
import { jobCommand } from "./job.ts";
import { webhooksCommand } from "./webhooks.ts";

export { authCommand, jobCommand, webhooksCommand };

// Keyed by the top-level command name; merged into the root command tree.
// The keys MUST stay in sync with RESERVED_COMMANDS (src/core/constants.ts). Generated
// public API commands live under `deel api` (API_GROUP), which no static command may use.
export const staticCommands: Record<string, CommandDef> = {
  auth: authCommand,
  job: jobCommand,
  webhooks: webhooksCommand,
};
