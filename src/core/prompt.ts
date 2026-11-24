import { createInterface } from "node:readline";
import { CONFIRM_TIMEOUT_MS } from "./constants.ts";

// The answer to a [y/N] question: true for y or yes, false for anything else or a closed input, "timeout" when
// nobody answered in time.
export type Answer = boolean | "timeout";
export type Confirm = (question: string) => Promise<Answer>;

export function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

// The confirmation prompt: one line read from stdin, the question on stderr. Closing the input without an answer
// (EOF after --token-stdin consumed stdin, Ctrl-D, Ctrl-C) counts as "no", and so does no answer within `timeoutMs`,
// so the promise always settles and a terminal nobody watches never hangs the run.
export function promptConfirm(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  timeoutMs: number = CONFIRM_TIMEOUT_MS,
): Promise<Answer> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const settle = (value: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      settle("timeout");
      output.write("\n");
      rl.close();
    }, timeoutMs);
    rl.once("close", () => settle(false));
    rl.question(question, (answer) => {
      settle(isYes(answer));
      rl.close();
    });
  });
}
