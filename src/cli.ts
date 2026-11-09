// Root command wiring and routing. Builds the nested command tree from the
// generated manifest, merges in the static commands, and dispatches a run to
// citty — delegating body/response help to src/help.ts and the actual request
// to the executor. Each handler builds a Context (io + composed transport +
// clock/rng) and passes it down — no module reaches for process.* or a global.

import { defineCommand, parseArgs, runCommand, showUsage } from "citty";
import type { ArgsDef, CommandDef } from "citty";
import type { Descriptor } from "./types.ts";
import { allDescriptors, loadGeneratedDescriptors, matchForm, pickingFlags, selectForm, usageOf } from "./public-api/commands.ts";
import { acceptsFlag, argvEnables, argvMentionsFlag, flagOf, joinSwitchValues } from "./core/flags.ts";
import { parseInput } from "./core/input.ts";
import { createContext } from "./core/context.ts";
import { execute } from "./core/executor.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "./core/logging.ts";
import { EXIT } from "./core/errors.ts";
import { CliError } from "./core/errors.ts";
import { CLI_VERSION } from "./version.ts";
import { commandToken, commonArgs, configFrom, gatherFiles, gatherFlagValues, outputOpts } from "./commands/shared.ts";
import type { Args } from "./commands/shared.ts";
import { staticCommands } from "./commands/index.ts";
import {
  groupTitle,
  isGroupCommand,
  printActionHelp,
  printContractJson,
  printFormsHelp,
  printFormsJson,
  printGlobalOptions,
  printGroupHelp,
  printRootHelp,
  printSkeleton,
  printUnknownCommand,
  printVariantGroupHelp,
  printVersion,
} from "./help.ts";

// ---------------- generated action commands ----------------

function argsForDescriptor(descriptor: Descriptor): ArgsDef {
  const args: ArgsDef = { ...commonArgs };
  for (const param of descriptor.params) {
    if (descriptor.form && (param.in === "path" || descriptor.form.scopes.some((s) => s.param === param.name))) continue; // typed as an argument or a scope flag
    args[flagOf(param)] = {
      type: param.type === "boolean" ? "boolean" : param.enum ? "enum" : "string",
      description: param.description,
      required: param.in === "path" ? true : param.required,
      ...(param.enum ? { options: param.enum } : {}),
    } as ArgsDef[string];
  }
  for (const selector of descriptor.form?.selectors ?? []) {
    args[selector.flag] = selector.value === undefined ? { type: "boolean" } : { type: "string" };
  }
  for (const scope of descriptor.form?.scopes ?? []) args[scope.flag] = { type: "string", required: true };
  return args;
}

// Shared execution body extracted so both actionCommand and variantCommand can delegate to it.
async function runDescriptor(descriptor: Descriptor, cittyCtx: { args: Record<string, unknown>; rawArgs: string[] }, pathValues: Record<string, string> = {}): Promise<void> {
  const args = cittyCtx.args as Args;
  setLoggingEnabled(args.log !== false);
  setLogBodiesEnabled(args["log-bodies"] === true);

  const flags: Record<string, string | string[]> = { ...pathValues };
  for (const param of descriptor.params) {
    if (param.name in pathValues) continue;
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
  const token = commandToken(args, config);
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
  return defineCommand({
    meta: { name, description: `${name} (variants: ${variants.map((v) => `--${v}`).join(", ")})` },
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

// The switches a group's flags may carry: its switch selectors and the boolean global flags.
function switchesOf(descriptors: Descriptor[]): string[] {
  const globals = Object.entries(commonArgs).filter(([, def]) => (def as { type?: string }).type === "boolean").map(([name]) => name);
  return [...globals, ...descriptors.flatMap((d) => d.form!.selectors.filter((s) => s.value === undefined).map((s) => s.flag))];
}

// The first flag in argv, as typed, that none of `known` accepts in any spelling the parser reads (--a-b, --aB, --no-a).
export function unknownFlag(argv: string[], known: string[]): string | undefined {
  for (const token of argv) {
    if (token === "--") break;
    if (/^-[A-Za-z]/.test(token)) return token.split("=")[0]; // no short flags beyond -h and -v, read earlier
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).split("=")[0];
    const accepted = (name: string) => known.some((flag) => acceptsFlag(flag, name));
    if (!accepted(key) && !(key.startsWith("no-") && accepted(key.slice(3)))) return `--${key}`;
  }
  return undefined;
}

// The endpoints that share a generated command's words: the selector and scope flags given pick one. That
// endpoint then parses the arguments with its own flag definitions, so a flag's type, enum and required-ness
// come from it alone, and its positionals fill the path params in order.
function formCommand(descriptors: Descriptor[]): CommandDef {
  const name = descriptors[0].command[descriptors[0].command.length - 1];
  return defineCommand({
    meta: { name, description: descriptors[0].summary ?? name },
    args: { ...commonArgs },
    async run(cittyCtx) {
      const rawArgs = joinSwitchValues(cittyCtx.rawArgs, switchesOf(descriptors));
      const descriptor = selectForm(descriptors, rawArgs);
      const form = descriptor.form!;
      // --base-url is hidden from help but still takes a value, so it is declared for the parse.
      const defs: ArgsDef = { ...argsForDescriptor(descriptor), "base-url": { type: "string" } };
      // An unknown flag would be read as a switch and its value as one more argument, so it is refused instead.
      // A sibling's switch typed off (--no-bulk) is known too: it is how the form without it is picked.
      const unknown = unknownFlag(rawArgs, [...Object.keys(defs), ...switchesOf(descriptors)]);
      if (unknown) throw new CliError("usage.flag", `'${usageOf(descriptor)}' has no flag ${unknown}.`, "Run it with --help to see its flags.");
      const args = parseArgs(rawArgs, defs) as Args & { _: string[] };
      const given = args._.map(String);
      if (given.length !== form.positionals.length) {
        const count = form.positionals.length;
        throw new CliError("usage.params", `'${usageOf(descriptor)}' takes ${count} argument${count === 1 ? "" : "s"}, not ${given.length}.`, "Run it with --help to see the arguments.");
      }
      const pathValues: Record<string, string> = {};
      form.positionals.forEach((positional, index) => (pathValues[positional.param] = given[index]));
      for (const scope of form.scopes) pathValues[scope.param] = String(args[scope.flag]);
      await runDescriptor(descriptor, { ...cittyCtx, rawArgs, args }, pathValues);
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
  if (Array.isArray(node)) return node[0].form ? formCommand(node) : variantCommand(node);
  if (!(node instanceof Map)) return (node as Descriptor).form ? formCommand([node as Descriptor]) : actionCommand(node as Descriptor);
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

// A flag followed by a value (`--env demo`, `--worker-type eor`) must not leave that value among the command words.
// Global flags are classified by their declared type; any other flag takes the next token unless it names a subcommand.
function flagTakesValue(token: string, next: string | undefined, cmd: CommandDef | undefined): boolean {
  if (!token.startsWith("--") || token.includes("=") || next === undefined || next.startsWith("-")) return false;
  const name = token.slice(2).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  if (name === "base-url") return true;
  const declared = (commonArgs[name] ?? (name.startsWith("no-") ? commonArgs[name.slice(3)] : undefined)) as { type?: string } | undefined;
  if (declared) return declared.type === "string";
  const subCommands = cmd?.subCommands as Record<string, CommandDef> | undefined;
  return !(subCommands && Object.hasOwn(subCommands, next));
}

// The argv indexes of the command words and the arguments after them, skipping every flag value.
function wordIndexes(argv: string[], root: CommandDef): number[] {
  const indexes: number[] = [];
  let cmd: CommandDef | undefined = root;
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("-")) {
      indexes.push(i);
      const subCommands = cmd?.subCommands as Record<string, CommandDef> | undefined;
      cmd = subCommands && Object.hasOwn(subCommands, argv[i]) ? subCommands[argv[i]] : undefined;
    } else if (flagTakesValue(argv[i], argv[i + 1], cmd)) i++;
  }
  return indexes;
}

// Walk the tree by the leading command words to find the target command.
function resolve(root: CommandDef, positionals: string[]): { cmd: CommandDef; parent?: CommandDef; matched: number } {
  let cmd = root;
  let parent: CommandDef | undefined;
  let matched = 0;
  for (const token of positionals) {
    const subCommands = cmd.subCommands as Record<string, CommandDef> | undefined;
    if (subCommands && Object.hasOwn(subCommands, token)) {
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
  // The words alone list every endpoint: the bare command is a name, not a default. Once a picking flag or an
  // argument is typed, help shows the endpoint that command line would call.
  if (candidates[0].form) {
    const normalized = joinSwitchValues(argv, switchesOf(candidates));
    const picked = candidates.some((d) => pickingFlags(d.form!).some((flag) => argvMentionsFlag(normalized, flag)));
    return picked || positionals.length > matched ? matchForm(candidates, normalized) : undefined;
  }
  for (const candidate of candidates) {
    if (candidate.variant && argvEnables(argv, candidate.variant)) return candidate;
  }
  return undefined;
}

export async function run(argv: string[]): Promise<number> {
  // What follows -- is arguments (an ID may start with -), so the CLI's own options are read before it only.
  const end = argv.indexOf("--");
  const options = end === -1 ? argv : argv.slice(0, end);
  if (options.includes("--version") || options.includes("-v")) {
    printVersion();
    return EXIT.OK;
  }

  // A static command (auth, job) never needs the generated manifest.
  const first = options.find((token) => !token.startsWith("-"));
  if (!(first && Object.hasOwn(staticCommands, first))) await loadGeneratedDescriptors();
  const root = buildRoot();
  const words = wordIndexes(options, root);
  const positionals = words.map((i) => options[i]);
  const { cmd, parent, matched } = resolve(root, positionals);
  const wantsHelp = options.includes("--help") || options.includes("-h");
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
  const descriptor = descriptorFor(positionals, matched, options);

  const isForms = variantCandidates.length > 1 && Boolean(variantCandidates[0].form);

  // --generate-input on a variant group without a variant flag → guide the user.
  if (variantCandidates.length > 1 && !descriptor && argvEnables(options, "generate-input")) {
    const hint = isForms ? `\n${variantCandidates.map((c) => `  ${usageOf(c)}`).join("\n")}` : variantCandidates.map((c) => `--${c.variant}`).join(", ");
    process.stderr.write(`Specify a variant first: ${hint}\n`);
    return EXIT.ERROR;
  }

  // Offline discovery — handled here so citty's required-arg enforcement is bypassed.
  if (descriptor && argvEnables(options, "generate-input")) {
    printSkeleton(descriptor);
    return EXIT.OK;
  }

  if (wantsHelp && isForms && !descriptor) {
    if (options.includes("--json")) printFormsJson(variantCandidates);
    else printFormsHelp(variantCandidates);
    return EXIT.OK;
  }

  // Variant group help: no variant flag specified → list available variants.
  if (wantsHelp && variantCandidates.length > 1 && !descriptor) {
    printVariantGroupHelp(variantCandidates);
    return EXIT.OK;
  }

  // Action-level help: human by default, machine-readable contract with --json.
  if (wantsHelp && descriptor) {
    if (options.includes("--json")) printContractJson(descriptor);
    else printActionHelp(descriptor);
    return EXIT.OK;
  }
  const at = (path: string[]) => descriptorsFor(path, path.length);
  if (cmd === root && (wantsHelp || isGroup)) {
    printRootHelp(root, new Set(Object.keys(staticCommands)), at);
    printGlobalOptions();
    return EXIT.OK;
  }
  if (isGroup) {
    const path = positionals.slice(0, matched);
    const own = Object.hasOwn(staticCommands, path[0]) ? (cmd.meta as { description?: string } | undefined)?.description : undefined;
    printGroupHelp(cmd, path, own ?? groupTitle(path), at, !Object.hasOwn(staticCommands, path[0]));
    return EXIT.OK;
  }
  // A static command's own help (auth login, job status, commands, ...): citty's usage.
  if (wantsHelp) {
    await showUsage(cmd, parent);
    return EXIT.OK;
  }

  // citty takes the first non-flag token as the command, so a flag value before the command words moves after them.
  const leading = new Set(words.slice(0, matched));
  const rawArgs = [...options.filter((_, i) => leading.has(i)), ...options.filter((_, i) => !leading.has(i)), ...argv.slice(options.length)];
  await runCommand(root, { rawArgs });
  return EXIT.OK;
}
