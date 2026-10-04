import { mkdir, lstat, readFile, open, rename, unlink, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function createSettingsStore(dataDir = 'data') {
  const directory = resolve(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid data directory');
  await chmod(directory, 0o700);
  const filename = join(directory, 'repositories.json');
  let records = Object.create(null);
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Invalid settings file');
    await chmod(filename, 0o600);
    const parsed = JSON.parse(await readFile(filename, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings');
    records = Object.assign(Object.create(null), parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let pending = Promise.resolve();
  return {
    get(id) { return structuredClone(records[String(id)] ?? {}); },
    set(id, config) {
      const work = pending.then(async () => {
        const next = Object.assign(Object.create(null), records, { [String(id)]: config });
        const serialized = JSON.stringify(next);
        if (Object.keys(next).length > 1000 || Buffer.byteLength(serialized) > 2_000_000) {
          throw new Error('Settings capacity reached');
        }
        const temporary = join(directory, `.repositories-${randomBytes(16).toString('hex')}.json`);
        let handle;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(serialized);
          await handle.sync();
          await handle.close();
          handle = undefined;
          await rename(temporary, filename);
          records = next;
        } finally {
          await handle?.close();
          await unlink(temporary).catch(() => {});
        }
      });
      pending = work.catch(() => {});
      return work;
    },
  };
}
