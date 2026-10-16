import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMachoSignature } from "../scripts/check-macho-signature.ts";
import { CD, PAGE, codeDirectoryOffsets, requirementsOffset, signatureOffset, signedBinary } from "./macho-fixture.ts";

test("accepts a binary whose CodeDirectory matches its bytes", () => {
  const { errors, summary } = verifyMachoSignature(signedBinary());
  assert.deepEqual(errors, []);
  assert.match(summary, /arm64, sha256 3 pages, adhoc/);
});

test("rejects a byte flipped inside a hashed page", () => {
  const file = signedBinary();
  file[PAGE + 200] ^= 0xff;
  const { errors } = verifyMachoSignature(file);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /1 of 3 page hashes do not match \(first at page 1\)/);
});

test("rejects a payload spliced in before the signature", () => {
  const file = signedBinary();
  // The signature now starts later than the CodeDirectory's codeLimit.
  const grown = Buffer.concat([file.subarray(0, 3 * PAGE), Buffer.alloc(PAGE, 1), file.subarray(3 * PAGE)]);
  grown.writeUInt32LE(4 * PAGE, 40);
  const { errors } = verifyMachoSignature(grown);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /covers 12288 bytes but the signature starts at 16384/);
});

test("rejects bytes appended after the signature", () => {
  const { errors } = verifyMachoSignature(signedBinary({ trailing: 4096 }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /4096 bytes follow the code signature/);
});

test("rejects a tampered requirements blob — special-slot hashes are verified", () => {
  const file = signedBinary();
  file[requirementsOffset(file) + 9] ^= 0xff;
  const { errors } = verifyMachoSignature(file);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /1 of 2 special-slot hashes/);
});

test("rejects an unsigned Mach-O", () => {
  const file = signedBinary();
  file.writeUInt32LE(0x19, 32); // LC_SEGMENT_64 instead of LC_CODE_SIGNATURE
  assert.match(verifyMachoSignature(file).errors[0], /unsigned/);
});

test("rejects files that are not thin 64-bit Mach-O binaries", () => {
  assert.match(verifyMachoSignature(Buffer.from("#!/bin/sh\necho hi\n".repeat(8))).errors[0], /not a thin 64-bit Mach-O/);
  assert.match(verifyMachoSignature(Buffer.alloc(8)).errors[0], /not a thin 64-bit Mach-O/);
});

test("rejects a signature that runs past the end of the file", () => {
  const file = signedBinary();
  file.writeUInt32LE(file.length, 44); // datasize larger than what is left
  assert.match(verifyMachoSignature(file).errors[0], /extends past the end of the file/);
});

test("checks the CPU type when an architecture is expected", () => {
  assert.deepEqual(verifyMachoSignature(signedBinary({ arch: "x86_64" }), { arch: "x86_64" }).errors, []);
  const { errors } = verifyMachoSignature(signedBinary({ arch: "x86_64" }), { arch: "arm64" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expected arm64 but the Mach-O header says cpu type 0x1000007/);
});

test("fails cleanly on malformed input instead of throwing", () => {
  const shortCmd = signedBinary();
  shortCmd.writeUInt32LE(8, 36); // LC_CODE_SIGNATURE with a cmdsize too small to hold its fields
  assert.match(verifyMachoSignature(shortCmd).errors[0], /corrupt LC_CODE_SIGNATURE/);

  const shortCodeDirectory = signedBinary();
  const cdAt = shortCodeDirectory.indexOf(Buffer.from([0xfa, 0xde, 0x0c, 0x02]));
  shortCodeDirectory.writeUInt32BE(8, cdAt + 4); // CodeDirectory claiming to be 8 bytes long
  const { errors } = verifyMachoSignature(shortCodeDirectory);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CodeDirectory is truncated/);

  assert.equal(verifyMachoSignature(signedBinary().subarray(0, 50)).errors.length, 1);
});

test("accepts every supported hash type", () => {
  for (const [hashType, algorithm] of [[1, "sha1"], [2, "sha256"], [3, "sha256"], [4, "sha384"], [5, "sha512"]] as const) {
    const { errors, summary } = verifyMachoSignature(signedBinary({ hashType }));
    assert.deepEqual(errors, [], `hash type ${hashType}`);
    assert.match(summary, new RegExp(`${algorithm} 3 pages`));
  }
});

test("accepts a single-page CodeDirectory (page size 0) and a 64-bit codeLimit", () => {
  assert.deepEqual(verifyMachoSignature(signedBinary({ pageShift: 0 })).errors, []);
  assert.match(verifyMachoSignature(signedBinary({ pageShift: 0 })).summary, /sha256 1 pages/);
  assert.deepEqual(verifyMachoSignature(signedBinary({ codeLimit64: true })).errors, []);
});

test("verifies every CodeDirectory, including alternates", () => {
  const good = signedBinary({ alternate: 1 });
  const { errors, summary } = verifyMachoSignature(good);
  assert.deepEqual(errors, []);
  assert.match(summary, /sha256 3 pages.*sha1 3 pages/);

  const tampered = signedBinary({ alternate: 1 });
  const [, alternateAt] = codeDirectoryOffsets(tampered);
  const hashOffset = tampered.readUInt32BE(alternateAt + CD.hashOffset);
  tampered[alternateAt + hashOffset] ^= 0xff; // first page hash of the alternate CodeDirectory only
  const result = verifyMachoSignature(tampered);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /sha1 CodeDirectory: 1 of 3 page hashes do not match \(first at page 0\)/);
});

test("rejects a CodeDirectory with an unsupported or inconsistent hash", () => {
  const unknownType = signedBinary();
  unknownType[codeDirectoryOffsets(unknownType)[0] + CD.hashType] = 9;
  assert.match(verifyMachoSignature(unknownType).errors[0], /unsupported hash \(type 9, size 32\)/);

  const wrongSize = signedBinary();
  wrongSize[codeDirectoryOffsets(wrongSize)[0] + CD.hashSize] = 20; // sha256 does not produce 20 bytes
  assert.match(verifyMachoSignature(wrongSize).errors[0], /unsupported hash \(type 2, size 20\)/);
});

test("rejects a page-hash count that does not match the code size", () => {
  const file = signedBinary();
  file.writeUInt32BE(5, codeDirectoryOffsets(file)[0] + CD.codeSlots);
  assert.match(verifyMachoSignature(file).errors[0], /has 5 page hashes, expected 3/);
});

test("rejects a page-hash table that runs past the end of the CodeDirectory", () => {
  const file = signedBinary();
  const at = codeDirectoryOffsets(file)[0];
  file.writeUInt32BE(file.readUInt32BE(at + 4) - 10, at + CD.hashOffset);
  assert.match(verifyMachoSignature(file).errors[0], /page hash table runs past the end of the blob/);
});

test("rejects more special slots than fit in front of the hash table", () => {
  const file = signedBinary();
  file.writeUInt32BE(100, codeDirectoryOffsets(file)[0] + CD.specialSlots);
  assert.match(verifyMachoSignature(file).errors[0], /claims 100 special slots that do not fit/);
});

test("rejects a damaged SuperBlob", () => {
  const notSuperBlob = signedBinary();
  notSuperBlob.writeUInt32BE(0, signatureOffset(notSuperBlob));
  assert.match(verifyMachoSignature(notSuperBlob).errors[0], /not an embedded SuperBlob/);

  // a SuperBlob cut off after its first index entry, which is not a CodeDirectory slot
  const full = signedBinary();
  const at = signatureOffset(full);
  const cut = Buffer.from(full.subarray(0, at + 20));
  cut.writeUInt32LE(20, 44); // datasize now covers just the header and one index entry
  cut.writeUInt32BE(2, at + 12);
  assert.match(verifyMachoSignature(cut).errors[0], /truncated SuperBlob index/);

  const noDirectory = signedBinary();
  noDirectory.writeUInt32BE(3, signatureOffset(noDirectory) + 12); // the CodeDirectory entry becomes a resources slot
  assert.match(verifyMachoSignature(noDirectory).errors[0], /carries no CodeDirectory/);

  const danglingEntry = signedBinary();
  const danglingAt = signatureOffset(danglingEntry);
  danglingEntry.writeUInt32BE(requirementsOffset(danglingEntry) - danglingAt, danglingAt + 16); // points at the requirements blob
  assert.match(verifyMachoSignature(danglingEntry).errors[0], /points at a CodeDirectory that is not there/);
});

test("rejects damaged load commands", () => {
  const truncated = signedBinary();
  truncated.writeUInt32LE(2, 16); // ncmds
  truncated.writeUInt32LE(0x00ffffff, 36); // first command claims to be 16 MiB long
  assert.match(verifyMachoSignature(truncated).errors[0], /truncated Mach-O load commands/);

  const corrupt = signedBinary();
  corrupt.writeUInt32LE(2, 16); // a second load command follows, but it is all zeros
  assert.match(verifyMachoSignature(corrupt).errors[0], /corrupt Mach-O load command/);
});
