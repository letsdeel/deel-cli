// Shared types for the Deel CLI.
// Kept type-only so Node's type-stripping runtime never sees runtime bindings.

export type ParamLoc = "path" | "query" | "body";

export type ScalarType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export type CliParam = {
  name: string;
  in: ParamLoc;
  type: ScalarType;
  required: boolean;
  enum?: string[];
  description?: string;
  properties?: CliParam[];
  maxItems?: number; // for type "array": max number of items the API accepts for this field
};

export type BodyKind = "none" | "json" | "json-array" | "multipart";

export type Descriptor = {
  command: string[]; // e.g. ["adjustments", "create"]
  variant?: string;  // mutually-exclusive selector for commands sharing the same command path
  method: string; // GET | POST | PATCH | PUT | DELETE
  path: string; // e.g. /adjustments/{id}
  summary?: string;
  version?: string; // from x-version
  async: boolean; // true when the operation returns 202
  bodyKind: BodyKind; // the default body encoding
  supportsMultipart: boolean; // operation also accepts multipart/form-data (use --form)
  bodyWrapper: "data" | "none"; // body is nested under a single `data` object
  params: CliParam[]; // path + query params (become --<name> flags)
  bodyProps: CliParam[]; // body fields, unwrapped from `data`; for bodyKind "json-array" these describe each array item (for --help / --generate-input)
  maxItems?: number; // for bodyKind "json-array": max number of items the API accepts in one request
  fileFields: string[]; // multipart binary field names (become --file)
  responseKind: "object" | "array" | "none"; // shape of the success response's data
  responseFields: CliParam[]; // top-level fields of the response data (the contract)
};

export type Manifest = {
  apiTitle: string;
  descriptors: Descriptor[];
};
