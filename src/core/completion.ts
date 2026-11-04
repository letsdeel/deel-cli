// Shell completion. `deel completion <shell>` prints a small script that, on
// every <TAB>, calls back into `deel __complete <words...>`; this module computes
// the candidates from the same command tree and manifest the CLI routes with, so
// completion can never drift from the commands that actually exist.
//
// Output protocol of `deel __complete`: one candidate per line, `value\tdescription`
// (description optional). An empty result tells the shell to fall back to file
// completion, which is what flags like --input file://... and --ca-cert want.

import type { ArgsDef, CommandDef } from "citty";
import type { Descriptor } from "../types.ts";
import { ENVIRONMENTS } from "./config.ts";

export type Candidate = { value: string; description?: string };

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

// Known values for positional arguments, keyed by command path.
const POSITIONAL_VALUES: Record<string, readonly string[]> = {
  completion: SHELLS,
};

type ArgDef = { type?: string; description?: string; options?: readonly string[]; alias?: string | string[] };

// Flags that take a value, looked up by name so a value token is never mistaken
// for a subcommand while walking the words typed so far.
function takesValue(def: ArgDef | undefined): boolean {
  return def !== undefined && (def.type === "string" || def.type === "enum");
}

function subCommandsOf(cmd: CommandDef): Record<string, CommandDef> {
  return (cmd.subCommands ?? {}) as Record<string, CommandDef>;
}

function argsOf(cmd: CommandDef): ArgsDef {
  return (cmd.args ?? {}) as ArgsDef;
}

function describe(cmd: CommandDef): string | undefined {
  const meta = cmd.meta as { description?: string } | undefined;
  return meta?.description;
}

function flagCandidates(args: ArgsDef): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [name, raw] of Object.entries(args)) {
    const def = raw as ArgDef;
    if (def.type === "positional") continue;
    candidates.push({ value: `--${name}`, description: def.description });
  }
  candidates.push({ value: "--help", description: "Show help" });
  return candidates;
}

// Values for `--<flag> <TAB>`. Enum flags list their options, --env lists the known
// environments, and --fields completes the action's response fields (comma-separated,
// so `--fields id,na<TAB>` completes the last segment and keeps the rest).
function valueCandidates(flag: string, def: ArgDef, current: string, descriptors: Descriptor[]): Candidate[] {
  if (def.options?.length) return def.options.map((value) => ({ value }));
  if (flag === "env") return Object.keys(ENVIRONMENTS).map((value) => ({ value, description: ENVIRONMENTS[value] }));
  if (flag === "fields") {
    const fields = new Set<string>();
    for (const descriptor of descriptors) for (const field of descriptor.responseFields) fields.add(field.name);
    const comma = current.lastIndexOf(",");
    const prefix = comma === -1 ? "" : current.slice(0, comma + 1);
    const already = new Set(prefix.split(",").filter(Boolean));
    return [...fields].filter((field) => !already.has(field)).map((field) => ({ value: prefix + field }));
  }
  return [];
}

// `words` are the tokens after `deel`; the last one is the word being completed
// (empty string when the cursor is after a space).
export function complete(root: CommandDef, descriptors: Descriptor[], words: string[]): Candidate[] {
  const typed = words.slice(0, -1);
  const current = words.length > 0 ? words[words.length - 1] : "";

  let cmd = root;
  const path: string[] = [];
  let positionals = 0;
  let pendingFlag: { name: string; def: ArgDef } | undefined;
  for (const token of typed) {
    if (token === "--") return [];
    if (pendingFlag) {
      pendingFlag = undefined;
      continue;
    }
    if (token.startsWith("-")) {
      if (token.includes("=")) continue;
      const name = token.replace(/^--?/, "");
      const def = argsOf(cmd)[name] as ArgDef | undefined;
      if (takesValue(def)) pendingFlag = { name, def: def! };
      continue;
    }
    const next = subCommandsOf(cmd)[token];
    if (next) {
      cmd = next;
      path.push(token);
    } else {
      positionals++;
    }
  }

  const leafDescriptors = descriptors.filter(
    (descriptor) => descriptor.command.length === path.length && descriptor.command.every((part, index) => part === path[index]),
  );

  let candidates: Candidate[];
  if (pendingFlag) {
    candidates = valueCandidates(pendingFlag.name, pendingFlag.def, current, leafDescriptors);
  } else if (current.startsWith("--") && current.includes("=")) {
    const [flag, value] = [current.slice(2, current.indexOf("=")), current.slice(current.indexOf("=") + 1)];
    const def = argsOf(cmd)[flag] as ArgDef | undefined;
    candidates = takesValue(def)
      ? valueCandidates(flag, def!, value, leafDescriptors).map((c) => ({ ...c, value: `--${flag}=${c.value}` }))
      : [];
  } else if (current.startsWith("-")) {
    candidates = flagCandidates(argsOf(cmd));
  } else {
    const subCommands = Object.entries(subCommandsOf(cmd));
    candidates = subCommands.map(([name, sub]) => ({ value: name, description: describe(sub) }));
    // On an action with nothing typed yet, offer its flags, unless it takes a
    // positional (e.g. `deel job status <id>`), where suggesting flags would mislead.
    const hasPositional = Object.values(argsOf(cmd)).some((def) => (def as ArgDef).type === "positional");
    const positionalValues = POSITIONAL_VALUES[path.join(" ")];
    if (positionalValues && positionals === 0) candidates = positionalValues.map((value) => ({ value }));
    if (subCommands.length === 0 && current === "" && !hasPositional && path.length > 0) candidates = flagCandidates(argsOf(cmd));
  }

  return candidates.filter((candidate) => candidate.value.startsWith(current)).sort((a, b) => a.value.localeCompare(b.value));
}

export function formatCandidates(candidates: Candidate[]): string {
  return candidates.map((c) => (c.description ? `${c.value}\t${c.description.replace(/\s+/g, " ")}` : c.value)).join("\n");
}

const BASH = `# deel bash completion. Load with:  source <(deel completion bash)
# Words are split from COMP_LINE on whitespace (not COMP_WORDBREAKS) so that
# --flag=value and comma-separated --fields reach deel intact.
_deel_completion() {
  local line="\${COMP_LINE:0:COMP_POINT}"
  local -a words
  read -ra words <<< "$line"
  [[ "$line" == *[[:space:]] ]] && words+=("")
  local cur="\${words[\${#words[@]}-1]}"
  local prev="\${words[\${#words[@]}-2]}"
  local out candidate
  out="$(deel __complete "\${words[@]:1}" 2>/dev/null | cut -f1)"
  COMPREPLY=()
  [[ -z "$out" ]] && return 0
  local IFS=$'\\n'
  for candidate in $out; do
    [[ "$candidate" == "$cur"* ]] || continue
    # Bash itself splits the word being completed at '=', so reply with the part after it.
    [[ "$cur" == *=* ]] && candidate="\${candidate#*=}"
    COMPREPLY+=("$candidate")
  done
  if [[ "$prev" == "--fields" || "$cur" == --*=* ]] && type compopt >/dev/null 2>&1; then
    compopt -o nospace
  fi
}
complete -o default -F _deel_completion deel
`;

const ZSH = `#compdef deel
# deel zsh completion. Load with:  source <(deel completion zsh)   (after compinit)
_deel() {
  local -a candidates
  local line value desc
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    value="\${line%%$'\\t'*}"
    desc=""
    [[ "$line" == *$'\\t'* ]] && desc="\${line#*$'\\t'}"
    value="\${value//:/\\\\:}"
    if [[ -n "$desc" ]]; then
      candidates+=("$value:$desc")
    else
      candidates+=("$value")
    fi
  done < <(deel __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)
  if (( \${#candidates} == 0 )); then
    _files
    return
  fi
  _describe -t deel-commands 'deel' candidates
}
if [[ "\${funcstack[1]}" == "_deel" ]]; then
  _deel "$@"
else
  compdef _deel deel
fi
`;

const FISH = `# deel fish completion. Load with:  deel completion fish | source
function __deel_complete
    set -l tokens (commandline -opc)
    set -l current (commandline -ct)
    deel __complete $tokens[2..-1] "$current" 2>/dev/null
end
function __deel_has_candidates
    set -l candidates (__deel_complete)
    test (count $candidates) -gt 0
end
# With no candidates (e.g. --input file://...), fish falls back to file completion.
complete -c deel -f -n __deel_has_candidates -a '(__deel_complete)'
`;

export function completionScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return BASH;
    case "zsh":
      return ZSH;
    case "fish":
      return FISH;
  }
}
