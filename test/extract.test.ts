import { test } from "node:test";
import assert from "node:assert/strict";
import { extract, splitFields, bodyFrom, responseFrom } from "../.claude/skills/deel-cli-extractor/extract.ts";

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

test("splitFields keeps the item fields of an array of objects, so help can show how to build an entry", () => {
  const { textProps } = splitFields({
    type: "object",
    properties: {
      support_resources: {
        type: "array",
        items: { type: "object", required: ["name", "url"], properties: { name: { type: "string" }, url: { type: "string" } } },
      },
      what_it_syncs: { type: "array", items: { type: "string" } },
    },
  });

  assert.deepEqual(
    textProps.find((field) => field.name === "support_resources")!.properties?.map((field) => `${field.name}:${field.required}`),
    ["name:true", "url:true"],
  );
  assert.equal(textProps.find((field) => field.name === "what_it_syncs")!.properties, undefined);
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

test("extract copies a map entry's confirm text into its descriptor and only there", () => {
  const spec = { paths: { "/things/{id}": { post: { summary: "Drop" }, get: { summary: "Get" } } } };
  const { manifest, hardErrors } = extract(spec, [
    { command: "things drop", method: "POST", path: "/things/{id}", confirm: "Drop {id}?" },
    { command: "things get", method: "GET", path: "/things/{id}" },
  ]);
  assert.deepEqual(hardErrors, []);
  const byName = Object.fromEntries(manifest.descriptors.map((d) => [d.command.join(" "), d]));
  assert.equal(byName["things drop"].confirm, "Drop {id}?");
  assert.ok(!("confirm" in byName["things get"]));
});

test("responseFrom carries nullable fields, including nested ones, and only those", () => {
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
                  required: ["id", "owner"],
                  properties: {
                    id: { type: "string" },
                    owner: { type: "object", nullable: true, required: ["name"], properties: { name: { type: "string", nullable: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const id = responseFields.find((field) => field.name === "id");
  const owner = responseFields.find((field) => field.name === "owner");
  assert.equal("nullable" in id!, false);
  assert.equal(owner!.nullable, true);
  assert.equal(owner!.required, true);
  assert.equal(owner!.properties![0].nullable, true);
});
