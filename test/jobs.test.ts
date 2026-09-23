import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJob } from "../src/core/jobs.ts";
import type { Transport, HttpResponse } from "../src/core/http.ts";

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, text: "", json: body });

test("fetchJob maps 404 and other errors", async () => {
  const notFound: Transport = async () => ({ status: 404, headers: {}, text: "", json: {} });
  await assert.rejects(() => fetchJob(notFound, "http://x", "job_1"), /not found/);
  const serverError: Transport = async () => ({ status: 500, headers: {}, text: "", json: {} });
  await assert.rejects(() => fetchJob(serverError, "http://x", "job_1"), /lookup failed/);
});

test("fetchJob returns the overall status and its per-item results", async () => {
  const http: Transport = async () =>
    ok({ data: { job_id: "job_1", status: "FAILED", items: [{ external_id: "a", status: "FAILED", error: { code: "x" } }] } });
  const job = await fetchJob(http, "http://x", "job_1");
  assert.equal(job.status, "FAILED");
  assert.deepEqual(job.items, [{ external_id: "a", status: "FAILED", error: { code: "x" } }]);
});

test("fetchJob defaults items to an empty array when the API omits them", async () => {
  const http: Transport = async () => ok({ data: { status: "PENDING" } });
  const job = await fetchJob(http, "http://x", "job_1");
  assert.deepEqual(job.items, []);
});
