// Preloaded with --import: queues more output than a pipe holds before main.ts runs.
process.stdout.write("x".repeat(Number(process.env.FLOOD_BYTES)) + "\n");
