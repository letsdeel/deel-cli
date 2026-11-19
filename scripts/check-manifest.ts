import { pathToFileURL } from "node:url";
import { commandMap } from "../src/commands.map.ts";
import { manifest } from "../src/manifest.generated.ts";

type AnyDescriptor = (typeof manifest.descriptors)[number];

function entryKey(command: string, method: string, path: string, variant?: string): string {
  return `${command}\0${method.toUpperCase()}\0${path}\0${variant ?? ""}`;
}

function check(): string[] {
  const errors: string[] = [];

  const descriptorKeys = new Set<string>(
    manifest.descriptors.map((d) => entryKey(d.command.join(" "), d.method, d.path, d.variant)),
  );
  const mapKeys = new Set<string>(
    commandMap.map((e) => entryKey(e.command, e.method, e.path, e.variant)),
  );

  // 1. Every map entry has a matching descriptor.
  for (const entry of commandMap) {
    const k = entryKey(entry.command, entry.method, entry.path, entry.variant);
    if (!descriptorKeys.has(k)) {
      const tag = entry.variant ? ` (variant: ${entry.variant})` : "";
      errors.push(`[map→manifest] Missing descriptor: ${entry.command} ${entry.method} ${entry.path}${tag}`);
    }
  }

  // 2. Every descriptor has a map entry (no orphans).
  for (const d of manifest.descriptors) {
    const k = entryKey(d.command.join(" "), d.method, d.path, d.variant);
    if (!mapKeys.has(k)) {
      const tag = d.variant ? ` (variant: ${d.variant})` : "";
      errors.push(`[manifest→map] Orphan descriptor: ${d.command.join(" ")} ${d.method} ${d.path}${tag}`);
    }
  }

  // 3. Variant groups: distinct variants; variant name must not collide with a param flag.
  const groups = new Map<string, AnyDescriptor[]>();
  for (const d of manifest.descriptors) {
    const cmd = d.command.join(" ");
    (groups.get(cmd) ?? (groups.set(cmd, []), groups.get(cmd)!)).push(d);
  }

  for (const [cmd, group] of groups) {
    const variants = group.map((d) => d.variant).filter(Boolean) as string[];
    if (variants.length === 0) continue;

    if (variants.length !== group.length) {
      errors.push(`[variant] Mixed variant/non-variant descriptors for: ${cmd}`);
    }

    const seen = new Set<string>();
    for (const v of variants) {
      if (seen.has(v)) errors.push(`[variant] Duplicate variant "${v}" in group: ${cmd}`);
      seen.add(v);
    }

    for (const d of group) {
      const paramNames = new Set(d.params.map((p: { name: string }) => p.name));
      for (const v of variants) {
        if (paramNames.has(v)) {
          errors.push(`[variant] Variant name "${v}" collides with param flag in: ${cmd} (variant: ${d.variant})`);
        }
      }
    }
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = check();
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(err + "\n");
    process.exit(1);
  }
  process.stderr.write(
    `[check-manifest] OK — ${manifest.descriptors.length} descriptor(s), ${commandMap.length} map entr${commandMap.length === 1 ? "y" : "ies"}.\n`,
  );
}

export { check };
