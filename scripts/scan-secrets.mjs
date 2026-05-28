#!/usr/bin/env node
/**
 * CI guard: fail if high-confidence secret material appears in tracked source paths.
 * Does not replace GitHub secret scanning — adds repo-specific patterns.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'scripts', 'supabase/functions'];
const EXT_ALLOW = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.env.example']);

const PATTERNS = [
  { name: 'service_role_jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'supabase_service_role_key', re: /sb_secret_[A-Za-z0-9_-]{20,}/i },
  { name: 'aws_secret_key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private_key_pem', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'stripe_live', re: /sk_live_[0-9a-zA-Z]{20,}/ },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    if (name === 'tests' || name === '__tests__') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else {
      const ext = extname(name);
      if (EXT_ALLOW.has(ext) || name === 'Dockerfile') out.push(p);
    }
  }
  return out;
}

function main() {
  const hits = [];
  for (const rel of SCAN_DIRS) {
    const base = join(ROOT, rel);
    for (const file of walk(base)) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const short = file.replace(ROOT + '\\', '').replace(ROOT + '/', '');
      for (const { name, re } of PATTERNS) {
        if (re.test(text)) hits.push({ file: short, pattern: name });
      }
    }
  }

  if (hits.length) {
    console.error('[scan-secrets] Potential secret material detected:');
    for (const h of hits) console.error(`  ${h.pattern}: ${h.file}`);
    process.exit(1);
  }
  console.log('[scan-secrets] OK');
  process.exit(0);
}

main();
