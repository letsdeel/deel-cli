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
