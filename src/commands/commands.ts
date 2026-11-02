// `deel commands [--filter <text>] [--json]` — a flat, offline list of every runnable command with its method, path and summary.

import { defineCommand } from "citty";
import type { ArgsDef, CommandDef } from "citty";
import type { Descriptor } from "../types.ts";
import { allDescriptors } from "../public-api/commands.ts";

export type CommandRow = { command: string; method: string | null; path: string | null; summary: string | null };

function descriptorRow(descriptor: Descriptor): CommandRow {
  return {
    // A variant is picked by its flag, so the row says how to run that endpoint.
    command: `${descriptor.command.join(" ")}${descriptor.variant ? ` --${descriptor.variant}` : ""}`,
    method: descriptor.method,
    path: descriptor.path,
    summary: descriptor.summary ?? null,
  };
}

function staticRows(name: string, cmd: CommandDef): CommandRow[] {
  const subCommands = cmd.subCommands as Record<string, CommandDef> | undefined;
  if (typeof cmd.run === "function" || !subCommands) {
    const summary = (cmd.meta as { description?: string } | undefined)?.description;
    return [{ command: name, method: null, path: null, summary: summary ?? null }];
  }
  return Object.entries(subCommands).flatMap(([child, def]) => staticRows(`${name} ${child}`, def));
}

export function commandRows(descriptors: Descriptor[], statics: Record<string, CommandDef>, filter?: string): CommandRow[] {
  const rows = [...descriptors.map(descriptorRow), ...Object.entries(statics).flatMap(([name, cmd]) => staticRows(name, cmd))];
  const terms = (filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((row) => {
      const text = [row.command, row.method, row.path, row.summary].filter(Boolean).join(" ").toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => a.command.localeCompare(b.command) || (a.path ?? "").localeCompare(b.path ?? ""));
}

export function renderCommandRows(rows: CommandRow[]): string {
  const width = (pick: (row: CommandRow) => string) => Math.max(0, ...rows.map((row) => pick(row).length));
  const commandWidth = width((row) => row.command);
  const methodWidth = width((row) => row.method ?? "");
  const pathWidth = width((row) => row.path ?? "");
  return rows
    .map((row) => `${row.command.padEnd(commandWidth)}  ${(row.method ?? "").padEnd(methodWidth)}  ${(row.path ?? "").padEnd(pathWidth)}  ${row.summary ?? ""}`.trimEnd() + "\n")
    .join("");
}

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
    run(cittyCtx) {
      const filter = cittyCtx.args.filter as string | undefined;
      const rows = commandRows(allDescriptors(), statics(), filter);
      if (cittyCtx.args.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      if (rows.length === 0) {
        process.stderr.write(`No commands match '${filter}'.\n`);
        return;
      }
      process.stdout.write(renderCommandRows(rows));
    },
  });
}
