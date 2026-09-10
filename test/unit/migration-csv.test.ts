import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../src/migration/csv.js';
import {
  OPENING_STOCK_TEMPLATE_V1,
  assertOpeningStockTemplateHeader,
  openingStockContentHash,
  toTemplateRowV1,
} from '../../src/migration/opening-stock-template.js';

// Story 13.1 Task 3.1: the RFC 4180 parser the opening-stock import route reads files through.

describe('Story 13.1 migration CSV parser', () => {
  it('parses a header and plain rows with 1-based physical line numbers', () => {
    const out = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    assert.deepEqual(out.header, ['a', 'b', 'c']);
    assert.deepEqual(
      out.rows.map((r) => [r.line_no, r.cells]),
      [
        [2, ['1', '2', '3']],
        [3, ['4', '5', '6']],
      ],
    );
    assert.deepEqual(out.errors, []);
  });

  it('keeps a quoted comma inside one cell', () => {
    const out = parseCsv('a,b\n"x, y",z\n');
    assert.deepEqual(out.rows[0]!.cells, ['x, y', 'z']);
  });

  it('unescapes a doubled quote inside a quoted cell', () => {
    const out = parseCsv('a,b\n"12"" pipe",z\n');
    assert.deepEqual(out.rows[0]!.cells, ['12" pipe', 'z']);
  });

  it('accepts CRLF line endings and a stripped BOM', () => {
    const out = parseCsv('﻿a,b\r\n1,2\r\n3,4\r\n');
    assert.deepEqual(out.header, ['a', 'b']);
    assert.deepEqual(
      out.rows.map((r) => r.cells),
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    assert.equal(out.rows[1]!.line_no, 3);
  });

  it('keeps an empty trailing field and tolerates a missing final newline', () => {
    const out = parseCsv('a,b,c\n1,2,');
    assert.deepEqual(out.rows[0]!.cells, ['1', '2', '']);
  });

  it('skips blank lines without shifting later line numbers', () => {
    const out = parseCsv('a,b\n\n1,2\n   \n3,4\n');
    assert.deepEqual(
      out.rows.map((r) => [r.line_no, r.cells]),
      [
        [3, ['1', '2']],
        [5, ['3', '4']],
      ],
    );
  });

  it('reports an unterminated quote as a row-level error and keeps the file', () => {
    const out = parseCsv('a,b\n1,2\n"open,3\n');
    assert.deepEqual(
      out.rows.map((r) => r.cells),
      [['1', '2']],
    );
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0]!.line_no, 3);
    assert.equal(out.errors[0]!.reason, 'UNTERMINATED_QUOTE');
  });

  it('reports a stray quote in an unquoted cell as INVALID_QUOTE and still parses the next row', () => {
    const out = parseCsv('a,b\nab"c,2\n3,4\n');
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0]!.line_no, 2);
    assert.equal(out.errors[0]!.reason, 'INVALID_QUOTE');
    assert.deepEqual(
      out.rows.map((r) => [r.line_no, r.cells]),
      [[3, ['3', '4']]],
    );
  });

  it('records the raw source text of each row for the rejected-row report', () => {
    const out = parseCsv('a,b\r\n"x, y",z\r\n');
    assert.equal(out.rows[0]!.raw, '"x, y",z');
  });

  it('parses a 10,000-row file in under one second', () => {
    const lines = [OPENING_STOCK_TEMPLATE_V1.join(',')];
    for (let i = 0; i < 10_000; i++) {
      lines.push(
        `SITE-A,BIN-${i % 50},SKU-${i % 200},LOT-${i},,${(i % 7) + 1}.000000,KG,owned,12.5000,,2026-09-01,PV-${i},${i}`,
      );
    }
    const text = lines.join('\n') + '\n';
    const started = process.hrtime.bigint();
    const out = parseCsv(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    assert.equal(out.rows.length, 10_000);
    assert.equal(out.errors.length, 0);
    assert.ok(elapsedMs < 1000, `parse took ${elapsedMs.toFixed(1)} ms`);
  });
});

describe('Story 13.1 opening-stock template v1', () => {
  it('accepts the exact v1 header after trimming and refuses any other order', () => {
    assert.doesNotThrow(() =>
      assertOpeningStockTemplateHeader(
        'v1',
        [...OPENING_STOCK_TEMPLATE_V1].map((h) => ` ${h} `),
      ),
    );
    const swapped = [...OPENING_STOCK_TEMPLATE_V1];
    [swapped[5], swapped[8]] = [swapped[8]!, swapped[5]!];
    assert.throws(
      () => assertOpeningStockTemplateHeader('v1', swapped),
      (err: unknown) =>
        (err as { errorCode: string }).errorCode === 'TEMPLATE_VERSION_UNSUPPORTED' &&
        Array.isArray((err as { details: { expected_header: unknown } }).details.expected_header),
    );
    assert.throws(
      () => assertOpeningStockTemplateHeader('v2', [...OPENING_STOCK_TEMPLATE_V1]),
      (err: unknown) => (err as { errorCode: string }).errorCode === 'TEMPLATE_VERSION_UNSUPPORTED',
    );
  });

  it('maps cells onto v1 column names and hashes normalised content', () => {
    const cells = OPENING_STOCK_TEMPLATE_V1.map((c) => ` ${c}-v `);
    const row = toTemplateRowV1(cells);
    assert.equal(row.sku, 'sku-v');
    assert.equal(row.pv_line_ref_ext, 'pv_line_ref_ext-v');
    assert.equal(
      openingStockContentHash(cells),
      openingStockContentHash(cells.map((c) => c.trim())),
    );
    assert.notEqual(openingStockContentHash(cells), openingStockContentHash([...cells].reverse()));
  });
});
