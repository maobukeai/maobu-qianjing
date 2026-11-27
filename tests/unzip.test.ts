import { test, expect } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_ZIP_ENTRY_BYTES, TRUSTED_RUNTIME_ZIP_LIMITS, extractZipTo, parseArchive } from "../src/unzip.ts";

/** Build a minimal STORED (uncompressed) ZIP — enough to exercise the central-
 *  directory parser and path-safety without needing a deflate fixture. */
function storedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const entries: { name: Uint8Array; len: number; off: number }[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = enc.encode(content);
    const lh = new Uint8Array(30 + n.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 0, true); // method: stored
    dv.setUint32(18, d.length, true);
    dv.setUint32(22, d.length, true);
    dv.setUint16(26, n.length, true);
    lh.set(n, 30);
    entries.push({ name: n, len: d.length, off: offset });
    chunks.push(lh, d);
    offset += lh.length + d.length;
  }
  const cdStart = offset;
  for (const e of entries) {
    const ch = new Uint8Array(46 + e.name.length);
    const dv = new DataView(ch.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, 0, true);
    dv.setUint32(20, e.len, true);
    dv.setUint32(24, e.len, true);
    dv.setUint16(28, e.name.length, true);
    dv.setUint32(42, e.off, true);
    ch.set(e.name, 46);
    chunks.push(ch);
    offset += ch.length;
  }
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, entries.length, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, offset - cdStart, true);
  dv.setUint32(16, cdStart, true);
  chunks.push(eocd);
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function extensionId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const rsaPublicKey = new Uint8Array(rsaKeys.publicKey.export({ format: "der", type: "spki" }));
const ecKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecPublicKey = new Uint8Array(ecKeys.publicKey.export({ format: "der", type: "spki" }));

function crx2(zip: Uint8Array): Uint8Array {
  const signature = new Uint8Array(sign("sha1", zip, rsaKeys.privateKey));
  return concat(
    new TextEncoder().encode("Cr24"),
    uint32(2),
    uint32(rsaPublicKey.length),
    uint32(signature.length),
    rsaPublicKey,
    signature,
    zip,
  );
}

function varint(value: number): Uint8Array {
  const out: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    out.push(byte | (value > 0 ? 0x80 : 0));
  } while (value > 0);
  return new Uint8Array(out);
}

function field(number: number, bytes: Uint8Array): Uint8Array {
  return concat(varint(number * 8 + 2), varint(bytes.length), bytes);
}

function proof(publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  return concat(field(1, publicKey), field(2, signature));
}

interface Crx3Proof {
  field: 2 | 3;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

function crx3(zip: Uint8Array, identityKey: Uint8Array, proofs: Crx3Proof[]): Uint8Array {
  const crxId = createHash("sha256").update(identityKey).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const signedPayload = concat(
    new TextEncoder().encode("CRX3 SignedData\0"),
    uint32(signedData.length),
    signedData,
    zip,
  );
  const header = concat(
    ...proofs.map((item) => field(
      item.field,
      proof(item.publicKey, new Uint8Array(sign("sha256", signedPayload, item.privateKey))),
    )),
    field(10000, signedData),
  );
  return concat(new TextEncoder().encode("Cr24"), uint32(3), uint32(header.length), header, zip);
}

test("parses CRX2 public-key identity and ZIP payload", () => {
  const zip = storedZip({ "manifest.json": '{"name":"X"}' });
  const parsed = parseArchive(crx2(zip));

  expect(parsed.crxVersion).toBe(2);
  expect(parsed.extensionId).toBe(extensionId(rsaPublicKey));
  expect(parsed.manifestKey).toBe(Buffer.from(rsaPublicKey).toString("base64"));
  expect(parsed.zip).toEqual(zip);
});

test("rejects a CRX2 package with an invalid signature", () => {
  const archive = crx2(storedZip({ "manifest.json": '{"name":"X"}' }));
  const signatureOffset = 16 + rsaPublicKey.length;
  archive[signatureOffset] = archive[signatureOffset]! ^ 1;
  expect(() => parseArchive(archive)).toThrow("signature");
});

test("selects the verified CRX3 proof whose key matches the signed extension id", () => {
  const zip = storedZip({ "manifest.json": '{"name":"X"}' });
  const parsed = parseArchive(crx3(zip, ecPublicKey, [
    { field: 2, publicKey: rsaPublicKey, privateKey: rsaKeys.privateKey },
    { field: 3, publicKey: ecPublicKey, privateKey: ecKeys.privateKey },
  ]));

  expect(parsed.crxVersion).toBe(3);
  expect(parsed.extensionId).toBe(extensionId(ecPublicKey));
  expect(parsed.manifestKey).toBe(Buffer.from(ecPublicKey).toString("base64"));
  expect(parsed.zip).toEqual(zip);
});

test("rejects a CRX3 package with an invalid signature", () => {
  const archive = crx3(
    storedZip({ "manifest.json": '{"name":"X"}' }),
    ecPublicKey,
    [{ field: 3, publicKey: ecPublicKey, privateKey: ecKeys.privateKey }],
  );
  const lastByte = archive.length - 1;
  archive[lastByte] = archive[lastByte]! ^ 1;
  expect(() => parseArchive(archive)).toThrow("signature");
});

test("rejects malformed CRX metadata and CRX3 without its identity proof", () => {
  const fixed = concat(new TextEncoder().encode("Cr24"), uint32(3));
  expect(() => parseArchive(concat(fixed, uint32(20), new Uint8Array([1])))).toThrow("truncated CRX3 header");
  expect(() => parseArchive(concat(fixed, uint32(1), new Uint8Array([0x80])))).toThrow("protobuf varint");

  const zip = storedZip({ "manifest.json": '{"name":"X"}' });
  expect(() => parseArchive(crx3(zip, ecPublicKey, [
    { field: 2, publicKey: rsaPublicKey, privateKey: rsaKeys.privateKey },
  ]))).toThrow("matching its signed extension id");
});

test("extracts files (incl. nested) from a zip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  const n = await extractZipTo(storedZip({ "manifest.json": '{"name":"X"}', "js/bg.js": "hi" }), dir);
  expect(n).toBe(2);
  expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe('{"name":"X"}');
  expect(readFileSync(join(dir, "js/bg.js"), "utf8")).toBe("hi");
});

test("extracts raw-deflate entries without DecompressionStream", async () => {
  const zip = Buffer.from(
    "UEsDBBQAAAAIAJNrEF0kGtjVFAAAABIAAAAOAAAAY29tcHJlc3NlZC50eHRLzs8tKEotLk5NUShIrMzJT0wBAFBLAQIUAxQAAAAIAJNrEF0kGtjVFAAAABIAAAAOAAAAAAAAAAAAAACAAQAAAABjb21wcmVzc2VkLnR4dFBLBQYAAAAAAQABADwAAABAAAAAAAA=",
    "base64",
  );
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  expect(await extractZipTo(zip, dir)).toBe(1);
  expect(readFileSync(join(dir, "compressed.txt"), "utf8")).toBe("compressed payload");
});

test("refuses path-traversal entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  await extractZipTo(storedZip({ "../evil.txt": "x", "ok.txt": "y" }), dir);
  expect(existsSync(join(dir, "ok.txt"))).toBe(true);
  expect(existsSync(join(dir, "..", "evil.txt"))).toBe(false);
});

test("rejects non-zip input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  await expect(extractZipTo(new TextEncoder().encode("not a zip at all"), dir)).rejects.toThrow();
});

function deflatedZip(entriesInput: Array<{ name: string; data: Uint8Array; spoofUncompSize?: number }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const meta: { name: Uint8Array; compLen: number; uncompLen: number; off: number }[] = [];
  let offset = 0;
  for (const item of entriesInput) {
    const n = enc.encode(item.name);
    const comp = new Uint8Array(deflateRawSync(item.data));
    const lh = new Uint8Array(30 + n.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 8, true); // method: deflate
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, item.spoofUncompSize ?? item.data.length, true);
    dv.setUint16(26, n.length, true);
    lh.set(n, 30);
    meta.push({ name: n, compLen: comp.length, uncompLen: item.spoofUncompSize ?? item.data.length, off: offset });
    chunks.push(lh, comp);
    offset += lh.length + comp.length;
  }
  const cdStart = offset;
  for (const e of meta) {
    const ch = new Uint8Array(46 + e.name.length);
    const dv = new DataView(ch.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, 8, true);
    dv.setUint32(20, e.compLen, true);
    dv.setUint32(24, e.uncompLen, true);
    dv.setUint16(28, e.name.length, true);
    dv.setUint32(42, e.off, true);
    ch.set(e.name, 46);
    chunks.push(ch);
    offset += ch.length;
  }
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, meta.length, true);
  dv.setUint16(10, meta.length, true);
  dv.setUint32(12, offset - cdStart, true);
  dv.setUint32(16, cdStart, true);
  chunks.push(eocd);
  return concat(...chunks);
}

test("rejects zip-bomb entries exceeding maxEntryBytes or maxTotalBytes even when header size is spoofed", async () => {
  const payload = new Uint8Array(4096).fill(0x41);
  const spoofed = deflatedZip([{ name: "bomb.txt", data: payload, spoofUncompSize: 4 }]);
  const dir1 = mkdtempSync(join(tmpdir(), "cp-unzip-bomb1-"));
  await expect(extractZipTo(spoofed, dir1, { maxEntryBytes: 1024 })).rejects.toThrow("size limit");

  const multi = deflatedZip([
    { name: "a.txt", data: new Uint8Array(600).fill(0x41) },
    { name: "b.txt", data: new Uint8Array(600).fill(0x42) },
  ]);
  const dir2 = mkdtempSync(join(tmpdir(), "cp-unzip-bomb2-"));
  await expect(extractZipTo(multi, dir2, { maxEntryBytes: 1024, maxTotalBytes: 1000 })).rejects.toThrow("size limit");
});

test("rejects null-byte entry names, backslash traversal, and corrupted header offsets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-sec-"));
  await expect(extractZipTo(storedZip({ "bad\0name.txt": "x" }), dir)).rejects.toThrow("null byte");

  await extractZipTo(storedZip({ "sub\\..\\..\\evil.txt": "x", "folder\\": "", "good.txt": "ok" }), dir);
  expect(existsSync(join(dir, "good.txt"))).toBe(true);
  expect(existsSync(join(dir, "..", "evil.txt"))).toBe(false);

  const corrupt = storedZip({ "a.txt": "hello" });
  const view = new DataView(corrupt.buffer);
  // Corrupt central directory offset in EOCD to point out of bounds.
  view.setUint32(corrupt.length - 6, corrupt.length + 50, true);
  await expect(extractZipTo(corrupt, dir)).rejects.toThrow("truncated central directory");
});

test("default limits still reject >64 MiB entries while TRUSTED_RUNTIME_ZIP_LIMITS allows verified runtime binaries", async () => {
  expect(DEFAULT_MAX_ZIP_ENTRY_BYTES).toBe(64 * 1024 * 1024);
  expect(TRUSTED_RUNTIME_ZIP_LIMITS.maxEntryBytes).toBe(512 * 1024 * 1024);
  const seventyMiB = new Uint8Array(70 * 1024 * 1024);
  const runtimeZip = deflatedZip([{ name: "node-v22/node.exe", data: seventyMiB }]);
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-runtime-"));
  try {
    await expect(extractZipTo(runtimeZip, dir)).rejects.toThrow("size limit");
    expect(await extractZipTo(runtimeZip, dir, TRUSTED_RUNTIME_ZIP_LIMITS)).toBe(1);
    expect(existsSync(join(dir, "node-v22", "node.exe"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
