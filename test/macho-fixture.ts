// Builds tiny, correctly signed thin Mach-O files for the signing tests. Not a real executable: just
// a header, one LC_CODE_SIGNATURE and padding, followed by an ad-hoc SuperBlob whose CodeDirectory
// carries valid page hashes plus special slots (1 = absent -> zero hash, 2 = requirements blob).
import { createHash } from "node:crypto";

export const PAGE_SHIFT = 12;
export const PAGE = 2 ** PAGE_SHIFT;

export type HashType = 1 | 2 | 3 | 4 | 5; // sha1, sha256, sha256 truncated to 20 bytes, sha384, sha512

const HASHES: Record<HashType, { name: string; size: number }> = {
  1: { name: "sha1", size: 20 },
  2: { name: "sha256", size: 32 },
  3: { name: "sha256", size: 20 },
  4: { name: "sha384", size: 48 },
  5: { name: "sha512", size: 64 },
};

const SPECIAL_SLOTS = 2;
const CD_FIXED = 88;
const CODE_DIRECTORY_MAGIC = Buffer.from([0xfa, 0xde, 0x0c, 0x02]);

export interface FixtureOptions {
  pages?: number;
  arch?: "arm64" | "x86_64";
  /** Bytes appended after the signature. */
  trailing?: number;
  seed?: number;
  /** Hash used by the primary CodeDirectory (default sha256). */
  hashType?: HashType;
  /** CodeDirectory page size as a power of two; 0 = a single page covering all the code. */
  pageShift?: number;
  /** Store codeLimit in the 64-bit field and leave the 32-bit one at zero. */
  codeLimit64?: boolean;
  /** Add an alternate CodeDirectory (slot 0x1000) that uses this hash. */
  alternate?: HashType;
}

interface DirectoryShape {
  hashType: HashType;
  pageShift: number;
  codeLimit64: boolean;
}

function pagesCovered(codeLimit: number, pageShift: number): number {
  return pageShift === 0 ? 1 : Math.ceil(codeLimit / 2 ** pageShift);
}

function directoryLength(codeLimit: number, { hashType, pageShift }: DirectoryShape): number {
  const { size } = HASHES[hashType];
  return CD_FIXED + SPECIAL_SLOTS * size + pagesCovered(codeLimit, pageShift) * size;
}

function digest(hashType: HashType, data: Buffer): Buffer {
  const { name, size } = HASHES[hashType];
  return createHash(name).update(data).digest().subarray(0, size);
}

function buildDirectory(code: Buffer, requirements: Buffer, shape: DirectoryShape): Buffer {
  const { hashType, pageShift, codeLimit64 } = shape;
  const { size } = HASHES[hashType];
  const codeLimit = code.length;
  const slots = pagesCovered(codeLimit, pageShift);
  const pageSize = pageShift === 0 ? codeLimit : 2 ** pageShift;
  const hashOffset = CD_FIXED + SPECIAL_SLOTS * size;

  const cd = Buffer.alloc(directoryLength(codeLimit, shape));
  cd.writeUInt32BE(0xfade0c02, 0); // CSMAGIC_CODEDIRECTORY
  cd.writeUInt32BE(cd.length, 4);
  cd.writeUInt32BE(0x20400, 8); // version
  cd.writeUInt32BE(0x2, 12); // flags: adhoc
  cd.writeUInt32BE(hashOffset, 16);
  cd.writeUInt32BE(SPECIAL_SLOTS, 24);
  cd.writeUInt32BE(slots, 28); // nCodeSlots
  cd.writeUInt32BE(codeLimit64 ? 0 : codeLimit, 32);
  cd.writeUInt8(size, 36);
  cd.writeUInt8(hashType, 37);
  cd.writeUInt8(pageShift, 39);
  if (codeLimit64) cd.writeBigUInt64BE(BigInt(codeLimit), 56);
  // special slot 1 (info.plist) is absent -> zero hash (already zeros); slot 2 = requirements
  digest(hashType, requirements).copy(cd, hashOffset - 2 * size);
  for (let page = 0; page < slots; page++) {
    digest(hashType, code.subarray(page * pageSize, Math.min((page + 1) * pageSize, codeLimit))).copy(
      cd,
      hashOffset + page * size,
    );
  }
  return cd;
}

export function signedBinary({
  pages = 3,
  arch = "arm64",
  trailing = 0,
  seed = 31,
  hashType = 2,
  pageShift = PAGE_SHIFT,
  codeLimit64 = false,
  alternate,
}: FixtureOptions = {}): Buffer {
  const codeLimit = pages * PAGE;
  const code = Buffer.alloc(codeLimit);
  code.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  code.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4); // cpu type
  code.writeUInt32LE(1, 16); // ncmds
  code.writeUInt32LE(16, 20); // sizeofcmds
  code.writeUInt32LE(0x1d, 32); // LC_CODE_SIGNATURE
  code.writeUInt32LE(16, 36); // cmdsize
  for (let i = 128; i < codeLimit; i++) code[i] = (i * seed) & 0xff; // non-trivial page contents

  const requirements = Buffer.alloc(12);
  requirements.writeUInt32BE(0xfade0c01, 0); // CSMAGIC_REQUIREMENTS
  requirements.writeUInt32BE(12, 4);

  const shapes: Array<{ slotType: number; shape: DirectoryShape }> = [
    { slotType: 0, shape: { hashType, pageShift, codeLimit64 } },
  ];
  if (alternate) shapes.push({ slotType: 0x1000, shape: { hashType: alternate, pageShift, codeLimit64 } });

  const entries = shapes.length + 1; // the CodeDirectories and the requirements blob
  const lengths = shapes.map(({ shape }) => directoryLength(codeLimit, shape));
  const offsets: number[] = [];
  let cursor = 12 + entries * 8;
  for (const length of lengths) {
    offsets.push(cursor);
    cursor += length;
  }
  const requirementsAt = cursor;
  const blobLength = requirementsAt + requirements.length;

  code.writeUInt32LE(codeLimit, 40); // dataoff: the signature starts right after the code
  code.writeUInt32LE(blobLength, 44); // datasize

  const blob = Buffer.alloc(blobLength);
  blob.writeUInt32BE(0xfade0cc0, 0); // CSMAGIC_EMBEDDED_SIGNATURE
  blob.writeUInt32BE(blobLength, 4);
  blob.writeUInt32BE(entries, 8);
  shapes.forEach(({ slotType, shape }, i) => {
    blob.writeUInt32BE(slotType, 12 + i * 8);
    blob.writeUInt32BE(offsets[i], 16 + i * 8);
    buildDirectory(code, requirements, shape).copy(blob, offsets[i]);
  });
  blob.writeUInt32BE(2, 12 + shapes.length * 8); // requirements slot
  blob.writeUInt32BE(requirementsAt, 16 + shapes.length * 8);
  requirements.copy(blob, requirementsAt);

  return Buffer.concat([code, blob, Buffer.alloc(trailing, 0xab)]);
}

/** Offset of the requirements blob inside a file built by signedBinary(). */
export function requirementsOffset(file: Buffer): number {
  return file.indexOf(Buffer.from([0xfa, 0xde, 0x0c, 0x01]));
}

/** Offsets of every CodeDirectory (primary first) inside a file built by signedBinary(). */
export function codeDirectoryOffsets(file: Buffer): number[] {
  const found: number[] = [];
  for (let at = file.indexOf(CODE_DIRECTORY_MAGIC); at !== -1; at = file.indexOf(CODE_DIRECTORY_MAGIC, at + 1)) found.push(at);
  return found;
}

/** Offset of the SuperBlob (where the signature starts). */
export function signatureOffset(file: Buffer): number {
  return file.readUInt32LE(40);
}

/** Field offsets inside a CodeDirectory, for tests that corrupt one field at a time. */
export const CD = { hashOffset: 16, specialSlots: 24, codeSlots: 28, hashSize: 36, hashType: 37 } as const;
