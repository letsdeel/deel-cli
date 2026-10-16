// Verifies the code signature embedded in a thin 64-bit Mach-O binary: a signature is present and is
// the last thing in the file, its CodeDirectory covers exactly the bytes in front of it, and every
// code-page and special-slot hash matches. Runs on any OS, so it can check macOS binaries built on Linux.
//
// Usage: node scripts/check-macho-signature.ts [--arch arm64|x86_64] <binary> [<binary>...]
// Without --arch the expected CPU is inferred from a file name containing "arm64" or "x64".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const MH_MAGIC_64 = 0xfeedfacf; // read little-endian: thin 64-bit Mach-O (arm64, x86_64)
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_ALTERNATE_FIRST = 0x1000;
const CSSLOT_ALTERNATE_LAST = 0x1004;

const HASH_ALGORITHMS: Record<number, { name: string; length: number }> = {
  1: { name: "sha1", length: 20 },
  2: { name: "sha256", length: 32 },
  3: { name: "sha256", length: 20 }, // SHA-256 truncated to 20 bytes
  4: { name: "sha384", length: 48 },
  5: { name: "sha512", length: 64 },
};

export interface SignatureReport {
  errors: string[];
  /** Human-readable one-liner for the passing case, e.g. "arm64, adhoc, 15751 pages". */
  summary: string;
}

export type Arch = "arm64" | "x86_64";
const CPU_TYPES: Record<Arch, number> = { arm64: 0x0100000c, x86_64: 0x01000007 };

/** Pure: takes the file bytes so the test suite can feed it synthetic binaries. */
export function verifyMachoSignature(file: Buffer, options: { arch?: Arch } = {}): SignatureReport {
  try {
    return verify(file, options);
  } catch (err) {
    // Out-of-range reads on a truncated or corrupt file.
    if (err instanceof RangeError) return { errors: [`malformed Mach-O or code signature (${err.message})`], summary: "" };
    throw err;
  }
}

function verify(file: Buffer, options: { arch?: Arch }): SignatureReport {
  const fail = (message: string): SignatureReport => ({ errors: [message], summary: "" });

  if (file.length < 32 || file.readUInt32LE(0) !== MH_MAGIC_64) {
    return fail("not a thin 64-bit Mach-O file (fat binaries are not produced by this build)");
  }
  const cpuType = file.readUInt32LE(4);
  if (options.arch && cpuType !== CPU_TYPES[options.arch]) {
    return fail(`expected ${options.arch} but the Mach-O header says cpu type 0x${cpuType.toString(16)}`);
  }
  const ncmds = file.readUInt32LE(16);

  let signature: { offset: number; size: number } | undefined;
  let cursor = 32;
  for (let i = 0; i < ncmds; i++) {
    if (cursor + 8 > file.length) return fail("truncated Mach-O load commands");
    const cmd = file.readUInt32LE(cursor);
    const cmdSize = file.readUInt32LE(cursor + 4);
    if (cmdSize < 8) return fail("corrupt Mach-O load command");
    if (cmd === LC_CODE_SIGNATURE) {
      if (cmdSize < 16) return fail("corrupt LC_CODE_SIGNATURE load command");
      signature = { offset: file.readUInt32LE(cursor + 8), size: file.readUInt32LE(cursor + 12) };
    }
    cursor += cmdSize;
  }
  if (!signature) return fail("no LC_CODE_SIGNATURE load command — the binary is unsigned");
  if (signature.offset + signature.size > file.length) {
    return fail("code signature extends past the end of the file");
  }
  if (signature.offset + signature.size < file.length) {
    return fail(
      `${file.length - signature.offset - signature.size} bytes follow the code signature — the file was modified after signing`,
    );
  }

  const blob = file.subarray(signature.offset, signature.offset + signature.size);
  if (blob.length < 12 || blob.readUInt32BE(0) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    return fail("code signature is not an embedded SuperBlob");
  }
  const count = blob.readUInt32BE(8);

  const directories: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 8;
    if (entry + 8 > blob.length) return fail("truncated SuperBlob index");
    const type = blob.readUInt32BE(entry);
    const offset = blob.readUInt32BE(entry + 4);
    const isDirectory =
      type === CSSLOT_CODEDIRECTORY || (type >= CSSLOT_ALTERNATE_FIRST && type <= CSSLOT_ALTERNATE_LAST);
    if (!isDirectory) continue;
    if (offset + 8 > blob.length || blob.readUInt32BE(offset) !== CSMAGIC_CODEDIRECTORY) {
      return fail("SuperBlob points at a CodeDirectory that is not there");
    }
    directories.push(blob.subarray(offset, offset + blob.readUInt32BE(offset + 4)));
  }
  if (directories.length === 0) return fail("code signature carries no CodeDirectory");

  const errors: string[] = [];
  const pieces: string[] = [];
  for (const dir of directories) {
    if (dir.length < 40) {
      errors.push("CodeDirectory is truncated");
      continue;
    }
    const flags = dir.readUInt32BE(12);
    const specialSlots = dir.readUInt32BE(24);
    const hashOffset = dir.readUInt32BE(16);
    const codeSlots = dir.readUInt32BE(28);
    const codeLimit32 = dir.readUInt32BE(32);
    const hashSize = dir.readUInt8(36);
    const hashType = dir.readUInt8(37);
    const pageShift = dir.readUInt8(39);
    const version = dir.readUInt32BE(8);
    // codeLimit64 exists from version 0x20300 on and is only meaningful when the 32-bit field overflowed.
    const codeLimit =
      version >= 0x20300 && codeLimit32 === 0 && dir.length >= 64 ? Number(dir.readBigUInt64BE(56)) : codeLimit32;

    const algorithm = HASH_ALGORITHMS[hashType];
    if (!algorithm || algorithm.length !== hashSize) {
      errors.push(`CodeDirectory uses an unsupported hash (type ${hashType}, size ${hashSize})`);
      continue;
    }
    const pageSize = pageShift === 0 ? codeLimit : 2 ** pageShift;
    const label = `${algorithm.name} CodeDirectory`;

    // The signature must cover every byte in front of it.
    if (codeLimit !== signature.offset) {
      errors.push(
        `${label} covers ${codeLimit} bytes but the signature starts at ${signature.offset} — the file was modified after signing`,
      );
      continue;
    }
    const expectedSlots = Math.ceil(codeLimit / pageSize);
    if (codeSlots !== expectedSlots) {
      errors.push(`${label} has ${codeSlots} page hashes, expected ${expectedSlots}`);
      continue;
    }
    if (hashOffset + codeSlots * hashSize > dir.length) {
      errors.push(`${label} page hash table runs past the end of the blob`);
      continue;
    }

    // Special slots sit just below the code hashes, counting down: slot i holds the hash of the
    // SuperBlob entry of type i (requirements = 2, entitlements = 5, ...), or zeros when absent.
    if (specialSlots > hashOffset / hashSize) {
      errors.push(`${label} claims ${specialSlots} special slots that do not fit in front of its hash table`);
      continue;
    }
    let badSpecial = 0;
    for (let slot = 1; slot <= specialSlots; slot++) {
      const recorded = dir.subarray(hashOffset - slot * hashSize, hashOffset - (slot - 1) * hashSize);
      const content = blobOfType(blob, count, slot);
      const expected = content
        ? createHash(algorithm.name).update(content).digest().subarray(0, hashSize)
        : Buffer.alloc(hashSize);
      if (!expected.equals(recorded)) badSpecial++;
    }
    if (badSpecial > 0) {
      errors.push(`${label}: ${badSpecial} of ${specialSlots} special-slot hashes (requirements/entitlements) do not match`);
      continue;
    }

    let mismatches = 0;
    let firstBad = -1;
    for (let page = 0; page < codeSlots; page++) {
      const start = page * pageSize;
      const end = Math.min(start + pageSize, codeLimit);
      const actual = createHash(algorithm.name).update(file.subarray(start, end)).digest().subarray(0, hashSize);
      const recorded = dir.subarray(hashOffset + page * hashSize, hashOffset + (page + 1) * hashSize);
      if (!actual.equals(recorded)) {
        mismatches++;
        if (firstBad < 0) firstBad = page;
      }
    }
    if (mismatches > 0) {
      errors.push(`${label}: ${mismatches} of ${codeSlots} page hashes do not match (first at page ${firstBad})`);
      continue;
    }
    pieces.push(`${algorithm.name} ${codeSlots} pages${flags & 0x2 ? ", adhoc" : ""}`);
  }

  const arch = cpuType === 0x0100000c ? "arm64" : cpuType === 0x01000007 ? "x86_64" : `cpu 0x${cpuType.toString(16)}`;
  return { errors, summary: `${arch}, ${pieces.join("; ")}` };
}

/** The bytes of the SuperBlob entry of the given slot type, or undefined when the signature has none. */
function blobOfType(superBlob: Buffer, count: number, type: number): Buffer | undefined {
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 8;
    if (superBlob.readUInt32BE(entry) !== type) continue;
    const offset = superBlob.readUInt32BE(entry + 4);
    return superBlob.subarray(offset, offset + superBlob.readUInt32BE(offset + 4));
  }
  return undefined;
}

function inferArch(path: string): Arch | undefined {
  const name = basename(path);
  if (name.includes("arm64")) return "arm64";
  if (name.includes("x64")) return "x86_64";
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let forcedArch: Arch | undefined;
  if (args[0] === "--arch") {
    const value = args[1];
    if (value !== "arm64" && value !== "x86_64") {
      process.stderr.write("usage: --arch must be arm64 or x86_64\n");
      process.exit(2);
    }
    forcedArch = value;
    args.splice(0, 2);
  }
  const files = args;
  if (files.length === 0) {
    process.stderr.write("usage: node scripts/check-macho-signature.ts [--arch arm64|x86_64] <binary> [<binary>...]\n");
    process.exit(2);
  }
  let failed = false;
  for (const path of files) {
    const { errors, summary } = verifyMachoSignature(readFileSync(path), { arch: forcedArch ?? inferArch(path) });
    if (errors.length > 0) {
      failed = true;
      for (const err of errors) process.stderr.write(`[macho-signature] ${basename(path)}: ${err}\n`);
    } else {
      process.stderr.write(`[macho-signature] ${basename(path)}: OK (${summary})\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}
