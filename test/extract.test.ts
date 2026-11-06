import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFields, bodyFrom, responseFrom, normalizeSchema } from "../.claude/skills/deel-cli-extractor/extract.ts";

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
