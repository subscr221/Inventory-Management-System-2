# Formatting Rules

## Document Format

- One H1 title as first line (MD041, MD025)
- Heading levels increment sequentially (MD001)
- ATX-style headings only (MD003)
- Blank line above and below headings (MD022)
- No bare `###` dividers; use headings or `---` (NO-HR-DIVIDER-HASHES)

## Typography

- Hyphens instead of em dashes (NO-EMDASH)
- No arrows in prose; spell out relationships. Code operators exempt (NO-ARROWS-UNICODE, NO-ARROWS-ASCII)
- Body: Noto Sans 11pt; line spacing 1.15 (EXPORT)

## Tables

- Header row required; exempt from line-length limit (MD013)
- Headers centered and bold (EXPORT)
- Black and white only (EXPORT)
- Minimal padding, shrink-to-fit (EXPORT)
- Reference every table by name in prose (AUTHOR)

## Page Setup

- A4 portrait default (EXPORT)
- Landscape/A3 section breaks for wide content (EXPORT)

## Numbering

- Ordered lists: `1.`, `2.`, `3.` only (MD029)
- Unordered lists: `-`, 2-space nesting (MD004, MD007)
- One space after list marker (MD030)
- Exported: `1.`, `(a)`, `(i)` with 0.06" tabs (EXPORT)

## Captions

- `Figure X:` / `Table X:` + description; auto-numbered by pandoc-crossref (AUTHOR+EXPORT)
- Noto Sans 10pt italic (EXPORT)

## Links

- No bare URLs; wrap as `[text](url)` or `<url>` (MD034)
- No empty links (MD042)
- No spaces in link brackets (MD039)
- All references must resolve (MD051-MD054)

## Diagrams

- draw.io source + adjacent PNG, black-and-white (AUTHOR)
- Store in `Diagrams_<project>` (AUTHOR)
- Name: `Document_DiagramName_DDMMYYYY_HHMM` (AUTHOR)
- Track in `Traceability/Diagram_Document_Traceability.csv` (AUTHOR)

## Before Finishing

1. Single H1, clean heading hierarchy
2. Remove em dashes, arrows, bare `###` dividers
3. Wrap bare URLs
4. Reference every new table/figure
