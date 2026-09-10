import { createHash } from 'node:crypto';
import { AppError } from '../middleware/error.js';

/**
 * Story 13.1 (Task 3.2): the opening-stock import template contract.
 *
 * Column ORDER and NAMES are the version (Binding Decision 11). A file whose trimmed header does
 * not match byte-for-byte is refused whole with 400 TEMPLATE_VERSION_UNSUPPORTED; looser matching
 * is how a `unit_cost` column ends up read as `quantity`. A second template version is a second
 * constant registered in OPENING_STOCK_TEMPLATES, never a looser match on this one.
 */
export const OPENING_STOCK_TEMPLATE_V1 = [
  'site_code',
  'location_code',
  'sku',
  'lot_number',
  'serial_number',
  'quantity',
  'uom',
  'stock_class',
  'unit_cost',
  'expiry_date',
  'counted_on',
  'pv_ref_ext',
  'pv_line_ref_ext',
] as const;

export type OpeningStockColumnV1 = (typeof OPENING_STOCK_TEMPLATE_V1)[number];

export const OPENING_STOCK_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  v1: OPENING_STOCK_TEMPLATE_V1,
};

/** The file-level row cap (Open Question 3); the 10 MB body cap is src/middleware/body.ts's. */
export const MAX_OPENING_STOCK_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_BODY_BYTES = 10 * 1024 * 1024;

/** A v1 row with every cell trimmed; empty cells are empty strings, never undefined. */
export type OpeningStockTemplateRowV1 = Record<OpeningStockColumnV1, string>;

/**
 * Refuses a file whose header is not exactly the named template version. `details` carries the
 * expected and received headers so the migration lead can diff them.
 */
export function assertOpeningStockTemplateHeader(
  templateVersion: unknown,
  header: readonly string[],
): readonly string[] {
  const expected =
    typeof templateVersion === 'string' ? OPENING_STOCK_TEMPLATES[templateVersion] : undefined;
  if (!expected) {
    throw new AppError(
      400,
      'TEMPLATE_VERSION_UNSUPPORTED',
      `template_version must be one of ${Object.keys(OPENING_STOCK_TEMPLATES).join(', ')}`,
      {
        template_version: templateVersion ?? null,
        supported_versions: Object.keys(OPENING_STOCK_TEMPLATES),
      },
    );
  }
  const received = header.map((h) => h.trim());
  const matches =
    received.length === expected.length && received.every((h, i) => h === expected[i]);
  if (!matches) {
    throw new AppError(
      400,
      'TEMPLATE_VERSION_UNSUPPORTED',
      `The file header does not match template ${String(templateVersion)}`,
      {
        template_version: templateVersion,
        expected_header: [...expected],
        received_header: received,
      },
    );
  }
  return expected;
}

/** Maps trimmed cells onto the v1 column names. The caller has already checked the cell count. */
export function toTemplateRowV1(cells: readonly string[]): OpeningStockTemplateRowV1 {
  const row = {} as OpeningStockTemplateRowV1;
  OPENING_STOCK_TEMPLATE_V1.forEach((column, index) => {
    row[column] = (cells[index] ?? '').trim();
  });
  return row;
}

/**
 * The row's content identity (Binding Decision 5): SHA-256 over the normalised cells joined by a
 * unit separator. Identical content re-submitted is DUPLICATE_EVENT (suppressed, AC 6); differing
 * content on a live grain is DUPLICATE_LOT_SERIAL in initial mode (AC 5) or a supersession in
 * correction mode. Trimming and the empty-cell canonical form mean whitespace edits do not mint
 * a new row.
 */
export function openingStockContentHash(cells: readonly string[]): string {
  const normalised = cells.map((c) => c.trim()).join('');
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/** The per-row event idempotency key (Task 3.5 g). */
export function openingStockRowIdempotencyKey(siteId: string, contentHash: string): string {
  return `migration:os:${siteId}:${contentHash}`;
}

/** SHA-256 of the whole file as submitted, recorded on the import header. */
export function fileSha256(csv: string): string {
  return createHash('sha256').update(csv, 'utf8').digest('hex');
}
