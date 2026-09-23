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
  maxItems?: number;
};

export type BodyKind = "none" | "json" | "json-array" | "multipart";

export type Descriptor = {
  command: string[];
  variant?: string;
  method: string;
  path: string;
  summary?: string;
  version?: string;
  async: boolean;
  bodyKind: BodyKind;
  supportsMultipart: boolean;
  bodyWrapper: "data" | "none";
  params: CliParam[];
  bodyProps: CliParam[];
  maxItems?: number;
  fileFields: string[];
  responseKind: "object" | "array" | "none";
  responseFields: CliParam[];
};

export type Manifest = {
  apiTitle: string;
  descriptors: Descriptor[];
};
