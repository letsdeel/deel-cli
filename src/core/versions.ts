// API version selection: which X-Version / X-Beta a request sends, the one-time fallback when a
// beta has graduated or is gone, and the --versions listing.

import type { Descriptor, VersionInfo } from "../types.ts";
import { CliError } from "./errors.ts";

export type VersionFlags = {
  apiVersion?: string; // --version: YYYY-MM-DD, or "none" to send no X-Version
  beta?: boolean;
};

// What a request sends: `version` undefined means no X-Version header.
export type VersionChoice = { version?: string; beta: boolean };

export const API_VERSION_NONE = "none";

// API error codes returned before any service runs, so a retry is always safe.
export const BETA_ERROR = {
  graduated: "INVALID_VERSION_BETA", // X-Beta sent for a version that is now stable
  noBeta: "NO_BETA_VERSION", // X-Beta sent and nothing is in beta
  required: "BETA_ACCESS_REQUIRED", // a beta version requested without X-Beta
} as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isBetaAt(entry: VersionInfo, now: number): boolean {
  return entry.beta_until !== null && new Date(entry.beta_until).getTime() > now;
}

// `versions` is oldest first, so the newest match is the last one.
export function newestBeta(versions: VersionInfo[], now: number): string | undefined {
  return versions.filter((entry) => isBetaAt(entry, now)).at(-1)?.version;
}

export function newestStable(versions: VersionInfo[], now: number): string | undefined {
  return versions.filter((entry) => !isBetaAt(entry, now)).at(-1)?.version;
}

function commandName(descriptor: Descriptor): string {
  return `deel ${descriptor.command.join(" ")}`;
}

function noVersionData(descriptor: Descriptor, flag: string): CliError {
  return new CliError(
    "usage.versions",
    `${flag} needs the list of API versions, which '${commandName(descriptor)}' does not carry.`,
    descriptor.version
      ? `This command calls version ${descriptor.version}; pick another one with --version <YYYY-MM-DD>.`
      : "Pick a version with --version <YYYY-MM-DD>.",
  );
}

export function chooseVersion(descriptor: Descriptor, flags: VersionFlags, now: number, warn: (line: string) => void): VersionChoice {
  const versions = descriptor.versions;
  const requested = flags.apiVersion?.trim();

  if (requested !== undefined) {
    if (requested === API_VERSION_NONE) {
      if (flags.beta) throw new CliError("usage.version", "--beta cannot be combined with --version none.", "Drop one of them.");
      return { beta: false };
    }
    if (!isValidDate(requested)) {
      throw new CliError("usage.version", `--version expects a date (YYYY-MM-DD) or "none", got "${requested}".`);
    }
    const known = versions?.find((entry) => entry.version === requested);
    if (versions && !known) {
      warn(`warning: ${requested} is not a known version of '${commandName(descriptor)}' (known: ${versions.map((entry) => entry.version).join(", ") || "none"}); sending it anyway.\n`);
    }
    // A version the CLI knows to be in beta needs X-Beta, or the API refuses it.
    return { version: requested, beta: Boolean(flags.beta) || (known !== undefined && isBetaAt(known, now)) };
  }

  if (flags.beta) {
    if (!versions) throw noVersionData(descriptor, "--beta");
    const beta = newestBeta(versions, now);
    if (!beta) {
      throw new CliError(
        "usage.beta",
        `'${commandName(descriptor)}' has no version in beta.`,
        `Run it without --beta, or see '${commandName(descriptor)} --versions'.`,
      );
    }
    return { version: beta, beta: true };
  }

  return { version: descriptor.version, beta: Boolean(descriptor.beta) };
}

// After a request sent X-Beta: the one retry the response calls for, if any. INVALID_VERSION_BETA -> same
// version without X-Beta; NO_BETA_VERSION -> the newest stable version without X-Beta.
export function betaFallback(sent: VersionChoice, errorCode: string | undefined, versions: VersionInfo[] | undefined, now: number): { choice: VersionChoice; reason: string } | undefined {
  if (!sent.beta) return undefined;
  if (errorCode === BETA_ERROR.graduated) {
    return { choice: { version: sent.version, beta: false }, reason: `${sent.version ?? "the requested version"} is no longer in beta` };
  }
  if (errorCode === BETA_ERROR.noBeta) {
    const stable = versions ? newestStable(versions, now) : undefined;
    if (!stable) return undefined;
    return { choice: { version: stable, beta: false }, reason: `nothing is in beta; using the newest stable version ${stable}` };
  }
  return undefined;
}

export const BETA_ACCESS_HINT = "This version is in beta: add --beta (or pick a stable version with --version <YYYY-MM-DD>; see --versions).";


export type VersionRow = VersionInfo & { beta: boolean; default: boolean };

export type VersionListing = {
  command: string;
  version: string | null; // what the command sends without --version / --beta
  beta: boolean;
  versions: VersionRow[];
};

export function versionListing(descriptor: Descriptor, now: number): VersionListing {
  if (!descriptor.versions) throw noVersionData(descriptor, "--versions");
  return {
    command: descriptor.command.join(" "),
    version: descriptor.version ?? null,
    beta: Boolean(descriptor.beta),
    versions: descriptor.versions.map((entry) => ({
      version: entry.version,
      beta: isBetaAt(entry, now),
      beta_until: entry.beta_until,
      sunset_at: entry.sunset_at,
      default: entry.version === descriptor.version,
    })),
  };
}

export function versionTable(listing: VersionListing): string {
  const header = ["VERSION", "STATUS", "BETA UNTIL", "SUNSET", ""];
  const rows = listing.versions.map((row) => [row.version, row.beta ? "beta" : "stable", row.beta_until ?? "-", row.sunset_at ?? "-", row.default ? "(default)" : ""]);
  const widths = header.map((_, column) => Math.max(...[header, ...rows].map((cells) => cells[column].length)));
  const format = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd() + "\n";
  return `${listing.command}\n\n` + [header, ...rows].map(format).join("");
}
