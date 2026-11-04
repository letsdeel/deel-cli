import { createInterface } from "node:readline";

export type Confirm = (question: string) => Promise<boolean>;

export function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

// Default delete confirmation: one line read from stdin, the question on stderr. Closing the input without an answer
// (EOF after --token-stdin consumed stdin, Ctrl-D, Ctrl-C) counts as "no", so the promise always settles.
export function promptConfirm(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rl.once("close", () => settle(false));
    rl.question(question, (answer) => {
      settle(isYes(answer));
      rl.close();
    });
  });
}
