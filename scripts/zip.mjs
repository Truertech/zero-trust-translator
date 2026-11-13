// A deterministic ZIP writer, written in this repository (the
// build must be byte-for-byte reproducible, which rules out a compression
// codec whose output can differ between zlib versions). Every entry is
// stored uncompressed (method 0), so the only bytes in the archive are the
// file bytes themselves, the same on every machine. File names are written
// in the order given — callers sort them first — and every entry carries
// the same fixed mtime and the same fixed `rw-r--r--` Unix mode, so two
// builds of the same input always produce the same bytes.

const UNIX_FILE_MODE = 0o100644; // regular file, rw-r--r--
const VERSION_MADE_BY = (3 << 8) | 20; // host = Unix (3), zip spec 2.0
const VERSION_NEEDED = 20;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time fields, computed from the UTC calendar fields of `epochSeconds` so the result does not depend on the building machine's timezone. */
function dosDateTime(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const year = Math.max(1980, d.getUTCFullYear());
  const dosDate = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  return { dosDate, dosTime };
}

/**
 * Builds a ZIP archive, stored (uncompressed), from `files` (already sorted
 * by the caller) using `epochSeconds` for every entry's modification time.
 */
export function buildDeterministicZip(files, epochSeconds) {
  const { dosDate, dosTime } = dosDateTime(epochSeconds);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(0, 6); // general purpose flag
    localHeader.writeUInt16LE(0, 8); // method: stored
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory header signature
    centralHeader.writeUInt16LE(VERSION_MADE_BY, 4);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(0, 8); // general purpose flag
    centralHeader.writeUInt16LE(0, 10); // method: stored
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    centralSize += centralHeader.length + nameBuf.length;
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // entries total
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, end]);
}
