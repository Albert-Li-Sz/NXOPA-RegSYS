import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const number = (bytes) => {
  if (bytes[0] & 128) {
    if (bytes[0] & 64) throw new Error('Negative tar size');
    let n = BigInt(bytes[0] & 127);
    for (const byte of bytes.subarray(1)) n = n * 256n + BigInt(byte);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Tar size overflow');
    return Number(n);
  }
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (text && !/^[0-7]+$/.test(text)) throw new Error('Invalid tar number');
  return text ? parseInt(text, 8) : 0;
};
const text = (bytes) => bytes.toString('utf8').replace(/\0.*$/, '');
function pax(buffer) {
  const fields = {};
  for (let offset = 0; offset < buffer.length;) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid PAX record');
    const size = Number(buffer.subarray(offset, space).toString());
    if (
      !Number.isSafeInteger(size) ||
      size <= space - offset + 1 ||
      offset + size > buffer.length ||
      buffer[offset + size - 1] !== 10
    )
      throw new Error('Invalid PAX length');
    const row = buffer.subarray(space + 1, offset + size - 1).toString();
    const split = row.indexOf('=');
    const key = row.slice(0, split),
      value = row.slice(split + 1);
    if (
      split < 1 ||
      ![
        'path',
        'size',
        'mtime',
        'atime',
        'ctime',
        'uid',
        'gid',
        'uname',
        'gname',
        'charset',
        'hdrcharset',
        'comment',
      ].includes(key)
    )
      throw new Error('Unsupported archive metadata');
    fields[key] = value;
    offset += size;
  }
  return fields;
}
export async function validateBackup(
  file,
  mode,
  { maxBytes = 100 * 1024 ** 3, maxEntries = 100000 } = {},
) {
  if (!['outer', 'files'].includes(mode) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error('Invalid archive limits');
  const input = createReadStream(file).pipe(createGunzip());
  let header = Buffer.alloc(0),
    remaining = 0,
    padding = 0,
    metadata = '',
    metaParts = [];
  let globalPax = {},
    nextPax = {},
    longName = '',
    totalBytes = 0,
    totalRead = 0,
    zeroBlocks = 0,
    ended = false;
  const names = new Set();
  try {
    for await (const chunk of input) {
      totalRead += chunk.length;
      if (totalRead > maxBytes + maxEntries * 2048 + 65536)
        throw new Error('Archive exceeds expansion limit');
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining) {
          const size = Math.min(remaining, chunk.length - offset);
          if (metadata) metaParts.push(chunk.subarray(offset, offset + size));
          remaining -= size;
          offset += size;
          if (!remaining && metadata) {
            const body = Buffer.concat(metaParts);
            if (metadata === 'L') longName = text(body).replace(/\n$/, '');
            else if (metadata === 'g') globalPax = { ...globalPax, ...pax(body) };
            else nextPax = pax(body);
            metadata = '';
            metaParts = [];
          }
          continue;
        }
        if (padding) {
          const size = Math.min(padding, chunk.length - offset);
          padding -= size;
          offset += size;
          continue;
        }
        const size = Math.min(512 - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + size)]);
        offset += size;
        if (header.length < 512) continue;
        if (header.every((byte) => byte === 0)) {
          if (++zeroBlocks >= 2) ended = true;
          header = Buffer.alloc(0);
          continue;
        }
        if (ended || zeroBlocks) throw new Error('Data after archive terminator');
        const expected = number(header.subarray(148, 156));
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
        if (expected !== checksum) throw new Error('Invalid tar checksum');
        const type = String.fromCharCode(header[156] || 48);
        let length = number(header.subarray(124, 136));
        if (['x', 'g', 'L'].includes(type)) {
          if (!length || length > 65536) throw new Error('Archive metadata too large');
          metadata = type;
        } else {
          if (!['0', '5'].includes(type) || text(header.subarray(157, 257)))
            throw new Error('Archive links or special files are forbidden');
          const fields = { ...globalPax, ...nextPax };
          if (fields.size !== undefined) {
            if (!/^\d+$/.test(fields.size)) throw new Error('Invalid PAX size');
            length = Number(fields.size);
          }
          let name = fields.path ?? longName ?? '';
          if (!name)
            name = [text(header.subarray(345, 500)), text(header.subarray(0, 100))]
              .filter(Boolean)
              .join('/');
          nextPax = {};
          longName = '';
          if (name.startsWith('/') || name.includes('\\') || !/^[A-Za-z0-9._/-]+$/.test(name))
            throw new Error('Invalid archive path');
          while (name.startsWith('./')) name = name.slice(2);
          name = name.replace(/\/$/, '');
          if (!name && type === '5') name = '.';
          if (
            name !== '.' &&
            name.split('/').some((part) => !part || part === '..' || part === '.')
          )
            throw new Error('Archive path traversal');
          if (!name || (name === '.' && type !== '5') || names.has(name))
            throw new Error('Duplicate or invalid archive entry');
          if (
            mode === 'outer' &&
            (type !== '0' || !['database.dump', 'files.tgz', 'environment.env'].includes(name))
          )
            throw new Error('Unexpected backup entry');
          if (!Number.isSafeInteger(length) || length < 0 || (type === '5' && length !== 0))
            throw new Error('Invalid archive size');
          names.add(name);
          totalBytes += length;
          if (names.size > maxEntries || totalBytes > maxBytes)
            throw new Error('Archive exceeds size or file limit');
        }
        remaining = length;
        padding = (512 - (length % 512)) % 512;
        header = Buffer.alloc(0);
      }
    }
    if (
      !ended ||
      header.length ||
      remaining ||
      padding ||
      metadata ||
      longName ||
      Object.keys(nextPax).length
    )
      throw new Error('Truncated archive');
    if (mode === 'outer' && names.size !== 3) throw new Error('Incomplete backup archive');
    return { entries: names.size, bytes: totalBytes };
  } finally {
    input.destroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(
      JSON.stringify(
        await validateBackup(process.argv[2], process.argv[3], {
          maxBytes: Number(process.env.BACKUP_MAX_BYTES ?? 100 * 1024 ** 3),
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
