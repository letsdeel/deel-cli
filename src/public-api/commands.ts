// Generated public API commands, and how a merged command picks its endpoint.

import type { CliParam, Descriptor, GeneratedManifest } from "../types.ts";
import generated from "./manifest.json" with { type: "json" };

export const generatedManifest = generated as GeneratedManifest;

let descriptors: Descriptor[] = generatedManifest.descriptors;

export function generatedDescriptors(): Descriptor[] {
  return descriptors;
}

export function setGeneratedDescriptorsForTests(next: Descriptor[] | undefined): void {
  descriptors = next ?? generatedManifest.descriptors;
}

export function flagOf(param: CliParam): string {
  return param.flag ?? param.name;
}

// The spellings the parser accepts for one flag: as written, camelCase and kebab-case (--widget_id, --widgetId, --widget-id).
export function flagSpellings(flag: string): string[] {
  const words = flag.split(/[-_\s]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  const camel = words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase())).join("");
  const kebab = words.map((word) => word.toLowerCase()).join("-");
  return [...new Set([flag, camel, kebab])];
}

export function argvHasFlag(argv: string[], flag: string): boolean {
  const spellings = flagSpellings(flag);
  return argv.some((token) => spellings.some((spelling) => token === `--${spelling}` || token.startsWith(`--${spelling}=`)));
}

function pathParamsOf(descriptor: Descriptor): CliParam[] {
  return descriptor.params.filter((param) => param.in === "path");
}

export function selectAlternate(alternates: Descriptor[], given: (flag: string) => boolean): Descriptor | undefined {
  return [...alternates]
    .sort((a, b) => pathParamsOf(b).length - pathParamsOf(a).length)
    .find((descriptor) => pathParamsOf(descriptor).every((param) => given(flagOf(param))));
}
