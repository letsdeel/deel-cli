// `deel completion <bash|zsh|fish>` — print a shell completion script. The script
// calls back into `deel __complete` (handled in src/cli.ts) on every <TAB>, so
// completions always match the installed version's commands.

import { defineCommand } from "citty";
import type { ArgsDef } from "citty";
import { completionScript, SHELLS } from "../core/completion.ts";
import type { Shell } from "../core/completion.ts";
import { CliError } from "../core/errors.ts";
import { realIO } from "../core/io.ts";

const args: ArgsDef = {
  shell: { type: "positional", required: false, description: `Shell: ${SHELLS.join(" | ")}` },
};

export const completionCommand = defineCommand({
  meta: {
    name: "completion",
    description: "Print a shell completion script: source <(deel completion bash|zsh), or deel completion fish | source",
  },
  args,
  run(cittyCtx) {
    const shell = String(cittyCtx.args.shell ?? "");
    if (!(SHELLS as readonly string[]).includes(shell)) {
      throw new CliError("usage.completion", `Usage: deel completion <${SHELLS.join("|")}>`);
    }
    realIO().out(completionScript(shell as Shell));
  },
});
