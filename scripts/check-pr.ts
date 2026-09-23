// Validates a pull request against this repo's PR requirements. One source of truth for:
//   - CI:     .github/workflows/pr.yaml (validate-pr job) — inputs arrive via PR_* env vars
//   - /ship:  pre-flights the PR body it is about to submit, so a format miss never reaches CI
//
// Rules are deliberately fork-aware. The repo is public: external contributors cannot add labels,
// so the type-label rule is an error for Deel branches but only a notice/warning for fork PRs.
// Quality rules (description, how it was tested, tests for bug/enhancement PRs) apply to everyone.
// Bot PRs (dependabot) are skipped.
//
// Usage (local pre-flight):
//   node scripts/check-pr.ts --title "Add ..." --body-file /tmp/body.md --labels bug,ai-assisted \
//                            --files <(git diff --name-only origin/dev...HEAD)
// Usage (CI): PR_TITLE, PR_BODY, PR_LABELS (JSON array or comma list), PR_AUTHOR, PR_IS_FORK, PR_BASE
//             env vars, plus --files <path> with one changed file per line.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type PrInput = {
  title: string;
  body: string;
  labels: string[];
  author: string;
  isFork: boolean;
  base: string;
  files: string[];
};

export type PrResult = {
  errors: string[];
  warnings: string[];
  notices: string[];
};

export const TYPE_LABELS = ["bug", "enhancement", "refactor", "documentation", "chore"] as const;
export const GENERATED_MANIFEST = "src/manifest.generated.ts";

const TEST_FILE = /(^|\/)test\/|\.test\.|\.spec\./;
const HOW_I_TESTED = /^\s*(?:\*\*)?\s*(?:#{2,6}\s*)?How I Tested\s*:?\s*(?:\*\*)?\s*:?\s*(.*)$/im;
const LABEL_ONLY_LINE = /^\s*\*\*[^*\n]+:\s*\*\*\s*$/;
const HEADING_LINE = /^\s*#{1,6}\s+/;

/** Text of the `## <heading>` section, up to the next `## ` heading (sub-headings `###` stay inside). */
export function section(body: string, heading: string): string | null {
  const start = new RegExp(`^\\s*##\\s*${heading}\\s*$`, "im").exec(body);
  if (!start) return null;
  const rest = body.slice(start.index + start[0].length);
  const next = /^\s*##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Drops HTML comments/tags, markdown bullets and label-only / heading-only lines. */
function stripMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .filter((line) => !LABEL_ONLY_LINE.test(line) && !HEADING_LINE.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join("\n");
}

function visibleLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** Everything after the "How I Tested" label inside the Testing section, until the next
 * bold label line (e.g. **Evidence/Proof:**) or sub-heading. */
function howITested(testingSection: string): string {
  const match = HOW_I_TESTED.exec(testingSection);
  if (!match) return "";
  const inline = match[1] ?? "";
  const after = testingSection.slice(match.index + match[0].length);
  const lines: string[] = [];
  for (const line of after.split("\n")) {
    if (LABEL_ONLY_LINE.test(line) || HEADING_LINE.test(line)) break;
    lines.push(line);
  }
  return stripMarkup([inline, ...lines].join("\n"));
}

export function validate(pr: PrInput): PrResult {
  const result: PrResult = { errors: [], warnings: [], notices: [] };
  const who = pr.isFork ? "fork" : "Deel branch";

  if (/\[bot\]$/.test(pr.author)) {
    result.notices.push(`author ${pr.author} is a bot — PR-body checks skipped`);
    return result;
  }

  const body = pr.body.replace(/\r\n?/g, "\n");

  // Quality rules — everyone.
  const description = section(body, "Description");
  if (description === null || stripMarkup(description).length < 10) {
    result.errors.push(
      "## Description must contain at least 10 characters of real text (HTML comments don't count)",
    );
  }

  const testing = section(body, "Testing");
  if (testing === null || visibleLength(howITested(testing)) < 10) {
    result.errors.push(
      "## Testing must contain a **How I Tested:** entry with at least 10 characters saying what you ran",
    );
  }

  const typeLabels = pr.labels.filter((l) => (TYPE_LABELS as readonly string[]).includes(l));
  const type = typeLabels[0];
  if (typeLabels.length > 1) {
    result.warnings.push(`more than one type label (${typeLabels.join(", ")}) — keep exactly one`);
  }
  if ((type === "bug" || type === "enhancement") && !pr.files.some((f) => TEST_FILE.test(f))) {
    result.errors.push(
      `a ${type} PR must add or update a test (nothing under test/ or matching *.test.* in the diff)`,
    );
  }

  // Process rules — errors for Deel branches, softened for forks.
  const process_ = (message: string, forkMessage: string): void => {
    if (pr.isFork) result.warnings.push(forkMessage);
    else result.errors.push(message);
  };

  if (!type) {
    process_(
      `add exactly one type label: ${TYPE_LABELS.join(", ")}`,
      `no type label yet — a maintainer adds one of ${TYPE_LABELS.join(", ")} during triage`,
    );
  }

  if (pr.files.includes(GENERATED_MANIFEST) && !pr.labels.includes("script-generated")) {
    process_(
      `${GENERATED_MANIFEST} changed: regenerate it with the deel-cli-extractor skill (never hand-edit) and label the PR script-generated`,
      `${GENERATED_MANIFEST} changed on a ${who} PR — a maintainer must confirm it came from the extractor, not a hand edit`,
    );
  }

  if (pr.base !== "dev") {
    result.warnings.push(
      `base branch is "${pr.base}" — dev is the only release line; make sure a non-dev base is intentional (stacked PR?)`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      return (JSON.parse(trimmed) as unknown[]).map(String);
    } catch {
      // fall through to the comma-separated form
    }
  }
  return trimmed
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

function readLines(path: string | undefined, envValue: string | undefined): string[] {
  const raw = path ? readFileSync(path, "utf8") : envValue ?? "";
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const bodyFile = arg("--body-file");
  const input: PrInput = {
    title: arg("--title") ?? env.PR_TITLE ?? "",
    body: bodyFile ? readFileSync(bodyFile, "utf8") : env.PR_BODY ?? "",
    labels: parseLabels(arg("--labels") ?? env.PR_LABELS),
    author: arg("--author") ?? env.PR_AUTHOR ?? "",
    isFork: process.argv.includes("--fork") || env.PR_IS_FORK === "true",
    base: arg("--base") ?? env.PR_BASE ?? "dev",
    files: readLines(arg("--files"), env.PR_FILES),
  };

  const { errors, warnings, notices } = validate(input);
  const ci = env.GITHUB_ACTIONS === "true";
  const line = (level: "error" | "warning" | "notice", msg: string): string =>
    ci ? `::${level}::${msg}` : `[check-pr] ${level}: ${msg}`;

  for (const n of notices) process.stdout.write(line("notice", n) + "\n");
  for (const w of warnings) process.stdout.write(line("warning", w) + "\n");
  for (const e of errors) process.stdout.write(line("error", e) + "\n");

  if (errors.length > 0) {
    process.stdout.write(`\n[check-pr] ${errors.length} requirement(s) not met. PR template: .github/pull_request_template.md\n`);
    process.exit(1);
  }
  process.stdout.write("[check-pr] OK — PR meets the repository requirements.\n");
}
