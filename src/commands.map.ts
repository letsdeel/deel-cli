export type CommandEntry = {
  command: string;
  variant?: string;
  method: string;
  path: string;
  // Asks for confirmation before the request is sent (`{param}` placeholders are filled from the flags).
  // Adds a --yes flag; without it a non-interactive run is refused.
  confirm?: string;
  // Header parameters of the operation to expose as flags: flag name -> HTTP header name.
  headers?: Record<string, string>;
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
  { command: "oauth2-apps update", method: "PATCH", path: "/oauth2-apps/{app_id}" },
  {
    command: "oauth2-apps disable",
    method: "POST",
    path: "/oauth2-apps/{app_id}/disable",
    confirm: "Disable app {app_id}? This revokes all consents and tokens; enable does not restore them.",
  },
  { command: "oauth2-apps enable", method: "POST", path: "/oauth2-apps/{app_id}/enable" },

  { command: "oauth2-apps listing get", method: "GET", path: "/oauth2-apps/{app_id}/listing" },
  { command: "oauth2-apps listing create", method: "POST", path: "/oauth2-apps/{app_id}/listing" },
  { command: "oauth2-apps listing update", method: "PATCH", path: "/oauth2-apps/{app_id}/listing" },
  { command: "oauth2-apps listing submit", method: "POST", path: "/oauth2-apps/{app_id}/listing/submit" },
  { command: "app-store categories", method: "GET", path: "/app-store/categories" },

  { command: "files create", method: "POST", path: "/files", headers: { upload_method: "x-upload-method" } },
  { command: "files status", method: "GET", path: "/files/{file_id}/status", headers: { one_time_secret: "x-one-time-secret" } },
  { command: "files complete", method: "POST", path: "/files/{file_id}/complete", headers: { one_time_secret: "x-one-time-secret" } },
];
