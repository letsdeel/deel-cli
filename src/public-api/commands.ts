// Generated public API commands: the manifest, and how a merged command (a collection and its
// parent-scoped twin, e.g. /contracts/custom_fields and /contracts/{contract_id}/custom_fields) picks its endpoint.

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

function pathParamsOf(descriptor: Descriptor): CliParam[] {
  return descriptor.params.filter((param) => param.in === "path");
}

export function selectAlternate(alternates: Descriptor[], given: (flag: string) => boolean): Descriptor | undefined {
  return [...alternates]
    .sort((a, b) => pathParamsOf(b).length - pathParamsOf(a).length)
    .find((descriptor) => pathParamsOf(descriptor).every((param) => given(flagOf(param))));
}
