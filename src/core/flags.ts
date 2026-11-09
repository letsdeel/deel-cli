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

// The value argv gives a string flag, in any spelling the parser accepts; undefined when it isn't given.
export function argvFlagValue(argv: string[], flag: string): string | undefined {
  const value = (parseArgs(argv, { [flag]: { type: "string" } }) as Record<string, unknown>)[flag];
  return value === undefined || value === true ? undefined : String(value);
}

// Whether argv writes the flag's value attached (--flag=value), the one form a value that starts with - can take.
export function argvAttachesValue(argv: string[], flag: string, value: string): boolean {
  return argv.some((token) => {
    const at = token.indexOf("=");
    return token.startsWith("--") && at > 2 && acceptsFlag(flag, token.slice(2, at)) && token.slice(at + 1) === value;
  });
}

// `--bulk true` reads as the switch plus an argument "true"; join such a value onto its switch (--bulk=true).
export function joinSwitchValues(argv: string[], switches: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") return [...out, ...argv.slice(index)];
    const next = argv[index + 1];
    const key = token.startsWith("--") && !token.includes("=") ? token.slice(2) : undefined;
    if (key && (next === "true" || next === "false") && switches.some((flag) => acceptsFlag(flag, key))) {
      out.push(`${token}=${next}`);
      index++;
    } else out.push(token);
  }
  return out;
}
