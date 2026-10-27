export type CommandEntry = {
  command: string;
  variant?: string;
  method: string;
  path: string;
  // Asks for confirmation before the request is sent (`{param}` placeholders are filled from the flags).
  // Adds a --yes flag; without it a non-interactive run is refused.
  confirm?: string;
};

export const commandMap: CommandEntry[] = [
  { command: "adjustments create",      variant: "invoice", method: "POST", path: "/adjustments/invoice" },
  { command: "adjustments create-bulk", variant: "invoice", method: "POST", path: "/adjustments/invoice/bulk" },
  { command: "adjustments create",      variant: "payroll", method: "POST", path: "/adjustments/payroll" },
  { command: "adjustments create-bulk", variant: "payroll", method: "POST", path: "/adjustments/payroll/bulk" },

  { command: "jobs list",   method: "GET", path: "/jobs" },
  { command: "jobs status", method: "GET", path: "/jobs/{job_id}" },

  { command: "apps list", method: "GET", path: "/apps" },
  { command: "apps get",  method: "GET", path: "/apps/{app_id}" },
  { command: "apps update", method: "PATCH", path: "/apps/{app_id}" },
  {
    command: "apps disable",
    method: "POST",
    path: "/apps/{app_id}/disable",
    confirm: "Disable app {app_id}? This revokes all consents and tokens; enable does not restore them.",
  },
  { command: "apps enable", method: "POST", path: "/apps/{app_id}/enable" },
];
