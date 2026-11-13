// `deel commands [--filter <text>] [--json]` — a flat, offline list of every runnable command with its method, path and summary.

import { defineCommand } from "citty";
import type { ArgsDef, CommandDef } from "citty";
import { CliError } from "../core/errors.ts";
import { unknownFlag } from "../core/flags.ts";
import { refuseMissingValues } from "./shared.ts";
import { commandRows, renderCommandRows } from "../core/commands-list.ts";
import { realIO } from "../core/io.ts";
import { allDescriptors, loadGeneratedDescriptors } from "../public-api/commands.ts";

const args: ArgsDef = {
  filter: { type: "string", description: "Only commands whose name, method, path or summary contain every word of this text" },
  json: { type: "boolean", description: "Print a JSON array of {command, method, path, summary}" },
};

// `statics` is read when the command runs, so the registry (src/commands/index.ts) can
// list this command too.
export function createCommandsCommand(statics: () => Record<string, CommandDef>): CommandDef {
  return defineCommand({
    meta: { name: "commands", description: "List every command with its method, path and summary" },
    args,
    async run(cittyCtx) {
      refuseMissingValues(cittyCtx.rawArgs, args);
      // It takes no words and no other flag: a stray one (`--filter a b`, `--fliter a`) would widen the list unnoticed.
      const unknown = unknownFlag(cittyCtx.rawArgs, Object.keys(args));
      if (unknown) throw new CliError("usage.flag", `'deel commands' has no flag ${unknown}.`, "Run it with --help to see its flags.");
      const stray = (cittyCtx.args._ as string[] | undefined) ?? [];
      if (stray.length) throw new CliError("usage.command", `'deel commands' takes no arguments, got: ${stray.join(" ")}.`, "To search, write --filter=<text>, e.g. deel commands --filter=\"invoice list\".");
      const filter = cittyCtx.args.filter as string | boolean | undefined;
      if (filter !== undefined && (typeof filter !== "string" || !filter.trim())) {
        throw new CliError("usage.filter", "--filter needs the text to look for.", "Example: deel commands --filter invoice");
      }
      const io = realIO();
      // A static command, so the generated manifest isn't loaded yet.
      await loadGeneratedDescriptors();
      const rows = commandRows(allDescriptors(), statics(), filter);
      if (cittyCtx.args.json) {
        io.out(JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      if (rows.length === 0) throw new CliError("commands.no_match", `No commands match '${filter}'.`, "Run deel commands to list every command.");
      io.out(renderCommandRows(rows));
    },
  });
}
