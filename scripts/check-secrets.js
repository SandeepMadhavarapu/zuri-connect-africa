/**
 * Lightweight secret scanner — fs/path only (no deps).
 * Flags real-looking Supabase URLs and JWT-shaped tokens (eyJ...).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SAFE_SUPABASE_URLS = new Set([
  'https://your-project-id.supabase.co',
  'https://placeholder.supabase.co',
]);

const SAFE_STRINGS = new Set([
  'your-anon-key-here',
  'REPLACE_ME',
  'https://your-project-id.supabase.co',
  'https://placeholder.supabase.co',
]);

const SUPABASE_URL_RE = /https:\/\/[a-z0-9-]+\.supabase\.co/g;
/** Minimal JWT-shaped segments starting with eyJ (Supabase anon keys are JWTs). */
const JWT_LIKE_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function collectDotEnvFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.env')) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) out.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function walkFiles(dir, visitor) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') continue;
      walkFiles(full, visitor);
    } else if (ent.isFile()) {
      visitor(full);
    }
  }
}

function readUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isIgnoredToken(value) {
  const t = String(value).trim();
  if (SAFE_STRINGS.has(t)) return true;
  if (SAFE_SUPABASE_URLS.has(t)) return true;
  return false;
}

function scanContent(absolutePath, content) {
  /** @type {{ file: string; value: string; kind: string }[]} */
  const hits = [];

  let m;
  const urlRe = new RegExp(SUPABASE_URL_RE.source, 'g');
  while ((m = urlRe.exec(content)) !== null) {
    const val = m[0];
    if (!SAFE_SUPABASE_URLS.has(val)) {
      hits.push({ file: absolutePath, value: val, kind: 'supabase_url' });
    }
  }

  const jwtRe = new RegExp(JWT_LIKE_RE.source, 'g');
  while ((m = jwtRe.exec(content)) !== null) {
    const val = m[0];
    if (!isIgnoredToken(val)) {
      hits.push({ file: absolutePath, value: val, kind: 'jwt_like' });
    }
  }

  return hits;
}

function toProjectPath(absolutePath) {
  const rel = path.relative(ROOT, absolutePath);
  return rel.split(path.sep).join('/');
}

/** @type {{ file: string; value: string; kind: string }[]} */
const allHits = [];

for (const envFile of collectDotEnvFiles(ROOT)) {
  const text = readUtf8(envFile);
  if (text == null) continue;
  allHits.push(...scanContent(envFile, text));
}

for (const sub of ['src', 'supabase', 'scripts']) {
  const subRoot = path.join(ROOT, sub);
  if (!fs.existsSync(subRoot)) continue;
  walkFiles(subRoot, (abs) => {
    const text = readUtf8(abs);
    if (text == null) return;
    allHits.push(...scanContent(abs, text));
  });
}

if (allHits.length === 0) {
  console.log('Secret scan passed. No credentials detected.');
  process.exit(0);
}

for (const h of allHits) {
  console.error(`${toProjectPath(h.file)}: ${h.value}`);
  console.error('ACTION REQUIRED: Remove this secret and rotate it immediately.');
}
process.exit(1);
