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

  { command: "oauth2-apps list", method: "GET", path: "/oauth2-apps" },
  { command: "oauth2-apps get",  method: "GET", path: "/oauth2-apps/{app_id}" },

  { command: "logs requests list",    method: "GET", path: "/logs/requests" },
  { command: "logs requests get",     method: "GET", path: "/logs/requests/{request_id}" },
  { command: "logs requests summary", method: "GET", path: "/logs/requests/summary" },
  { command: "logs tokens list",      method: "GET", path: "/logs/tokens" },
];
