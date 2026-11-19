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
