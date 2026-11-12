// The rows behind `deel commands`: every runnable command with its method, path and summary, filtered and sorted.

import type { CommandDef } from "citty";
import type { Descriptor } from "../types.ts";
import { byName } from "../help.ts";
import { usageOf } from "../public-api/commands.ts";

export type CommandRow = { command: string; method: string | null; path: string | null; summary: string | null };

function descriptorRow(descriptor: Descriptor): CommandRow {
  return {
    // The row says how to run that endpoint: a generated command's whole line, a hand-picked variant's flag.
    command: descriptor.form ? usageOf(descriptor).slice("deel ".length) : `${descriptor.command.join(" ")}${descriptor.variant ? ` --${descriptor.variant}` : ""}`,
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
    .sort((a, b) => byName(a.command, b.command) || byName(a.path ?? "", b.path ?? ""));
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
