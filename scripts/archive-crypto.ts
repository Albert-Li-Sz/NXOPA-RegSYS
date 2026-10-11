import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, writeFile, appendFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
const [action, input, output] = process.argv.slice(2);
if (!input || !output || !['encrypt', 'decrypt'].includes(action!))
  throw new Error('Usage: encrypt|decrypt input output');
const key = process.env.ENCRYPTION_KEY;
if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('Original ENCRYPTION_KEY required');
const magic = Buffer.from('CCBACKUP1');
try {
  if (action === 'encrypt') {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    cipher.setAAD(magic);
    await writeFile(output, Buffer.concat([magic, iv]), { flag: 'wx', mode: 0o600 });
    await pipeline(
      createReadStream(input),
      cipher,
      createWriteStream(output, { flags: 'a', mode: 0o600 }),
    );
    await appendFile(output, cipher.getAuthTag());
  } else {
    const size = (await stat(input)).size;
    if (size < magic.length + 28) throw new Error('Invalid backup');
    const f = await open(input, 'r'),
      header = Buffer.alloc(magic.length + 12),
      tag = Buffer.alloc(16);
    await f.read(header, 0, header.length, 0);
    await f.read(tag, 0, 16, size - 16);
    await f.close();
    if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Invalid backup format');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      header.subarray(magic.length),
    );
    decipher.setAAD(magic);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(input, { start: header.length, end: size - 17 }),
      decipher,
      createWriteStream(output, { flags: 'wx', mode: 0o600 }),
    );
  }
} catch (error) {
  await rm(output, { force: true });
  throw error;
}
