// Reviewed exceptions to the generated command names. Key: "METHOD /path" (REST) or "scim METHOD /path".
// Value: the command words. A released name never changes afterwards.

export const overrides: Record<string, string> = {
  // `deel adjustments create --invoice|--payroll` is hand-picked; the documented
  // POST /adjustments gets its own name instead of taking that one.
  "POST /adjustments": "adjustments add",
};
