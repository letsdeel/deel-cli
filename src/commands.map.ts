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
];
