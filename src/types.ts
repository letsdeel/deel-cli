// Shared types for the Deel CLI.
// Kept type-only so Node's type-stripping runtime never sees runtime bindings.

export type ParamLoc = "path" | "query" | "body";

export type ScalarType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export type CliParam = {
  name: string;
  in: ParamLoc;
  type: ScalarType;
  required: boolean;
  nullable?: true; // the spec allows null here; shown in --help. Shorthand `field=null` coerces to null for top-level body fields only (nested flags are not read)
  enum?: string[];
  description?: string;
  properties?: CliParam[];
  maxItems?: number; // for type "array": max number of items the API accepts for this field
  flag?: string; // the CLI flag, when the API name clashes with a global flag (e.g. "fields-param")
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
  // Generated public API commands only (src/public-api/manifest.json):
  api?: Api;
  beta?: boolean;
  versions?: VersionInfo[]; // every live version of the endpoint, oldest first
  form?: CommandForm; // how the command line picks this endpoint and fills its path params
};

// Which of Deel's two API surfaces an endpoint belongs to; the only place the pair is spelled out.
export type Api = "rest" | "scim";

// The command-map shape of one endpoint: `deel <words> <positionals> [selectors] [scopes]`.
export type CommandForm = {
  positionals: { label: string; param: string }[]; // path params typed as arguments, in order
  scopes: { flag: string; label: string; param: string; in?: "query" }[]; // params typed as `--flag <value>`: a path param, or a query param the map names
  selectors: FormSelector[]; // fixed flags that pick this endpoint among those sharing the words
};

export type FormSelector = {
  flag: string; // e.g. "worker-type", "as", "bulk"
  value?: string; // e.g. "eor"; absent for a switch such as --bulk
  optional?: true; // written [--worker-type eor]: the only endpoint with these words, so the flag may be left out
};

export type VersionInfo = {
  version: string;
  beta_until: string | null;
  sunset_at: string | null;
};

export type Manifest = {
  apiTitle: string;
  descriptors: Descriptor[];
};

export type GeneratedManifest = {
  generator: string;
  descriptors: Descriptor[];
};
