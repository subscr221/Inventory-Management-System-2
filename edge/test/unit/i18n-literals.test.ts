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
  /^Dashboard$/,
  /^Frontline$/,
  /^main-content$/,
  /^edge-/,
  /^sync-/,
  /^button$/,
  /^polite$/,
  /^status$/,
  /^●$/,
  /^ · $/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('i18n literal guard', () => {
  it('keeps shell component user-facing strings in the message catalog', () => {
    const componentFiles = files(join(process.cwd(), 'src', 'components')).filter((file) =>
      file.endsWith('.tsx'),
    );
    const literals = componentFiles.flatMap((file) => {
      const text = readFileSync(file, 'utf-8');
      return [...text.matchAll(/>([^<>{}][^<>{}]*)</g)]
        .map((match) => match[1]!.trim())
        .filter((literal) => /[A-Za-z]/.test(literal));
    });

    assert.deepEqual(
      literals.filter(
        (literal) => !ALLOWED_LITERAL_PATTERNS.some((pattern) => pattern.test(literal)),
      ),
      [],
    );
  });
});
