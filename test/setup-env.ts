// Loads .env.test (local Postgres test database) before any module reads process.env.
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const file = resolve(__dirname, '..', '.env.test');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
