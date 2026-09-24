import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const SERVICE = "deel-cli";

export type CredentialStore = {
  available: () => boolean;
  get: (account: string) => string | null;
  set: (account: string, token: string) => boolean;
  remove: (account: string) => boolean;
};

function toolExists(cmd: string): boolean {
  const result = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !(result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT");
}

// Quoting rules for security(1)'s interactive-mode parser: backslash-escape backslashes and double quotes.
function quoteForSecurity(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const macStore: CredentialStore = {
  available: () => true,
  get(account) {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.replace(/\r?\n$/, "") : null;
  },
  set(account, token) {
    // Passed via security's interactive mode (-i) over stdin instead of "-w <token>" as an argv entry,
    // so the token never appears in `ps` output while the command runs.
    const command = `add-generic-password -U -s ${quoteForSecurity(SERVICE)} -a ${quoteForSecurity(account)} -w ${quoteForSecurity(token)}\n`;
    const r = spawnSync("security", ["-i"], { input: command, encoding: "utf8" });
    return r.status === 0 && !/^security:/m.test(r.stderr ?? "");
  },
  remove(account) {
    const r = spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
    return r.status === 0;
  },
};

const linuxStore: CredentialStore = {
  available: () => toolExists("secret-tool"),
  get(account) {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.replace(/\r?\n$/, "") || null : null;
  },
  set(account, token) {
    const r = spawnSync("secret-tool", ["store", "--label=Deel CLI", "service", SERVICE, "account", account], { input: token, stdio: ["pipe", "ignore", "ignore"] });
    return r.status === 0;
  },
  remove(account) {
    const r = spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { stdio: "ignore" });
    return r.status === 0;
  },
};

const noneStore: CredentialStore = {
  available: () => false,
  get: () => null,
  set: () => false,
  remove: () => false,
};

export function credentialStore(): CredentialStore {
  const os = platform();
  if (os === "darwin") return macStore;
  if (os === "linux") return linuxStore;
  return noneStore;
}
