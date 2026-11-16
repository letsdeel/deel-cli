// Confirmation before a command acts. A command that asks first declares its question (a generated command through
// its command-map entry's `confirmPrompt`), and every one of them goes through requireConfirmation: same prompt,
// same refusals, same --confirm. A hand-written command that needs one calls requireConfirmation before it acts.
//
// - A person at a terminal (stdin and stderr are TTYs, no agent or CI signal) is asked `[y/N]` on stderr. Only y or yes,
//   in any case, goes on; no, an empty line, a closed input and no answer within CONFIRM_TIMEOUT_MS all abort.
// - --confirm treats the question as answered yes, in every environment. Only a command that asks first takes it;
//   any other command refuses it as an unknown flag, so --confirm never reads as having done something.
// - Anywhere nobody can answer (no terminal, CI, an agent, or stdin carrying the token or the body) the command is
//   refused without --confirm, before the token is read and before any request.

import { isatty } from "node:tty";
import { CONFIRM_TIMEOUT_MS } from "./constants.ts";
import { CliError } from "./errors.ts";
import type { IOStreams } from "./io.ts";
import { acceptsFlag } from "./flags.ts";
import { promptConfirm } from "./prompt.ts";
import type { Confirm } from "./prompt.ts";

export const CONFIRM_FLAG = "confirm";
export const CONFIRM_DESCRIPTION = "Run without the confirmation prompt (needed without a terminal, in CI or under an agent)";

export type ConfirmationRequest = {
  name: string; // the command as typed in the errors, e.g. "deel webhooks delete <id>"
  group: string; // the error code's prefix: `<group>.aborted`
  prompt: string | undefined; // the question; undefined when the command asks nothing
  values: Record<string, unknown>; // what fills the prompt's {param} placeholders
  confirmed: boolean; // --confirm was given
  io: IOStreams;
  stdinInUse?: boolean; // stdin carries the token or the body, so it can't carry an answer
  ask?: Confirm;
};

// Fill {param} from the values given; a placeholder with no value stays as written.
export function fillPrompt(prompt: string, values: Record<string, unknown>): string {
  return prompt.replace(/\{([^}]+)\}/g, (match, key: string) => (values[key] !== undefined ? String(values[key]) : match));
}

export async function requireConfirmation(request: ConfirmationRequest): Promise<void> {
  const { name, group, prompt, values, confirmed, io, stdinInUse = false, ask = promptConfirm } = request;
  if (!prompt || confirmed) return;
  const refused = `Refusing to run \`${name}\` without confirmation`;
  if (stdinInUse) throw new CliError("usage.confirm", refused, "Pass --confirm: stdin carries the token or the input, or is not a terminal, so there is no prompt to answer.");
  if (!io.canPrompt) throw new CliError("usage.confirm", refused, "Pass --confirm to run this without a terminal, in CI or under an agent.");
  const answer = await ask(`${fillPrompt(prompt, values)} [y/N] `);
  if (answer === true) return;
  if (answer === "timeout") {
    throw new CliError(`${group}.aborted`, `Aborted: \`${name}\` was not run`, `No answer within ${CONFIRM_TIMEOUT_MS / 1000}s. Pass --confirm to run it without the prompt.`);
  }
  throw new CliError(`${group}.aborted`, `Aborted: \`${name}\` was not run`);
}

// stdin cannot answer the prompt when it carries the token or the body, or when it is not a terminal (a pipe would be read as the answer).
export function isStdinInUse(args: { input?: unknown; "token-stdin"?: unknown }, stdinIsTTY: boolean): boolean {
  return args.input === "-" || Boolean(args["token-stdin"]) || !stdinIsTTY;
}

// Asks the terminal only when a prompt could be needed. isatty(0) never creates process.stdin, whose creation on a
// pipe makes fd 0 non-blocking and breaks the later --token-stdin read (EAGAIN).
export function resolveStdinInUse(prompt: string | undefined, args: { input?: unknown; "token-stdin"?: unknown; confirm?: unknown }, stdinIsTTY: () => boolean = () => isatty(0)): boolean {
  if (!prompt || args.confirm === true) return false;
  return isStdinInUse(args, stdinIsTTY());
}

// --yes was the flag before --confirm, on the commands that ask first. A script that still passes it to one of them is
// refused with the new name instead of being told only that the flag is unknown; it is never read as a yes.
export function retiredFlagError(unknown: string | undefined): CliError | undefined {
  if (!unknown?.startsWith("--")) return undefined;
  const key = unknown.slice(2);
  if (!acceptsFlag("yes", key) && !(key.startsWith("no-") && acceptsFlag("yes", key.slice(3)))) return undefined;
  return new CliError("usage.flag", `${unknown} was renamed to --confirm.`, "Pass --confirm to run without the confirmation prompt. Nothing was sent.");
}
