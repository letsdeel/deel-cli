// Flag names as the CLI types and matches them.

import { parseArgs } from "citty";
import type { CliParam } from "../types.ts";

export function flagOf(param: CliParam): string {
  return param.flag ?? param.name;
}

// Whether the parser reads `--<key>` as the flag `flag`. It asks citty itself, so the spellings it accepts
// (--a_b, --a-b, --aB, acronyms such as userIDs) can never drift from a copy of its rules kept here.
export function acceptsFlag(flag: string, key: string): boolean {
  return (parseArgs([`--${key}`, "1"], { [flag]: { type: "string" } }) as Record<string, unknown>)[flag] === "1";
}

export function argvHasFlag(argv: string[], flag: string): boolean {
  return argv.some((token) => token.startsWith("--") && acceptsFlag(flag, token.slice(2).split("=")[0]));
}

// Whether argv typed the flag at all: with a value, or negated as --no-<flag>.
export function argvMentionsFlag(argv: string[], flag: string): boolean {
  return argvHasFlag(argv, flag) || argvHasFlag(argv.map((token) => (token.startsWith("--no-") ? `--${token.slice(5)}` : token)), flag);
}

// Whether a boolean flag is switched on in argv, so `--flag=false` and `--no-flag` do not count.
export function argvEnables(argv: string[], flag: string): boolean {
  return (parseArgs(argv, { [flag]: { type: "boolean" } }) as Record<string, unknown>)[flag] === true;
}
