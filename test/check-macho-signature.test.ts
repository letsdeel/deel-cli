import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMachoSignature } from "../scripts/check-macho-signature.ts";
import { PAGE, requirementsOffset, signedBinary } from "./macho-fixture.ts";

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
