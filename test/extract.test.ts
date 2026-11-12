import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFields, bodyFrom, responseFrom, normalizeSchema } from "../.claude/skills/deel-cli-extractor/extract.ts";
import type { CliParam } from "../src/types.ts";

test("splitFields recursively expands nested object schemas into properties", () => {
  const { textProps } = splitFields({
    type: "object",
    required: ["external_id"],
    properties: {
      external_id: { type: "string" },
      request: {
        type: "object",
        required: ["amount"],
        properties: {
          amount: { type: "number" },
          note: { type: "string" },
        },
      },
    },
  });

  const request = textProps.find((field) => field.name === "request");
  assert.ok(request);
  assert.equal(request!.type, "object");
  assert.deepEqual(
    request!.properties?.map((field) => field.name),
    ["amount", "note"],
  );
  assert.equal(request!.properties!.find((field) => field.name === "amount")!.required, true);
});

test("bodyFrom captures array item fields (including nested objects) for a json-array body", () => {
  const { bodyKind, bodyProps } = bodyFrom({
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "array",
            items: {
              type: "object",
              required: ["external_id", "request"],
              properties: {
                external_id: { type: "string" },
                request: {
                  type: "object",
                  properties: { amount: { type: "number" } },
                },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(bodyKind, "json-array");
  const request = bodyProps.find((field) => field.name === "request");
  assert.ok(request);
  assert.deepEqual(
    request!.properties?.map((field) => field.name),
    ["amount"],
  );
});

test("responseFrom expands a response field that is an array of objects into item properties", () => {
  const { responseKind, responseFields } = responseFrom({
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                data: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["status"],
                        properties: {
                          status: { type: "string" },
                          external_id: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(responseKind, "object");
  const items = responseFields.find((field) => field.name === "items");
  assert.ok(items);
  assert.equal(items!.type, "array");
  assert.deepEqual(
    items!.properties?.map((field) => field.name),
    ["status", "external_id"],
  );
  assert.equal(items!.properties!.find((field) => field.name === "status")!.required, true);
});

test("splitFields flags nullable body fields and leaves the rest unflagged", () => {
  const { textProps } = splitFields({
    type: "object",
    properties: {
      note: { type: "string", nullable: true },
      amount: { type: "number", nullable: true },
      external_id: { type: "string" },
    },
  });

  assert.equal(textProps.find((field) => field.name === "note")!.nullable, true);
  assert.equal(textProps.find((field) => field.name === "amount")!.nullable, true);
  assert.equal("nullable" in textProps.find((field) => field.name === "external_id")!, false);
});

test("splitFields flags nullable fields of nested objects", () => {
  const { textProps } = splitFields({
    type: "object",
    properties: {
      address: {
        type: "object",
        properties: {
          line2: { type: "string", nullable: true },
          city: { type: "string" },
        },
      },
    },
  });

  const address = textProps.find((field) => field.name === "address")!;
  assert.equal(address.properties!.find((field) => field.name === "line2")!.nullable, true);
  assert.equal("nullable" in address.properties!.find((field) => field.name === "city")!, false);
});


test("splitFields detects OAS 3.1 nullable: type arrays and oneOf/anyOf with a null member", () => {
  const { textProps } = splitFields({
    type: "object",
    properties: {
      note: { type: ["string", "null"], description: "kept" },
      amount: { type: ["null", "number"] },
      status: { oneOf: [{ type: "string", enum: ["open", "closed"] }, { type: "null" }] },
      count: { anyOf: [{ type: "integer" }, { type: "null" }] },
      plain: { type: "string" },
    },
  });
  const byName = (name: string) => textProps.find((field) => field.name === name)!;

  assert.equal(byName("note").nullable, true);
  assert.equal(byName("note").type, "string");
  assert.equal(byName("note").description, "kept");
  assert.equal(byName("amount").nullable, true);
  assert.equal(byName("amount").type, "number");
  assert.equal(byName("status").nullable, true);
  assert.deepEqual(byName("status").enum, ["open", "closed"]);
  assert.equal(byName("count").type, "integer");
  assert.equal("nullable" in byName("plain"), false);
});

test("normalizeSchema leaves a non-null multi-type union alone and flags nothing", () => {
  const { schema, nullable } = normalizeSchema({ oneOf: [{ type: "string" }, { type: "number" }] });
  assert.equal(nullable, false);
  assert.equal(Array.isArray(schema.oneOf), true);
});

test("responseFrom carries the spec's x-deel-sensitive mark onto a response field, at any depth, and only for the boolean true", () => {
  const { responseFields } = responseFrom({
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                data: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    badge_color_choice: { type: "string", "x-deel-sensitive": true },
                    nullable_mark: { oneOf: [{ type: "string", "x-deel-sensitive": true }, { type: "null" }] },
                    as_text: { type: "string", "x-deel-sensitive": "yes" },
                    as_false: { type: "string", "x-deel-sensitive": false },
                    owner: { type: "object", properties: { nickname: { type: "string", "x-deel-sensitive": true }, title: { type: "string" } } },
                    tags: { type: "array", items: { type: "object", properties: { label: { type: "string", "x-deel-sensitive": true } } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const byName = (fields: CliParam[] | undefined, name: string) => fields!.find((field) => field.name === name)!;
  assert.equal(byName(responseFields, "id").sensitive, undefined);
  assert.equal(byName(responseFields, "badge_color_choice").sensitive, true);
  assert.equal(byName(responseFields, "nullable_mark").sensitive, true);
  assert.equal(byName(responseFields, "as_text").sensitive, undefined);
  assert.equal(byName(responseFields, "as_false").sensitive, undefined);
  assert.equal(byName(byName(responseFields, "owner").properties, "nickname").sensitive, true);
  assert.equal(byName(byName(responseFields, "owner").properties, "title").sensitive, undefined);
  assert.equal(byName(byName(responseFields, "tags").properties, "label").sensitive, true);
});

test("responseFrom adds no sensitive key at all when the spec marks nothing, so an unmarked manifest does not change", () => {
  const { responseFields } = responseFrom({
    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { id: { type: "string" } } } } } } } } },
  });
  assert.deepEqual(responseFields, [{ name: "id", in: "body", type: "string", required: false }]);
});

test("responseFrom marks an array field whose items carry x-deel-sensitive, and an array of objects with one marked property keeps the mark on that property", () => {
  const { responseFields } = responseFrom({
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                data: {
                  type: "object",
                  properties: {
                    nicknames: { type: "array", items: { type: "string", "x-deel-sensitive": true } },
                    codes: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const byName = (name: string) => responseFields.find((field: CliParam) => field.name === name)!;
  assert.equal(byName("nicknames").sensitive, true);
  assert.equal(byName("codes").sensitive, undefined);
});
