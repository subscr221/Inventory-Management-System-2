import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_LITERAL_PATTERNS = [
  /^app\./,
  /^sync\./,
  /^capture\./,
  /^bootstrap\./,
  /^errors\./,
  /^nav\./,
  /^Dashboard$/,
  /^Frontline$/,
  /^main-content$/,
  /^first-sync-heading$/,
  /^ready-heading$/,
  /^dashboard$/,
  /^frontline$/,
  /^sync-failure-heading$/,
  /^edge-/,
  /^sync-/,
  /^card-grid$/,
  /^auth-required$/,
  /^skip-link$/,
  /^primary-action$/,
  /^secondary-action$/,
  /^button$/,
  /^polite$/,
  /^status$/,
  /^alert$/,
  /^●$/,
  /^ · $/,
];

const USER_FACING_ATTRS = ['aria-label', 'title', 'placeholder', 'alt', 'aria-description'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

function scan(dir: string): string[] {
  return files(join(process.cwd(), dir))
    .filter((file) => file.endsWith('.tsx'))
    .flatMap((file) => {
      const text = readFileSync(file, 'utf-8');
      const textNodes = [...text.matchAll(/>\s*([A-Za-z][A-Za-z0-9 .,!?'-]*)\s*</g)]
        .map((match) => match[1]!.trim())
        .filter((literal) => /[A-Za-z]/.test(literal));
      const attrNodes = USER_FACING_ATTRS.flatMap((attr) =>
        [...text.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((match) =>
          match[1]!.trim(),
        ),
      ).filter((literal) => /[A-Za-z]/.test(literal));
      return [...textNodes, ...attrNodes];
    });
}

describe('i18n literal guard', () => {
  it('keeps shell user-facing strings in the message catalog', () => {
    const literals = [...scan(join('src', 'components')), ...scan('app')];
    assert.deepEqual(
      literals.filter(
        (literal) => !ALLOWED_LITERAL_PATTERNS.some((pattern) => pattern.test(literal)),
      ),
      [],
    );
  });
});
