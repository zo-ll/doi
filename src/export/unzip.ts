import { inflateRawSync } from "node:zlib";
import type { ZipEntry } from "./zip.ts";

/**
 * Reads a ZIP archive: the files that `zip()` writes, and the usual stored or deflated files
 * of other tools. An import file is untrusted data, so the reader checks every step: entry
 * count, sizes (also against a zip bomb), names (no absolute paths, no "..", no "\"), and the
 * CRC of each file. No ZIP64, no encryption.
 */
export const UNZIP_LIMITS = { entries: 50_000, total: 1024 * 1024 * 1024, perFile: 256 * 1024 * 1024 } as const;

export class ZipError extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A safe relative path: "/" separators, no empty, "." or ".." parts, no leading "/". */
export function safeZipPath(name: string): boolean {
  if (!name || name.length > 1024 || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function unzip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: 22 bytes, maybe followed by a comment of up to 64 KB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("This is not a ZIP file.");
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (count > UNZIP_LIMITS.entries) throw new ZipError(`The file has more than ${UNZIP_LIMITS.entries} entries.`);
  if (dirOffset + dirSize > eocd) throw new ZipError("The ZIP file is broken (central directory).");

  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== 0x02014b50) throw new ZipError("The ZIP file is broken (entry header).");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const packed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    let name: string;
    try {
      name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    } catch {
      throw new ZipError("A file name in the ZIP is not UTF-8.");
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // a folder entry
    if (!safeZipPath(name)) throw new ZipError(`The ZIP has an unsafe path: ${JSON.stringify(name.slice(0, 120))}.`);
    if (seen.has(name)) throw new ZipError(`The ZIP has ${name} twice.`);
    seen.add(name);
    if (flags & 0x1) throw new ZipError("Encrypted ZIP files are not supported.");
    if (method !== 0 && method !== 8) throw new ZipError(`${name}: compression method ${method} is not supported.`);
    if (size > UNZIP_LIMITS.perFile) throw new ZipError(`${name} is larger than ${UNZIP_LIMITS.perFile / 1024 / 1024} MB.`);
    total += size;
    if (total > UNZIP_LIMITS.total) throw new ZipError("The files in the ZIP are larger than 1 GB together.");

    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new ZipError(`${name}: the local header is broken.`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > bytes.length) throw new ZipError(`${name}: the data is cut.`);
    const raw = bytes.subarray(start, start + packed);
    let data: Uint8Array;
    try {
      // maxOutputLength stops at the declared size: a file that lies about it cannot fill the memory.
      data = method === 0 ? raw.slice() : new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }));
    } catch {
      throw new ZipError(`${name}: the data cannot be unpacked.`);
    }
    if (data.length !== size) throw new ZipError(`${name}: the size does not match.`);
    if ((Bun.hash.crc32(data) >>> 0) !== crc) throw new ZipError(`${name}: the CRC does not match.`);
    out.push({ path: name, data: data as Uint8Array<ArrayBuffer> });
  }
  return out;
}
