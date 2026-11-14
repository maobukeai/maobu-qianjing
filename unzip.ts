/**
 * Minimal, dependency-free ZIP (and Chrome .crx) extractor.
 *
 * Chrome extensions are uploaded as a .zip of the unpacked extension or a .crx
 * (a zip with a signing header). We extract to a directory and load it unpacked
 * with --load-extension. We parse the central directory (authoritative sizes +
 * offsets even when the local headers use streaming data descriptors) and
 * inflate entries with Node's built-in zlib — no external `unzip`.
 */

import { createHash, createPublicKey, createVerify } from "node:crypto";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export const DEFAULT_MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_ZIP_ENTRIES = 10_000;

export interface ZipExtractLimits {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
}

/** Generous limits strictly for SHA-256-verified official runtime/browser archives. */
export const TRUSTED_RUNTIME_ZIP_LIMITS: Readonly<ZipExtractLimits> = {
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 50_000,
};

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export interface ParsedArchive {
  zip: Uint8Array;
  crxVersion?: 2 | 3;
  publicKey?: Uint8Array;
  extensionId?: string;
  manifestKey?: string;
}

function extensionId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

function readVarint(data: Uint8Array, position: { value: number }): number {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (position.value >= data.length) throw new Error("truncated protobuf varint");
    const byte = data[position.value++]!;
    value += (byte & 0x7f) * scale;
    if (!Number.isSafeInteger(value)) throw new Error("protobuf varint is too large");
    if ((byte & 0x80) === 0) return value;
    scale *= 128;
    if (!Number.isSafeInteger(scale)) throw new Error("protobuf varint is too large");
  }
}

function lengthDelimitedFields(data: Uint8Array): Array<{ number: number; bytes: Uint8Array }> {
  const fields: Array<{ number: number; bytes: Uint8Array }> = [];
  const position = { value: 0 };
  while (position.value < data.length) {
    const tag = readVarint(data, position);
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0 || wire !== 2) throw new Error("unsupported CRX3 protobuf field");
    const length = readVarint(data, position);
    const end = position.value + length;
    if (!Number.isSafeInteger(end) || end > data.length) throw new Error("truncated CRX3 protobuf field");
    fields.push({ number, bytes: data.subarray(position.value, end) });
    position.value = end;
  }
  return fields;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function verifiesSignature(
  algorithm: "sha1" | "sha256",
  chunks: Uint8Array[],
  publicKey: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey),
      format: "der",
      type: "spki",
    });
    const verifier = createVerify(algorithm);
    for (const chunk of chunks) verifier.update(chunk);
    verifier.end();
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}

/** Parse a ZIP or signed Chrome extension archive without inflating its payload. */
export function parseArchive(input: Uint8Array): ParsedArchive {
  const isCrx = input.length >= 4 && input[0] === 0x43 && input[1] === 0x72 && input[2] === 0x32 && input[3] === 0x34; // "Cr24"
  if (!isCrx) return { zip: input };
  if (input.length < 8) throw new Error("truncated CRX header");

  const version = u32(input, 4);
  if (version === 2) {
    if (input.length < 16) throw new Error("truncated CRX2 header");
    const publicKeyLength = u32(input, 8);
    const signatureLength = u32(input, 12);
    const keyEnd = 16 + publicKeyLength;
    const zipOffset = keyEnd + signatureLength;
    if (publicKeyLength === 0 || signatureLength === 0 || keyEnd > input.length || zipOffset > input.length) {
      throw new Error("truncated CRX2 header");
    }
    const publicKey = input.subarray(16, keyEnd);
    const signature = input.subarray(keyEnd, zipOffset);
    const zip = input.subarray(zipOffset);
    if (!verifiesSignature("sha1", [zip], publicKey, signature)) {
      throw new Error("CRX2 signature verification failed");
    }
    return {
      zip,
      crxVersion: 2,
      publicKey,
      extensionId: extensionId(publicKey),
      manifestKey: Buffer.from(publicKey).toString("base64"),
    };
  }

  if (version === 3) {
    if (input.length < 12) throw new Error("truncated CRX3 header");
    const headerLength = u32(input, 8);
    const zipOffset = 12 + headerLength;
    if (zipOffset > input.length) throw new Error("truncated CRX3 header");

    const header = lengthDelimitedFields(input.subarray(12, zipOffset));
    const signedData = header.find((field) => field.number === 10000)?.bytes;
    if (!signedData) throw new Error("CRX3 has no signed extension id");
    const crxId = lengthDelimitedFields(signedData).find((field) => field.number === 1)?.bytes;
    if (!crxId || crxId.length !== 16) throw new Error("CRX3 has an invalid signed extension id");

    const proofs = header
      .filter((field) => field.number === 2 || field.number === 3)
      .map((field) => {
        const proofFields = lengthDelimitedFields(field.bytes);
        return {
          publicKey: proofFields.find((proofField) => proofField.number === 1)?.bytes,
          signature: proofFields.find((proofField) => proofField.number === 2)?.bytes,
        };
      })
      .filter((proof): proof is { publicKey: Uint8Array; signature: Uint8Array } =>
        !!proof.publicKey && !!proof.signature,
      );
    const matchingProofs = proofs.filter((proof) =>
      sameBytes(createHash("sha256").update(proof.publicKey).digest().subarray(0, 16), crxId),
    );
    if (matchingProofs.length === 0) {
      throw new Error("CRX3 has no public key matching its signed extension id");
    }

    const signedDataLength = new Uint8Array(4);
    new DataView(signedDataLength.buffer).setUint32(0, signedData.length, true);
    const zip = input.subarray(zipOffset);
    const signatureChunks = [
      new TextEncoder().encode("CRX3 SignedData\0"),
      signedDataLength,
      signedData,
      zip,
    ];
    const publicKey = matchingProofs.find((proof) =>
      verifiesSignature("sha256", signatureChunks, proof.publicKey, proof.signature),
    )?.publicKey;
    if (!publicKey) throw new Error("CRX3 signature verification failed");

    return {
      zip,
      crxVersion: 3,
      publicKey,
      extensionId: extensionId(publicKey),
      manifestKey: Buffer.from(publicKey).toString("base64"),
    };
  }

  throw new Error(`unsupported CRX version ${version}`);
}

async function inflateRaw(data: Uint8Array, maxOutputLength: number): Promise<Uint8Array> {
  try {
    return new Uint8Array(inflateRawSync(data, { maxOutputLength }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ERR_BUFFER_TOO_LARGE" || (err instanceof RangeError && /output length|maxOutputLength/i.test(err.message))) {
      throw new Error(`zip entry exceeds output size limit (${maxOutputLength} bytes)`);
    }
    throw err;
  }
}

/** True if a zip entry name would escape destDir (path traversal / absolute / null byte). */
function unsafe(name: string): boolean {
  if (name.includes("\0") || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) return true;
  if (name.split(/[\\/]+/).some((segment) => segment === "..")) return true;
  const norm = normalize(name);
  return isAbsolute(norm) || norm === ".." || norm.startsWith(".." + "/") || norm.startsWith(".." + "\\") || norm.startsWith(".." + sep);
}

/** Ensure target path stays strictly contained within destRoot. */
function resolveContainedPath(destRoot: string, entryName: string): string {
  if (entryName.includes("\0")) throw new Error("unsafe zip entry name: null byte");
  const target = resolve(destRoot, entryName);
  const rel = relative(destRoot, target);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`zip entry escapes destination directory: ${entryName}`);
  }
  return target;
}

export interface ZipEntry {
  /** Entry path as stored in the archive (never a directory, never unsafe). */
  name: string;
  /** Decompress this entry's bytes. Deferred so a caller can skip entries cheaply. */
  bytes(): Promise<Uint8Array>;
}

/**
 * Walk a ZIP/CRX central directory, yielding one entry at a time. Lazy on
 * purpose: callers that only want a couple of members (xlsx.ts reads two XML
 * parts out of a workbook) never pay to inflate the rest, and extractZipTo
 * keeps its original one-entry-at-a-time memory profile.
 */
export async function* zipEntries(input: Uint8Array, limits: ZipExtractLimits = {}): AsyncGenerator<ZipEntry> {
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ZIP_ENTRY_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_ZIP_TOTAL_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES;
  const data = parseArchive(input).zip;
  // Locate End Of Central Directory (scan back over the optional comment).
  let eocd = -1;
  const minStart = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= minStart; i--) {
    if (u32(data, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid zip/crx (no end-of-central-directory record)");

  const total = u16(data, eocd + 10);
  if (total > maxEntries) throw new Error(`zip archive exceeds entry count limit (${total} > ${maxEntries})`);
  let p = u32(data, eocd + 16); // central directory offset
  let remainingTotalBytes = maxTotalBytes;

  for (let n = 0; n < total; n++) {
    if (p + 46 > data.length) throw new Error("truncated central directory header");
    if (u32(data, p) !== 0x02014b50) break; // central dir header signature
    const method = u16(data, p + 10);
    const compSize = u32(data, p + 20);
    const uncompSize = u32(data, p + 24);
    const nameLen = u16(data, p + 28);
    const extraLen = u16(data, p + 30);
    const commentLen = u16(data, p + 32);
    const localOff = u32(data, p + 42);
    const nextOffset = p + 46 + nameLen + extraLen + commentLen;
    if (nextOffset > data.length) throw new Error("truncated central directory entry");
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    p = nextOffset;

    if (name.includes("\0")) throw new Error("zip entry name contains null byte");
    if (!name || name.endsWith("/") || name.endsWith("\\")) continue; // directory entry
    if (unsafe(name)) continue;

    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method (${method}) for ${name}`);
    if (uncompSize > maxEntryBytes) throw new Error(`zip entry ${name} exceeds entry size limit (${maxEntryBytes} bytes)`);

    // Walk the local header to find where the data actually starts.
    if (localOff + 30 > data.length || u32(data, localOff) !== 0x04034b50) {
      throw new Error(`invalid local file header for ${name}`);
    }
    const lNameLen = u16(data, localOff + 26);
    const lExtraLen = u16(data, localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const end = start + compSize;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end > data.length) {
      throw new Error(`zip entry ${name} extends beyond archive bounds`);
    }
    const comp = data.subarray(start, end);
    let cached: Promise<Uint8Array> | null = null;
    yield {
      name,
      bytes: () => {
        if (!cached) {
          cached = (async () => {
            const limit = Math.min(maxEntryBytes, remainingTotalBytes);
            if (limit <= 0 && (comp.length > 0 || uncompSize > 0)) {
              throw new Error(`zip archive exceeds total extracted size limit (${maxTotalBytes} bytes)`);
            }
            const out = method === 0
              ? (() => {
                if (comp.length > limit) throw new Error(`zip entry exceeds output size limit (${limit} bytes)`);
                return comp;
              })()
              : await inflateRaw(comp, limit);
            remainingTotalBytes -= out.length;
            if (remainingTotalBytes < 0) {
              throw new Error(`zip archive exceeds total extracted size limit (${maxTotalBytes} bytes)`);
            }
            return out;
          })();
        }
        return cached;
      },
    };
  }
}

/** Extract a ZIP/CRX to destDir. Returns the number of files written. */
export async function extractZipTo(input: Uint8Array, destDir: string, limits: ZipExtractLimits = {}): Promise<number> {
  const destRoot = resolve(destDir);
  let written = 0;
  for await (const entry of zipEntries(input, limits)) {
    const targetPath = resolveContainedPath(destRoot, entry.name);
    await Bun.write(targetPath, await entry.bytes());
    written++;
  }
  if (written === 0) throw new Error("archive contained no files");
  return written;
}
