import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const copies = [
  ['public', join('.next', 'standalone', 'edge', 'public')],
  [join('.next', 'static'), join('.next', 'standalone', 'edge', '.next', 'static')],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) continue;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
