// Job status lookup via the injected transport. Jobs are served under the
// same /rest-prefixed base URL as every other endpoint — no separate origin.
// Auth/request-id come from transport middleware.

import type { Transport } from "./http.ts";
import { CliError } from "./errors.ts";
import { HEADER } from "./constants.ts";

// Matches GET /jobs/:job_id: an overall status plus one entry per item the
// operation processed. Statuses are uppercase, as the API returns them.
export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type JobItem = { external_id?: string; status: JobStatus; error?: unknown };
export type Job = { status: JobStatus; items: JobItem[] };

export async function fetchJob(http: Transport, baseUrl: string, jobId: string): Promise<Job> {
  const response = await http({
    method: "GET",
    url: `${baseUrl}/jobs/${encodeURIComponent(jobId)}`,
    headers: { [HEADER.accept]: "application/json" },
    retryable: true,
    meta: { command: "job status", job_id: jobId },
  });
  if (response.status === 404) throw new CliError("job.not_found", `Job ${jobId} not found`);
  if (response.status >= 400) throw new CliError("job.error", `Job lookup failed (${response.status})`);
  const data = (response.json as any)?.data ?? {};
  return { status: data.status, items: Array.isArray(data.items) ? data.items : [] };
}
