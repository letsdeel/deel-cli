export type CommandEntry = {
  command: string;
  variant?: string;
  method: string;
  path: string;
};

export const commandMap: CommandEntry[] = [
  { command: "adjustments create",      variant: "invoice", method: "POST", path: "/adjustments/invoice" },
  { command: "adjustments create-bulk", variant: "invoice", method: "POST", path: "/adjustments/invoice/bulk" },
  { command: "adjustments create",      variant: "payroll", method: "POST", path: "/adjustments/payroll" },
  { command: "adjustments create-bulk", variant: "payroll", method: "POST", path: "/adjustments/payroll/bulk" },

  { command: "jobs list",   method: "GET", path: "/jobs" },
  { command: "jobs status", method: "GET", path: "/jobs/{job_id}" },

  // Public API request logs (PA-7886). Paths carry the /v2 prefix because the base URL ends at /rest.
  { command: "logs requests list",    method: "GET", path: "/v2/logs/requests" },
  { command: "logs requests get",     method: "GET", path: "/v2/logs/requests/{request_id}" },
  { command: "logs requests summary", method: "GET", path: "/v2/logs/requests/summary" },
  { command: "logs tokens list",      method: "GET", path: "/v2/logs/tokens" },
];
