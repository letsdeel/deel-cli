// Builds tiny, correctly signed thin Mach-O files for the signing tests. Not a real executable: just
// a header, one LC_CODE_SIGNATURE and padding, followed by an ad-hoc SuperBlob whose CodeDirectory
// carries valid page hashes plus special slots (1 = absent -> zero hash, 2 = requirements blob).
import { createHash } from "node:crypto";

export const PAGE_SHIFT = 12;
export const PAGE = 2 ** PAGE_SHIFT;

const HASH_SIZE = 32;
const SPECIAL_SLOTS = 2;
const CD_FIXED = 88;

export function signedBinary({
  pages = 3,
  arch = "arm64",
  trailing = 0,
  seed = 31,
}: { pages?: number; arch?: "arm64" | "x86_64"; trailing?: number; seed?: number } = {}): Buffer {
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

  const hashOffset = CD_FIXED + SPECIAL_SLOTS * HASH_SIZE;
  const cdLength = hashOffset + pages * HASH_SIZE;
  const cd = Buffer.alloc(cdLength);
  cd.writeUInt32BE(0xfade0c02, 0); // CSMAGIC_CODEDIRECTORY
  cd.writeUInt32BE(cdLength, 4);
  cd.writeUInt32BE(0x20400, 8); // version
  cd.writeUInt32BE(0x2, 12); // flags: adhoc
  cd.writeUInt32BE(hashOffset, 16);
  cd.writeUInt32BE(SPECIAL_SLOTS, 24);
  cd.writeUInt32BE(pages, 28); // nCodeSlots
  cd.writeUInt32BE(codeLimit, 32);
  cd.writeUInt8(HASH_SIZE, 36);
  cd.writeUInt8(2, 37); // SHA-256
  cd.writeUInt8(PAGE_SHIFT, 39);
  // special slot 1 (info.plist) is absent -> zero hash (already zeros); slot 2 = requirements
  createHash("sha256").update(requirements).digest().copy(cd, hashOffset - 2 * HASH_SIZE);

  const cdOffsetInBlob = 12 + 2 * 8;
  const reqOffsetInBlob = cdOffsetInBlob + cdLength;
  const blobLength = reqOffsetInBlob + requirements.length;
  const blob = Buffer.alloc(blobLength);
  blob.writeUInt32BE(0xfade0cc0, 0); // CSMAGIC_EMBEDDED_SIGNATURE
  blob.writeUInt32BE(blobLength, 4);
  blob.writeUInt32BE(2, 8); // two blobs
  blob.writeUInt32BE(0, 12); // CSSLOT_CODEDIRECTORY
  blob.writeUInt32BE(cdOffsetInBlob, 16);
  blob.writeUInt32BE(2, 20); // requirements slot
  blob.writeUInt32BE(reqOffsetInBlob, 24);

  code.writeUInt32LE(codeLimit, 40); // dataoff: signature starts right after the code
  code.writeUInt32LE(blobLength, 44); // datasize
  for (let page = 0; page < pages; page++) {
    createHash("sha256")
      .update(code.subarray(page * PAGE, (page + 1) * PAGE))
      .digest()
      .copy(cd, hashOffset + page * HASH_SIZE);
  }
  cd.copy(blob, cdOffsetInBlob);
  requirements.copy(blob, reqOffsetInBlob);
  return Buffer.concat([code, blob, Buffer.alloc(trailing, 0xab)]);
}

/** Offset of the requirements blob inside a file built by signedBinary(). */
export function requirementsOffset(file: Buffer): number {
  return file.indexOf(Buffer.from([0xfa, 0xde, 0x0c, 0x01]));
}
