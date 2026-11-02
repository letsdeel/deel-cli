// Deterministic command names: the static path segments, kebab-cased, plus one action from the HTTP method.
// The action is always the last word, so a new endpoint can't turn an existing command into a group.
// Path parameters become required flags; SCIM commands live under a `scim` group.

export type Api = "rest" | "scim";

const ACTIONS: Record<string, { collection: string; item: string }> = {
  GET: { collection: "list", item: "get" },
  POST: { collection: "create", item: "create" },
  PATCH: { collection: "update", item: "update" },
  PUT: { collection: "replace", item: "replace" },
  DELETE: { collection: "delete", item: "delete" },
};

export function isParamSegment(segment: string): boolean {
  return segment.includes("{");
}

// "custom_fields" -> "custom-fields", "vendorBills" -> "vendor-bills", "Users" -> "users".
export function kebab(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

export function deriveCommand(api: Api, method: string, path: string): string[] {
  const action = ACTIONS[method.toUpperCase()];
  if (!action) throw new Error(`Unsupported method ${method} for ${path}`);
  const segments = path.split("/").filter(Boolean);
  const words = segments.filter((segment) => !isParamSegment(segment)).map(kebab).filter(Boolean);
  if (words.length === 0) throw new Error(`No static path segment to name ${method} ${path}`);
  const last = segments[segments.length - 1];
  const verb = isParamSegment(last) ? action.item : action.collection;
  return [...(api === "scim" ? ["scim"] : []), ...words, verb];
}
