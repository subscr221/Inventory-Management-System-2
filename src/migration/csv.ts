/**
 * Story 13.1 (Task 3.1): a dependency-free RFC 4180 CSV parser for migration template files.
 *
 * Why hand-rolled: package.json carries `jose`, `pg` and `web-push` only and the house style adds
 * no dependency for a 150-line concern (Open Question 3). Scope is exactly what the opening-stock
 * template needs: quoted fields, doubled quotes inside quotes, CRLF and LF, a tolerated trailing
 * newline, and a stripped UTF-8 BOM. A row with malformed quoting is reported as a parse error
 * with its line number and NEVER aborts the file - the caller rejects that line as MALFORMED_ROW
 * and the good rows still load (AC 4). One deliberate narrowing of RFC 4180 serves that rule: a
 * quoted cell never spans lines here (no template column needs it), so a quote left open is closed
 * by the line end and reported for THAT line instead of swallowing the rest of the file.
 *
 * `line_no` is the PHYSICAL 1-based line on which a record starts (the header is line 1), so the
 * rejected-row report points the migration lead at the line they can find in their editor.
 */

export interface CsvRow {
  line_no: number;
  cells: string[];
  /** The record's source text verbatim (without its terminating newline). */
  raw: string;
}

export interface CsvParseError {
  line_no: number;
  reason: 'UNTERMINATED_QUOTE' | 'INVALID_QUOTE';
  raw: string;
}

export interface CsvParseResult {
  header: string[];
  rows: CsvRow[];
  errors: CsvParseError[];
}

/**
 * Parses `text` as RFC 4180 CSV. The first record is the header; every later record is a row.
 * Blank records (an empty line, or a line of only whitespace outside quotes) are skipped.
 */
export function parseCsv(text: string): CsvParseResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: {
    line_no: number;
    cells: string[];
    raw: string;
    error?: CsvParseError['reason'];
  }[] = [];

  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let recordStartLine = 1;
  let recordStart = 0;
  let line = 1;
  let error: CsvParseError['reason'] | undefined;
  let i = 0;
  const n = input.length;

  const endRecord = (end: number): void => {
    cells.push(field);
    const raw = input.slice(recordStart, end);
    const blank = !error && cells.length === 1 && cells[0]!.trim() === '';
    if (!blank) {
      const record: (typeof records)[number] = { line_no: recordStartLine, cells, raw };
      if (error) record.error = error;
      records.push(record);
    }
    cells = [];
    field = '';
    quotedField = false;
    error = undefined;
  };

  while (i < n) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        // After a closing quote only a delimiter, a newline or end-of-input may follow.
        const next = input[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          error = error ?? 'INVALID_QUOTE';
        }
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        // A quoted cell that reaches a line end is unterminated FOR THIS TEMPLATE: no opening-stock
        // column legitimately spans lines, and treating the newline as the record end is what
        // keeps one bad quote from swallowing every later row of the file (AC 4).
        error = error ?? 'UNTERMINATED_QUOTE';
        inQuotes = false;
        const end = i;
        if (ch === '\r' && input[i + 1] === '\n') i += 1;
        i += 1;
        line += 1;
        endRecord(end);
        recordStart = i;
        recordStartLine = line;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length === 0 && !quotedField) {
        inQuotes = true;
        quotedField = true;
        i += 1;
        continue;
      }
      // A quote in the middle of an unquoted field, or a second quoted run in one field.
      error = error ?? 'INVALID_QUOTE';
      field += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      cells.push(field);
      field = '';
      quotedField = false;
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const end = i;
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      i += 1;
      line += 1;
      endRecord(end);
      recordStart = i;
      recordStartLine = line;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) error = 'UNTERMINATED_QUOTE';
  if (recordStart < n || field.length > 0 || cells.length > 0) endRecord(n);

  const header = records.length > 0 ? records[0]!.cells.map((c) => c.trim()) : [];
  const rows: CsvRow[] = [];
  const errors: CsvParseError[] = [];
  for (const record of records.slice(1)) {
    if (record.error) {
      errors.push({ line_no: record.line_no, reason: record.error, raw: record.raw });
    } else {
      rows.push({ line_no: record.line_no, cells: record.cells, raw: record.raw });
    }
  }
  return { header, rows, errors };
}
