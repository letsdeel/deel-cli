// Root command wiring and routing. Builds the nested command tree from the
// generated manifest, merges in the static commands, and dispatches a run to
// citty — delegating body/response help to src/help.ts and the actual request
// to the executor. Each handler builds a Context (io + composed transport +
// clock/rng) and passes it down — no module reaches for process.* or a global.

import { defineCommand, parseArgs, runCommand, showUsage } from "citty";
import type { ArgsDef, CommandDef } from "citty";
import type { Descriptor } from "./types.ts";
import { allDescriptors, selectAlternate } from "./public-api/commands.ts";
import { argvEnables, argvHasFlag, argvMentionsFlag, flagOf } from "./core/flags.ts";
import { resolveToken, requireToken } from "./core/auth.ts";
import { parseInput } from "./core/input.ts";
import { createContext } from "./core/context.ts";
import { execute } from "./core/executor.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "./core/logging.ts";
import { EXIT } from "./core/errors.ts";
import { CliError } from "./core/errors.ts";
import { CLI_VERSION } from "./version.ts";
import { commonArgs, configFrom, gatherFiles, gatherFlagValues, outputOpts } from "./commands/shared.ts";
import type { Args } from "./commands/shared.ts";
import { staticCommands } from "./commands/index.ts";
import {
  isGroupCommand,
  printActionHelp,
  printAlternativesHelp,
  printContractJson,
  printGlobalOptions,
  printGroupHelp,
  printRootHelp,
  printSkeleton,
  printUnknownCommand,
  printVariantGroupHelp,
  printVersion,
  sectionsByWord,
  titleSectionOf,
} from "./help.ts";

// ---------------- generated action commands ----------------

function argsForDescriptor(descriptor: Descriptor): ArgsDef {
  const args: ArgsDef = { ...commonArgs };
  for (const param of descriptor.params) {
    args[flagOf(param)] = {
      type: param.type === "boolean" ? "boolean" : param.enum ? "enum" : "string",
      description: param.description,
      required: param.in === "path" ? true : param.required,
      ...(param.enum ? { options: param.enum } : {}),
    } as ArgsDef[string];
  }
  return args;
}

// Shared execution body extracted so both actionCommand and variantCommand can delegate to it.
async function runDescriptor(descriptor: Descriptor, cittyCtx: { args: Record<string, unknown>; rawArgs: string[] }): Promise<void> {
  const args = cittyCtx.args as Args;
  setLoggingEnabled(args.log !== false);
  setLogBodiesEnabled(args["log-bodies"] === true);

  const flags: Record<string, string | string[]> = {};
  for (const param of descriptor.params) {
    if (param.type === "array") {
      const values = gatherFlagValues(cittyCtx.rawArgs, flagOf(param));
      if (values.length) flags[param.name] = values;
      else if (args[flagOf(param)] !== undefined) flags[param.name] = [String(args[flagOf(param)])];
    } else {
      const value = args[flagOf(param)];
      if (value !== undefined) flags[param.name] = String(value);
    }
  }
  const call = {
    flags,
    body: args.input !== undefined ? parseInput(String(args.input), descriptor.bodyProps) : undefined,
    files: gatherFiles(cittyCtx.rawArgs),
    idempotencyKey: args["idempotency-key"] as string | undefined,
  };
  const config = configFrom(args, cittyCtx.rawArgs);
  const token = requireToken(resolveToken({ tokenStdin: Boolean(args["token-stdin"]), env: config.env }));
  const ctx = createContext({ config, token });
  await execute(descriptor, call, ctx, { output: outputOpts(args), debug: Boolean(args.debug), form: Boolean(args.form) });
}

function actionCommand(descriptor: Descriptor): CommandDef {
  return defineCommand({
    meta: { name: descriptor.command[descriptor.command.length - 1], description: `${descriptor.summary ?? ""}${descriptor.async ? " (async)" : ""}` },
    args: argsForDescriptor(descriptor),
    async run(cittyCtx) { await runDescriptor(descriptor, cittyCtx); },
  });
}

// Variant group: registers one boolean selector per variant. Exactly one must be
// set; zero or multiple throws usage.variant. Params are the union of all variants'
// params (all optional at parse time; enforcement happens inside runDescriptor).
function variantCommand(descriptors: Descriptor[]): CommandDef {
  const name = descriptors[0].command[descriptors[0].command.length - 1];
  const variants = descriptors.map((d) => d.variant!);
  const args: ArgsDef = { ...commonArgs };
  for (const variant of variants) {
    args[variant] = { type: "boolean", description: `Use the ${variant} variant` };
  }
  const seenParams = new Set<string>();
  for (const d of descriptors) {
    for (const param of d.params) {
      if (seenParams.has(param.name)) continue;
      seenParams.add(param.name);
      args[flagOf(param)] = {
        type: param.type === "boolean" ? "boolean" : param.enum ? "enum" : "string",
        description: param.description,
        required: false, // enforced inside runDescriptor after variant selection
        ...(param.enum ? { options: param.enum } : {}),
      } as ArgsDef[string];
    }
  }
  const summaries = descriptors.map((d) => d.summary).filter(Boolean).join(" / ");
  const flags = variants.map((v) => `--${v}`).join(", ");
  return defineCommand({
    meta: { name, description: summaries ? `${summaries} (${flags})` : `(${flags})` },
    args,
    async run(cittyCtx) {
      const args = cittyCtx.args as Args;
      const selected = variants.filter((v) => args[v] === true);
      if (selected.length === 0) throw new CliError("usage.variant", `Specify one of: ${variants.map((v) => `--${v}`).join(", ")}`);
      if (selected.length > 1) throw new CliError("usage.variant", `Specify exactly one of: ${variants.map((v) => `--${v}`).join(", ")}`);
      const descriptor = descriptors.find((d) => d.variant === selected[0])!;
      await runDescriptor(descriptor, cittyCtx);
    },
  });
}

// A collection and its parent-scoped twin share one name; the path-param flags given pick the endpoint.
// No flag of the forms is declared here: the path flags only decide which form runs. That form then parses the
// arguments with its own flag definitions, so a flag's type, enum and required-ness come from it alone.
function alternativesCommand(descriptors: Descriptor[]): CommandDef {
  const name = descriptors[0].command[descriptors[0].command.length - 1];
  const args: ArgsDef = { ...commonArgs };
  return defineCommand({
    meta: { name, description: descriptors[0].summary ?? name },
    args,
    async run(cittyCtx) {
      const args = cittyCtx.args as Args;
      const descriptor = selectAlternate(descriptors, (flag) => args[flag] !== undefined);
      if (!descriptor) throw new CliError("usage.params", `Missing path parameters for every form of 'deel ${descriptors[0].command.join(" ")}'.`, "Run it with --help to see the forms.");
      // A flag of another form would otherwise be accepted and dropped without a word.
      const own = new Set(descriptor.params.map(flagOf));
      const stray = descriptors.flatMap((d) => d.params.map(flagOf)).find((flag) => !own.has(flag) && argvMentionsFlag(cittyCtx.rawArgs, flag));
      if (stray) {
        throw new CliError("usage.params", `--${stray} does not apply to ${descriptor.method} ${descriptor.path}, the form your path parameters select.`, "Run it with --help to see the forms.");
      }
      await runDescriptor(descriptor, { ...cittyCtx, args: parseArgs(cittyCtx.rawArgs, argsForDescriptor(descriptor)) });
    },
  });
}

// Build a nested command tree from the descriptors' multi-token command paths.
// Repeated leaves (same command, different variant) are accumulated into Descriptor[].
type CommandTree = Map<string, CommandTree | Descriptor | Descriptor[]>;

function insertIntoTree(tree: CommandTree, descriptor: Descriptor): void {
  let node = tree;
  for (const group of descriptor.command.slice(0, -1)) {
    let child = node.get(group);
    if (!(child instanceof Map)) {
      child = new Map();
      node.set(group, child);
    }
    node = child;
  }
  const leaf = descriptor.command[descriptor.command.length - 1];
  const existing = node.get(leaf);
  if (existing === undefined) {
    node.set(leaf, descriptor);
  } else if (Array.isArray(existing)) {
    existing.push(descriptor);
  } else if (!(existing instanceof Map)) {
    node.set(leaf, [existing as Descriptor, descriptor]);
  }
}

function treeToCommand(name: string, node: CommandTree | Descriptor | Descriptor[]): CommandDef {
  if (Array.isArray(node)) return node[0].variant ? variantCommand(node) : alternativesCommand(node);
  if (!(node instanceof Map)) return actionCommand(node as Descriptor);
  const subCommands: Record<string, CommandDef> = {};
  for (const [childName, childNode] of node as CommandTree) subCommands[childName] = treeToCommand(childName, childNode);
  return defineCommand({ meta: { name }, subCommands });
}

// ---------------- root ----------------

function buildRoot(): CommandDef {
  const tree: CommandTree = new Map();
  for (const descriptor of allDescriptors()) insertIntoTree(tree, descriptor);
  const subCommands: Record<string, CommandDef> = { ...staticCommands };
  for (const [name, node] of tree) subCommands[name] = treeToCommand(name, node);
  return defineCommand({
    meta: { name: "deel", version: CLI_VERSION, description: "Deel CLI — spec-driven client for the Deel Public API" },
    subCommands,
  });
}

// A flag followed by a value (`--env demo`, `--widget-id 5`) must not leave that value among the command words.
// Global flags are classified by their declared type; any other flag takes the next token unless it names a subcommand.
function flagTakesValue(token: string, next: string | undefined, cmd: CommandDef | undefined): boolean {
  if (!token.startsWith("--") || token.includes("=") || next === undefined || next.startsWith("-")) return false;
  const name = token.slice(2).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  if (name === "base-url") return true;
  const declared = (commonArgs[name] ?? (name.startsWith("no-") ? commonArgs[name.slice(3)] : undefined)) as { type?: string } | undefined;
  if (declared) return declared.type === "string";
  return !(cmd?.subCommands as Record<string, CommandDef> | undefined)?.[next];
}

function wordIndexes(argv: string[], root: CommandDef): number[] {
  const indexes: number[] = [];
  let cmd: CommandDef | undefined = root;
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("-")) {
      indexes.push(i);
      cmd = (cmd?.subCommands as Record<string, CommandDef> | undefined)?.[argv[i]];
    } else if (flagTakesValue(argv[i], argv[i + 1], cmd)) i++;
  }
  return indexes;
}

// Walk the tree by the leading positional tokens to find the target command.
function resolve(root: CommandDef, positionals: string[]): { cmd: CommandDef; parent?: CommandDef; matched: number } {
  let cmd = root;
  let parent: CommandDef | undefined;
  let matched = 0;
  for (const token of positionals) {
    const subCommands = cmd.subCommands as Record<string, CommandDef> | undefined;
    if (subCommands && subCommands[token]) {
      parent = cmd;
      cmd = subCommands[token];
      matched++;
    } else break;
  }
  return { cmd, parent, matched };
}

// All descriptors matching a resolved command path (may be multiple for variant groups).
function descriptorsFor(positionals: string[], matched: number): Descriptor[] {
  return allDescriptors().filter(
    (entry) => entry.command.length === matched && entry.command.every((token, index) => token === positionals[index]),
  );
}

// Single descriptor for a resolved path. For variant groups, selects by the variant
// flag present in argv; returns undefined if no unique match (triggers group help).
function descriptorFor(positionals: string[], matched: number, argv: string[]): Descriptor | undefined {
  const candidates = descriptorsFor(positionals, matched);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (!candidates[0].variant) {
    const given = (flag: string) => argvHasFlag(argv, flag);
    const anyPathParam = candidates.some((c) => c.params.some((param) => param.in === "path" && given(flagOf(param))));
    return anyPathParam ? selectAlternate(candidates, given) : undefined;
  }
  for (const candidate of candidates) {
    if (candidate.variant && argvEnables(argv, candidate.variant)) return candidate;
  }
  return undefined;
}

function groupTitle(path: string[], cmd: CommandDef): string {
  const description = (cmd.meta as { description?: string } | undefined)?.description;
  if (description) return description;
  if (path.length === 1) {
    const section = titleSectionOf(path[0], allDescriptors().filter((descriptor) => descriptor.command[0] === path[0]));
    if (section) return section;
  }
  return `deel ${path.join(" ")}`;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    printVersion();
    return EXIT.OK;
  }

  const root = buildRoot();
  const words = wordIndexes(argv, root);
  const positionals = words.map((i) => argv[i]);
  const { cmd, parent, matched } = resolve(root, positionals);
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  const isGroup = isGroupCommand(cmd) || cmd === root;

  if (positionals.length > 0 && matched === 0) {
    printUnknownCommand(positionals[0], [], root);
    return EXIT.ERROR;
  }

  if (isGroup && positionals.length > matched) {
    printUnknownCommand(positionals[matched], positionals.slice(0, matched), cmd);
    return EXIT.ERROR;
  }
  const variantCandidates = descriptorsFor(positionals, matched);
  const descriptor = descriptorFor(positionals, matched, argv);

  const isMerged = variantCandidates.length > 1 && !variantCandidates[0].variant;

  if (isMerged && !descriptor && argvEnables(argv, "generate-input")) {
    printSkeleton(variantCandidates[0]);
    return EXIT.OK;
  }

  // --generate-input on a variant group without a variant flag → guide the user.
  if (variantCandidates.length > 1 && !descriptor && argvEnables(argv, "generate-input")) {
    const hint = variantCandidates.map((c) => `--${c.variant}`).join(", ");
    process.stderr.write(`Specify a variant first: ${hint}\n`);
    return EXIT.ERROR;
  }

  // Offline discovery — handled here so citty's required-arg enforcement is bypassed.
  if (descriptor && argvEnables(argv, "generate-input")) {
    printSkeleton(descriptor);
    return EXIT.OK;
  }

  if (wantsHelp && isMerged && !descriptor) {
    printAlternativesHelp(variantCandidates);
    return EXIT.OK;
  }

  // Variant group help: no variant flag specified → list available variants.
  if (wantsHelp && variantCandidates.length > 1 && !descriptor) {
    printVariantGroupHelp(variantCandidates);
    return EXIT.OK;
  }

  // Action-level help: human by default, machine-readable contract with --json.
  if (wantsHelp && descriptor) {
    if (argv.includes("--json")) printContractJson(descriptor);
    else printActionHelp(descriptor);
    return EXIT.OK;
  }
  if (cmd === root && (wantsHelp || isGroup)) {
    printRootHelp(root, sectionsByWord(allDescriptors()), new Set(Object.keys(staticCommands)));
    printGlobalOptions();
    return EXIT.OK;
  }
  if (isGroup) {
    const path = positionals.slice(0, matched);
    printGroupHelp(cmd, path, groupTitle(path, cmd), !Object.hasOwn(staticCommands, path[0]));
    return EXIT.OK;
  }
  // A static command's own help (auth login, job status, commands, ...): citty's usage.
  if (wantsHelp) {
    await showUsage(cmd, parent);
    return EXIT.OK;
  }

  // citty takes the first non-flag token as the command, so a flag value before the command words moves after them.
  const leading = new Set(words.slice(0, matched));
  const rawArgs = [...argv.filter((_, i) => leading.has(i)), ...argv.filter((_, i) => !leading.has(i))];
  await runCommand(root, { rawArgs });
  return EXIT.OK;
}
