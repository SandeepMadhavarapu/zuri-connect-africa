import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

const DIST_DIR = 'dist';

async function walk(dir, found) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const s = await stat(fullPath);
    if (s.isDirectory()) {
      await walk(fullPath, found);
    } else {
      const name = basename(fullPath);
      if (/^\.env($|\.)/.test(name)) {
        found.push({ name, fullPath });
      }
    }
  }
}

async function main() {
  let distStat;
  try {
    distStat = await stat(DIST_DIR);
  } catch {
    console.log('SKIP: dist/ does not exist yet');
    process.exit(0);
  }

  if (!distStat.isDirectory()) {
    console.log('SKIP: dist/ does not exist yet');
    process.exit(0);
  }

  const found = [];
  await walk(DIST_DIR, found);

  if (found.length > 0) {
    for (const { name, fullPath } of found) {
      console.error(`SECURITY: ${name} found in dist/ at ${fullPath}. Refusing to ship.`);
    }
    process.exit(1);
  }

  console.log('OK: no .env files in dist/');
  process.exit(0);
}

main();
