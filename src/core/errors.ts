// Stable error envelope. The process exit status is intentionally binary:
// 0 = success, 1 = error. All failure detail lives in the error envelope
// (code / message / next / request_id), never encoded in the exit code.

export const EXIT = {
  OK: 0,
  ERROR: 1,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  code: string;
  next?: string;
  requestId?: string;

  constructor(code: string, message: string, next?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.next = next;
  }
}

// Errors raised before a request left the machine (a failed login refresh, a name that doesn't resolve): whatever
// code they carry, the action behind the request can't have run.
const notSent = new WeakSet<object>();

export function markNotSent<T>(error: T): T {
  if (error && typeof error === "object") notSent.add(error);
  return error;
}

export const wasNotSent = (error: unknown): boolean => Boolean(error) && typeof error === "object" && notSent.has(error as object);

export type ErrorEnvelope = {
  code: string;
  message: string;
  next?: string;
  request_id?: string;
};

export function toEnvelope(err: CliError): ErrorEnvelope {
  return { code: err.code, message: err.message, next: err.next, request_id: err.requestId };
}

// The argument parser (citty) raises its own errors, and colours the flag and value names in the message.
// An envelope is read by scripts and agents, so the colour codes (CSI sequences, e.g. ESC[36m) are cut out.
const ANSI_CSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

// An error the argument parser threw (name CLIError, or code EARG), not one of ours.
export function isParserError(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  return e?.name === "CLIError" || e?.code === "EARG";
}

export function usageEnvelope(err: { message?: string }): ErrorEnvelope {
  return {
    code: "usage",
    message: stripAnsi(err.message ?? "Invalid usage."),
    next: "Run the command with --help to see its arguments and flags.",
  };
}

// What the top-level handler prints on stderr for anything `run()` rejects with: a CliError as is, a citty
// usage error (bad flag or missing argument) as `usage`, anything else as `unexpected`.
export function failureEnvelope(err: unknown): { error: Pick<ErrorEnvelope, "code" | "message"> | ErrorEnvelope } {
  if (err instanceof CliError) return { error: toEnvelope(err) };
  if (isParserError(err)) return { error: usageEnvelope(err as Error) };
  const message = (err as { message?: string } | null | undefined)?.message ?? String(err);
  return { error: { code: "unexpected", message } };
}
