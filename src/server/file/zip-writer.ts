/**
 * Streaming ZIP writer: each `addFile` returns that file's bytes (local header
 * plus data), and `finish` returns the central directory, so an archive can be
 * sent while it is built and only one file is held in memory at a time. jszip,
 * which reads uploads, builds the whole archive in memory before emitting any of
 * it, which a large account export can't afford.
 *
 * Writes Zip64 end records when the file count or archive size outgrows the
 * classic format, so a big export stays readable. A single file must fit in
 * 4 GiB.
 */

import { crc32, deflateRaw } from "node:zlib";
import { promisify } from "node:util";

const deflateRawAsync = promisify(deflateRaw);

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const EXTENDED_TIMESTAMP_FIELD_ID = 0x5455;
const EXTENDED_TIMESTAMP_HAS_MTIME = 1;

const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

interface CentralEntry {
  name: Buffer;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  timestampExtra: Buffer;
}

/**
 * DOS times have no zone, and most unzip tools read them as local time, so the
 * Unix mtime goes in an extended-timestamp field too; readers prefer it.
 */
function extendedTimestamp(date: Date): Buffer {
  const field = Buffer.alloc(9);
  field.writeUInt16LE(EXTENDED_TIMESTAMP_FIELD_ID, 0);
  field.writeUInt16LE(5, 2);
  field.writeUInt8(EXTENDED_TIMESTAMP_HAS_MTIME, 4);
  field.writeUInt32LE(Math.max(0, Math.floor(date.getTime() / 1000)), 5);
  return field;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    dosTime: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export class ZipWriter {
  #offset = 0;
  #entries: CentralEntry[] = [];
  #finished = false;

  async addFile(name: string, content: string | Uint8Array, modified: Date): Promise<Buffer> {
    if (this.#finished) throw new Error("ZipWriter: addFile after finish");

    const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (data.length >= UINT32_MAX) throw new Error(`ZipWriter: ${name} is too large`);

    const deflated = await deflateRawAsync(data);
    const stored = deflated.length >= data.length;
    const payload = stored ? data : deflated;

    const entry: CentralEntry = {
      name: Buffer.from(name, "utf8"),
      method: stored ? METHOD_STORE : METHOD_DEFLATE,
      ...toDosDateTime(modified),
      crc: crc32(data),
      compressedSize: payload.length,
      size: data.length,
      offset: this.#offset,
      timestampExtra: extendedTimestamp(modified),
    };

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_DEFAULT, 4);
    header.writeUInt16LE(FLAG_UTF8_NAME, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.dosTime, 10);
    header.writeUInt16LE(entry.dosDate, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressedSize, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(entry.timestampExtra.length, 28);

    const chunk = Buffer.concat([header, entry.name, entry.timestampExtra, payload]);
    this.#entries.push(entry);
    this.#offset += chunk.length;
    return chunk;
  }

  finish(): Buffer {
    if (this.#finished) throw new Error("ZipWriter: finish called twice");
    this.#finished = true;

    const centralDirectoryOffset = this.#offset;
    const records = this.#entries.map(centralDirectoryRecord);
    const centralDirectorySize = records.reduce((sum, record) => sum + record.length, 0);
    const count = this.#entries.length;

    const needsZip64 =
      count >= UINT16_MAX ||
      centralDirectorySize >= UINT32_MAX ||
      centralDirectoryOffset >= UINT32_MAX;

    const tail: Buffer[] = [];
    if (needsZip64) {
      const zip64EndOffset = centralDirectoryOffset + centralDirectorySize;

      const zip64End = Buffer.alloc(56);
      zip64End.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
      zip64End.writeBigUInt64LE(44n, 4);
      zip64End.writeUInt16LE(VERSION_ZIP64, 12);
      zip64End.writeUInt16LE(VERSION_ZIP64, 14);
      zip64End.writeUInt32LE(0, 16);
      zip64End.writeUInt32LE(0, 20);
      zip64End.writeBigUInt64LE(BigInt(count), 24);
      zip64End.writeBigUInt64LE(BigInt(count), 32);
      zip64End.writeBigUInt64LE(BigInt(centralDirectorySize), 40);
      zip64End.writeBigUInt64LE(BigInt(centralDirectoryOffset), 48);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_END_LOCATOR_SIGNATURE, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
      locator.writeUInt32LE(1, 16);

      tail.push(zip64End, locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(count, UINT16_MAX), 8);
    end.writeUInt16LE(Math.min(count, UINT16_MAX), 10);
    end.writeUInt32LE(Math.min(centralDirectorySize, UINT32_MAX), 12);
    end.writeUInt32LE(Math.min(centralDirectoryOffset, UINT32_MAX), 16);
    end.writeUInt16LE(0, 20);
    tail.push(end);

    return Buffer.concat([...records, ...tail]);
  }
}

function centralDirectoryRecord(entry: CentralEntry): Buffer {
  const offsetNeedsZip64 = entry.offset >= UINT32_MAX;
  const zip64Extra = Buffer.alloc(offsetNeedsZip64 ? 12 : 0);
  if (offsetNeedsZip64) {
    zip64Extra.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0);
    zip64Extra.writeUInt16LE(8, 2);
    zip64Extra.writeBigUInt64LE(BigInt(entry.offset), 4);
  }
  const extra = Buffer.concat([zip64Extra, entry.timestampExtra]);
  const version = offsetNeedsZip64 ? VERSION_ZIP64 : VERSION_DEFAULT;

  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(version, 4);
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(FLAG_UTF8_NAME, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.dosTime, 12);
  header.writeUInt16LE(entry.dosDate, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offsetNeedsZip64 ? UINT32_MAX : entry.offset, 42);

  return Buffer.concat([header, entry.name, extra]);
}
