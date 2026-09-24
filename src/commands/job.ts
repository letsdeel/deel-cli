// `deel job status <id>[,<id>]` and `deel job list` — inspect async jobs handed
// off by 202 responses from mutating operations.

import { defineCommand } from "citty";
import { resolveToken, requireToken } from "../core/auth.ts";
import { createContext } from "../core/context.ts";
import { envelope, render } from "../core/output.ts";
import { setLoggingEnabled, setLogBodiesEnabled } from "../core/logging.ts";
import { fetchJob } from "../core/jobs.ts";
import { CliError } from "../core/errors.ts";
import { HEADER } from "../core/constants.ts";
import { commonArgs, configFrom, outputOpts } from "./shared.ts";
import type { Args } from "./shared.ts";

export const jobCommand = defineCommand({
  meta: { name: "job", description: "Async job status" },
  subCommands: {
    status: defineCommand({
      meta: { name: "status", description: "Poll job status: deel job status <id>[,<id>]" },
      args: { id: { type: "positional", required: false, description: "Job id(s), comma-separated" }, ...commonArgs },
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        setLogBodiesEnabled(args["log-bodies"] === true);
        const config = configFrom(args, cittyCtx.rawArgs);
        const token = requireToken(resolveToken({ tokenStdin: Boolean(args["token-stdin"]), env: config.env }));
        const ctx = createContext({ config, token });
        const jobIds = String(args.id ?? "").split(",").map((id) => id.trim()).filter(Boolean);
        if (jobIds.length === 0) throw new CliError("usage.job", "Usage: deel job status <id>[,<id>]");
        const jobs = await Promise.all(jobIds.map(async (id) => ({ job_id: id, ...(await fetchJob(ctx.http, config.baseUrl, id)) })));
        await render(ctx.io, envelope(jobs.length === 1 ? jobs[0] : jobs), outputOpts(args));
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List recent jobs" },
      args: commonArgs,
      async run(cittyCtx) {
        const args = cittyCtx.args as Args;
        setLoggingEnabled(args.log !== false);
        setLogBodiesEnabled(args["log-bodies"] === true);
        const config = configFrom(args, cittyCtx.rawArgs);
        const token = requireToken(resolveToken({ tokenStdin: Boolean(args["token-stdin"]), env: config.env }));
        const ctx = createContext({ config, token });
        const response = await ctx.http({
          method: "GET",
          url: `${config.baseUrl}/jobs`,
          headers: { [HEADER.accept]: "application/json" },
          retryable: true,
          meta: { command: "job list" },
        });
        await render(ctx.io, envelope((response.json as any)?.data ?? []), outputOpts(args));
      },
    }),
  },
});
