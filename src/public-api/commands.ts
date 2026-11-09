// Generated public API commands, and how the command line picks one endpoint among those sharing its words.

import type { CommandForm, Descriptor, GeneratedManifest } from "../types.ts";
import { argvEnables, argvFlagValue, argvMentionsFlag } from "../core/flags.ts";
import { CliError } from "../core/errors.ts";
import generated from "./manifest.json" with { type: "json" };

export const generatedManifest = generated as GeneratedManifest;

let descriptors: Descriptor[] = generatedManifest.descriptors;

export function generatedDescriptors(): Descriptor[] {
  return descriptors;
}

export function setGeneratedDescriptorsForTests(next: Descriptor[] | undefined): void {
  descriptors = next ?? generatedManifest.descriptors;
}

// The command line a user types for one endpoint, e.g. "deel contracts get <contract> --worker-type eor".
export function formUsage(words: string[], form: CommandForm): string {
  const parts = ["deel", ...words, ...form.positionals.map((p) => `<${p.label}>`)];
  for (const selector of form.selectors) {
    const text = `--${selector.flag}${selector.value !== undefined ? ` ${selector.value}` : ""}`;
    parts.push(selector.optional ? `[${text}]` : text);
  }
  for (const scope of form.scopes) parts.push(`--${scope.flag} <${scope.label}>`);
  return parts.join(" ");
}

export const usageOf = (descriptor: Descriptor): string => formUsage(descriptor.command, descriptor.form!);

// The flags that tell the endpoints sharing these words apart (selectors and scopes).
export function pickingFlags(form: CommandForm): string[] {
  return [...form.selectors.map((s) => s.flag), ...form.scopes.map((s) => s.flag)];
}

function matches(form: CommandForm, argv: string[], foreign: string[]): boolean {
  for (const selector of form.selectors) {
    if (selector.value === undefined) {
      if (!argvEnables(argv, selector.flag)) return false;
      continue;
    }
    const value = argvFlagValue(argv, selector.flag);
    if (value === undefined ? !selector.optional : value !== selector.value) return false;
  }
  if (form.scopes.some((scope) => argvFlagValue(argv, scope.flag) === undefined)) return false;
  return !foreign.some((flag) => argvMentionsFlag(argv, flag));
}

// The one endpoint whose selectors and scopes the argv gives; undefined when none or several do.
export function matchForm(candidates: Descriptor[], argv: string[]): Descriptor | undefined {
  const all = new Set(candidates.flatMap((d) => pickingFlags(d.form!)));
  const found = candidates.filter((d) => {
    const own = new Set(pickingFlags(d.form!));
    return matches(d.form!, argv, [...all].filter((flag) => !own.has(flag)));
  });
  return found.length === 1 ? found[0] : undefined;
}

export function selectForm(candidates: Descriptor[], argv: string[]): Descriptor {
  const found = matchForm(candidates, argv);
  if (found) return found;
  const words = candidates[0].command.join(" ");
  const lines = candidates.map((d) => `  ${usageOf(d)}`).join("\n");
  for (const flag of new Set(candidates.flatMap((d) => d.form!.selectors.filter((s) => s.value !== undefined).map((s) => s.flag)))) {
    const given = argvFlagValue(argv, flag);
    const valid = [...new Set(candidates.flatMap((d) => d.form!.selectors.filter((s) => s.flag === flag && s.value !== undefined).map((s) => s.value!)))];
    if (given !== undefined && !valid.includes(given)) {
      throw new CliError("usage.variant", `'deel ${words}' has no --${flag} ${given}. Valid values: ${valid.join(", ")}.`, `Use one of:\n${lines}`);
    }
  }
  throw new CliError("usage.variant", `The flags given match no single form of 'deel ${words}'.`, `Use one of:\n${lines}`);
}
