// Root command wiring and routing. Builds the nested command tree from the
// generated manifest, merges in the static commands, and dispatches a run to
// citty — delegating body/response help to src/help.ts and the actual request
// to the executor. Each handler builds a Context (io + composed transport +
// clock/rng) and passes it down — no module reaches for process.* or a global.

import { isatty } from "node:tty";
import { defineCommand, parseArgs, runCommand, showUsage } from "citty";
import type { ArgsDef, CommandDef } from "citty";
import type { Descriptor } from "./types.ts";
import { allDescriptors, loadGeneratedDescriptors, matchForm, pickingFlags, selectForm, usageOf } from "./public-api/commands.ts";
import { acceptsFlag, argvEnables, argvMentionsFlag, flagMissingValue, flagOf, joinSwitchValues, unknownFlag } from "./core/flags.ts";
export { unknownFlag };
import { parseInput } from "./core/input.ts";
import { createContext } from "./core/context.ts";
import { confirmMessage, execute } from "./core/executor.ts";
import { promptConfirm } from "./core/prompt.ts";
import type { Confirm } from "./core/prompt.ts";
import type { IOStreams } from "./core/io.ts";
import { realIO } from "./core/io.ts";
import { envelope, render } from "./core/output.ts";
import { versionListing, versionTable } from "./core/versions.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "./core/logging.ts";
import { EXIT } from "./core/errors.ts";
import { CliError } from "./core/errors.ts";
import { CLI_VERSION } from "./version.ts";
import { commandToken, commonArgs, configFrom, gatherFiles, gatherFlagValues, outputOpts, refuseMissingValues, valuedFlags } from "./commands/shared.ts";
import type { Args } from "./commands/shared.ts";
import { staticCommands } from "./commands/index.ts";
import {
  didYouMean,
  groupTitle,
  printActionHelp,
  printContractJson,
  printFormsHelp,
  printFormsJson,
  printGlobalOptions,
  printGroupHelp,
  printRootHelp,
  printSkeleton,
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
  if (confirmMessage(descriptor)) args.yes = YES_ARG;
  return args;
}

const YES_DESCRIPTION = "Skip the confirmation prompt (required without a terminal, or when stdin carries the token or the input)";
const YES_ARG = { type: "boolean", description: YES_DESCRIPTION } as ArgsDef[string];

// A command in CONFIRM_ROUTES asks before anything is sent. A terminal gets a [y/N] prompt on stderr (only y/yes goes
// on); --yes skips it; without a terminal (no TTY, CI or an agent) --yes is required, so a script never runs the
// command by accident. Reading the token or the body from stdin (--token-stdin, --input -) leaves nothing to answer
// the prompt, so those runs need --yes too. Runs before the token lookup and the request.
export async function confirmDescriptor(
  descriptor: Descriptor,
  flags: Record<string, string | string[]>,
  yes: boolean,
  io: IOStreams,
  ask: Confirm = promptConfirm,
  stdinInUse = false,
  message = confirmMessage(descriptor),
): Promise<void> {
  if (!message || yes) return;
  const name = descriptor.form ? usageOf(descriptor) : `deel ${descriptor.command.join(" ")}`;
  if (stdinInUse) {
    throw new CliError("usage.confirm", `Refusing to run \`${name}\` without confirmation`, "Pass --yes: stdin carries the token or the input, or is not a terminal, so there is no prompt to answer.");
  }
  if (!io.interactive) {
    throw new CliError("usage.confirm", `Refusing to run \`${name}\` without confirmation`, "Pass --yes to run this non-interactively.");
  }
  const question = message.replace(/\{([^}]+)\}/g, (match, key: string) => (flags[key] !== undefined ? String(flags[key]) : match));
  if (!(await ask(`${question} [y/N] `))) throw new CliError(`${descriptor.command[0]}.aborted`, `Aborted: \`${name}\` was not run`);
}

// stdin cannot answer the prompt when it carries the token or the body, or when it is not a terminal (a pipe would be read as the answer).
export function isStdinInUse(args: Partial<Pick<Args, "input" | "token-stdin">>, stdinIsTTY: boolean): boolean {
  return args.input === "-" || Boolean(args["token-stdin"]) || !stdinIsTTY;
}

// Only asks the terminal when a prompt could be needed: touching process.stdin on a pipe makes fd 0 non-blocking, which breaks the later --token-stdin read (EAGAIN).
export function resolveStdinInUse(descriptor: Descriptor, args: Partial<Pick<Args, "input" | "token-stdin" | "yes">>, stdinIsTTY: () => boolean): boolean {
  if (!confirmMessage(descriptor) || args.yes === true) return false;
  return isStdinInUse(args, stdinIsTTY());
}

// Shared execution body extracted so both actionCommand and variantCommand can delegate to it. `formValues` are the
// params a form fills itself: its positional IDs and its scope flags, whether the param sits in the path or the query.
async function runDescriptor(descriptor: Descriptor, cittyCtx: { args: Record<string, unknown>; rawArgs: string[] }, formValues: Record<string, string> = {}): Promise<void> {
  const args = cittyCtx.args as Args;
  // Every flag of this endpoint that takes a value (its own parameters as well as the global ones), before --input, --file
  // or anything else reads a value, and before any request: citty reads a bare one as `true` or as the next flag.
  refuseMissingValues(cittyCtx.rawArgs, argsForDescriptor(descriptor));
  setLoggingEnabled(args.log !== false);
  setLogBodiesEnabled(args["log-bodies"] === true);

  const flags: Record<string, string | string[]> = { ...formValues };
  for (const param of descriptor.params) {
    if (param.name in formValues) continue;
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
  const stdinInUse = resolveStdinInUse(descriptor, args, () => isatty(0));
  await confirmDescriptor(descriptor, flags, args.yes === true, realIO(), promptConfirm, stdinInUse);
  // execute() sends X-Beta itself so it can drop the header on a retry; the transport must not add it back.
  const config = configFrom({ ...args, beta: false }, cittyCtx.rawArgs);
  const token = commandToken(args, config);
  const ctx = createContext({ config, token });
  await execute(descriptor, call, ctx, {
    output: outputOpts(args),
    debug: Boolean(args.debug),
    form: Boolean(args.form),
    version: { apiVersion: args.version as string | undefined, beta: args.beta === true },
  });
}

// The command declares the parameters of the endpoint it runs and nothing else, so a flag it doesn't know would be
// ignored and the call would run without it: it is refused instead. `extra` are the flags the command accepts beyond
// those of `descriptor`, such as the selectors of its variants; --base-url is hidden from help but always accepted.
function refuseUnknownFlag(rawArgs: string[], descriptor: Descriptor, extra: string[] = []): void {
  const unknown = unknownFlag(rawArgs, [...Object.keys(argsForDescriptor(descriptor)), ...extra, "base-url"]);
  if (unknown) {
    const named = descriptor.variant ? ` --${descriptor.variant}` : "";
    throw new CliError("usage.flag", `'deel ${descriptor.command.join(" ")}${named}' has no flag ${unknown}.`, "Run it with --help to see its flags.");
  }
}

function actionCommand(descriptor: Descriptor): CommandDef {
  return defineCommand({
    meta: { name: descriptor.command[descriptor.command.length - 1], description: `${descriptor.summary ?? ""}${descriptor.async ? " (async)" : ""}` },
    args: argsForDescriptor(descriptor),
    async run(cittyCtx) {
      refuseUnknownFlag(cittyCtx.rawArgs, descriptor);
      await runDescriptor(descriptor, cittyCtx);
    },
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
      // The command declares the parameters of every variant, so one that only another variant takes would be
      // accepted here and then dropped from the request.
      refuseUnknownFlag(cittyCtx.rawArgs, descriptor, variants);
      await runDescriptor(descriptor, cittyCtx);
    },
  });
}

// The switches a group's flags may carry: the boolean global flags, its endpoints' own boolean parameters and its
// switch selectors. `--flag false` is read as `--flag=false` for each of them, so a stray `false` is never an argument.
function switchesOf(descriptors: Descriptor[]): string[] {
  const globals = Object.entries(commonArgs).filter(([, def]) => (def as { type?: string }).type === "boolean").map(([name]) => name);
  const own = descriptors.flatMap((d) => d.params.filter((param) => param.type === "boolean").map(flagOf));
  return [...globals, ...own, ...descriptors.flatMap((d) => (d.form?.selectors ?? []).filter((s) => s.value === undefined).map((s) => s.flag))];
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
      // An unknown flag would be read as a switch and its value as one more argument, so it is refused instead. A
      // sibling's switch selector typed off (--no-bulk) is known too: it is how the form without it is picked. A
      // flag only a sibling endpoint takes is not: it would be accepted and then dropped, and the call would run without it.
      const siblingSwitches = descriptors.flatMap((d) => (d.form?.selectors ?? []).filter((s) => s.value === undefined).map((s) => s.flag));
      const unknown = unknownFlag(rawArgs, [...Object.keys(defs), ...siblingSwitches]);
      if (unknown) {
        const owner = descriptors.find((d) => d !== descriptor && unknownFlag([unknown], Object.keys(argsForDescriptor(d))) === undefined);
        throw new CliError(
          "usage.flag",
          `'${usageOf(descriptor)}' has no flag ${unknown}${owner ? `; only '${usageOf(owner)}' takes it` : ""}.`,
          owner ? "Pick that endpoint's flags, or drop the flag. Nothing was sent." : "Run it with --help to see its flags.",
        );
      }
      // A flag that takes a value and has none would swallow the next flag as its value (or send it empty).
      const missing = flagMissingValue(rawArgs, [...descriptor.params.filter((param) => param.type !== "boolean").map(flagOf), ...form.scopes.map((scope) => scope.flag), ...form.selectors.filter((s) => s.value !== undefined).map((s) => s.flag)]);
      if (missing) throw new CliError("usage.flag_value", `--${missing} needs a value.`, `Write --${missing}=<value>; run it with --help to see the values.`);
      const args = parseArgs(rawArgs, defs) as Args & { _: string[] };
      const given = args._.map(String);
      if (given.length !== form.positionals.length) {
        const count = form.positionals.length;
        throw new CliError("usage.params", `'${usageOf(descriptor)}' takes ${count} argument${count === 1 ? "" : "s"}, not ${given.length}.`, "Run it with --help to see the arguments.");
      }
      const formValues: Record<string, string> = {};
      form.positionals.forEach((positional, index) => (formValues[positional.param] = given[index]));
      for (const scope of form.scopes) formValues[scope.param] = String(args[scope.flag]);
      await runDescriptor(descriptor, { ...cittyCtx, rawArgs, args }, formValues);
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

// The words in argv, each with its index: the tokens that are neither a flag nor the value of one that takes a
// value (`--env demo`), in order — the command's words, then its arguments. A `--flag=value` carries its own value.
function wordsAt(argv: string[], valued: string[]): Array<{ word: string; index: number }> {
  const takesValue = (token: string | undefined) =>
    token !== undefined && token.startsWith("--") && !token.includes("=") && valued.some((flag) => acceptsFlag(flag, token.slice(2)));
  return argv.flatMap((token, index) => (!token.startsWith("-") && !takesValue(argv[index - 1]) ? [{ word: token, index }] : []));
}

const wordsOf = (argv: string[], valued: string[]): string[] => wordsAt(argv, valued).map(({ word }) => word);

// The flags that take a value: the global ones, and those that pick among the endpoints sharing a command's words
// (`--worker-type eor`, `--as worker`, `--contract <id>`), so `deel contracts --worker-type eor --help` reads `eor` as a value.
function valueFlags(): string[] {
  const picking = allDescriptors().flatMap((d) => (d.form ? [...d.form.selectors.filter((s) => s.value !== undefined).map((s) => s.flag), ...d.form.scopes.map((s) => s.flag)] : []));
  return [...new Set([...valuedFlags(commonArgs), ...picking])];
}

// An option other than a help switch: what citty would drop if it stood before a command's last word. (Help is
// answered by run() itself, so it is never dropped.)
const isOption = (token: string): boolean => token.startsWith("-") && token !== "--help" && token !== "-h";

// Walk the tree by the command words to find the target command.
function resolve(root: CommandDef, words: string[]): { cmd: CommandDef; parent?: CommandDef; matched: number } {
  let cmd = root;
  let parent: CommandDef | undefined;
  let matched = 0;
  for (const token of words) {
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

async function printVersions(descriptor: Descriptor, argv: string[]): Promise<void> {
  const listing = versionListing(descriptor, Date.now());
  const io = realIO();
  const opts = outputOpts(parseArgs(argv, commonArgs));
  // The table is the human form: only on a terminal with --no-json, and never when --jq, --fields or --quiet shape the data.
  if (!opts.json && io.interactive && !opts.jq && !opts.fields && !opts.quiet) {
    io.out(versionTable(listing));
    return;
  }
  await render(io, envelope(listing), opts);
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
    // A flag's value (--env demo, --limit 5) is not an argument.
    const valued = candidates.flatMap((d) => valuedFlags(argsForDescriptor(d)));
    return picked || wordsOf(normalized, valued).length > matched ? matchForm(candidates, normalized) : undefined;
  }
  for (const candidate of candidates) {
    if (candidate.variant && argvEnables(argv, candidate.variant)) return candidate;
  }
  return undefined;
}

// `--version <date>` after a command picks the API version, so only a bare `--version` prints the CLI's, even behind a
// flag's value (`--env demo --version`), which run()'s first check cannot tell from a command word. (-v is answered there.)
function wantsCliVersion(argv: string[]): boolean {
  return argv.includes("--version") && wordsOf(argv, valuedFlags(commonArgs)).length === 0;
}

export async function run(argv: string[]): Promise<number> {
  // What follows -- is arguments (an ID may start with -), so the CLI's own options are read before it only.
  const end = argv.indexOf("--");
  const options = end === -1 ? argv : argv.slice(0, end);
  // A bare --version needs nothing loaded; `--version <date>` after a command picks the API version instead.
  if (options.includes("-v") || (options.includes("--version") && !options.some((token) => !token.startsWith("-")))) {
    printVersion();
    return EXIT.OK;
  }

  // A static command (auth, job, commands) never needs the generated manifest.
  const first = wordsOf(options, valuedFlags(commonArgs))[0];
  if (!(first && Object.hasOwn(staticCommands, first))) await loadGeneratedDescriptors();
  const root = buildRoot();
  if (wantsCliVersion(options)) {
    printVersion();
    return EXIT.OK;
  }

  // The command's words, without the values of the flags (`--env demo`, `--worker-type eor`): every decision below reads these.
  const found = wordsAt(options, valueFlags());
  const words = found.map(({ word }) => word);
  const { cmd, parent, matched } = resolve(root, words);
  const wantsHelp = options.includes("--help") || options.includes("-h");
  const isGroup = typeof cmd.run !== "function";

  if (words.length > 0 && matched === 0) {
    const before = options.slice(0, found[0].index).some(isOption);
    throw new CliError("usage.command", `Unknown command '${words[0]}'.${didYouMean(words[0], root)}`, before ? "Options go after the command: deel <command> … --option." : "Run 'deel --help' to see available commands.");
  }
  // A word after a group that names none of its commands (a removed or mistyped one) fails instead of showing the
  // group's help and exiting 0.
  const stray = isGroup ? words[matched] : undefined;
  if (stray !== undefined) {
    const group = words.slice(0, matched).join(" ");
    throw new CliError("usage.command", `Unknown command 'deel ${group} ${stray}'.${didYouMean(stray, cmd)}`, `Run 'deel ${group} --help' to see its commands.`);
  }

  // A static command (auth, job, commands) calls no endpoint with a version of its own: refuse the flags that would
  // pick one instead of accepting and ignoring them. (A --version with no value is refused as such, further on.)
  const versionFlag = first !== undefined && Object.hasOwn(staticCommands, first) ? ["version", "versions", "beta"].find((flag) => argvMentionsFlag(options, flag) && (flag !== "version" || flagMissingValue(options, [flag]) === undefined)) : undefined;
  if (versionFlag) {
    throw new CliError("usage.flag", `'deel ${words.join(" ")}' has no --${versionFlag}.`, "--version, --versions and --beta pick an API version of the commands that call an endpoint; deel --version prints the CLI's.");
  }

  const positionals = words;
  const variantCandidates = descriptorsFor(positionals, matched);
  const descriptor = descriptorFor(positionals, matched, options);

  const isForms = variantCandidates.length > 1 && Boolean(variantCandidates[0].form);

  // --generate-input on a variant group without a variant flag → guide the user.
  if (variantCandidates.length > 1 && !descriptor && argvEnables(options, "generate-input")) {
    const hint = isForms ? `\n${variantCandidates.map((c) => `  ${usageOf(c)}`).join("\n")}` : variantCandidates.map((c) => `--${c.variant}`).join(", ");
    throw new CliError("usage.variant", `Specify a variant first: ${hint}`);
  }

  if (variantCandidates.length > 1 && !descriptor && argvEnables(options, "versions") && !wantsHelp) {
    const hint = isForms ? `the flags of one of:\n${variantCandidates.map((c) => `  ${usageOf(c)}`).join("\n")}` : variantCandidates.map((c) => `--${c.variant}`).join(", ");
    throw new CliError("usage.versions", `'deel ${variantCandidates[0].command.join(" ")}' has several endpoints; pick one with ${hint}`);
  }

  // Offline discovery — handled here so citty's required-arg enforcement is bypassed.
  if (descriptor && argvEnables(options, "versions") && !wantsHelp) {
    await printVersions(descriptor, options);
    return EXIT.OK;
  }
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

  // Everything run() answers itself (--version, --help, --generate-input, --json with help) has returned above, so
  // the options still unread are the ones citty is about to take: it hands a command only the tokens after its own
  // word, so one before the command's last word (a leading `--env=demo`, or one between the words) would be dropped
  // and the call would go out without it.
  if (matched > 0 && options.slice(0, found[matched - 1].index).some(isOption)) {
    throw new CliError("usage.command", `Options go after the command: write 'deel ${words.slice(0, matched).join(" ")} …' with the options at the end.`);
  }
  await runCommand(root, { rawArgs: argv });
  return EXIT.OK;
}
