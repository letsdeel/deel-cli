// Generated public API commands, and how a merged command picks its endpoint.

import type { CliParam, Descriptor, GeneratedManifest } from "../types.ts";
import { flagOf } from "../core/flags.ts";
import generated from "./manifest.json" with { type: "json" };

export const generatedManifest = generated as GeneratedManifest;

let descriptors: Descriptor[] = generatedManifest.descriptors;

export function generatedDescriptors(): Descriptor[] {
  return descriptors;
}

export function setGeneratedDescriptorsForTests(next: Descriptor[] | undefined): void {
  descriptors = next ?? generatedManifest.descriptors;
}

function pathParamsOf(descriptor: Descriptor): CliParam[] {
  return descriptor.params.filter((param) => param.in === "path");
}

export function selectAlternate(alternates: Descriptor[], given: (flag: string) => boolean): Descriptor | undefined {
  return [...alternates]
    .sort((a, b) => pathParamsOf(b).length - pathParamsOf(a).length)
    .find((descriptor) => pathParamsOf(descriptor).every((param) => given(flagOf(param))));
}
