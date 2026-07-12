## Before Starting Any Task That Creates or Edits a Markdown File

Read this entire document first, before writing a single line. These rules
are a precondition for drafting, not a cleanup pass applied afterward. An
agent must:

1. Load this file into context before creating a new `.md` file or editing
   an existing one anywhere in this repository.
2. Apply every rule below while drafting: heading structure, hyphens
   instead of em dashes, no arrow characters or sequences in prose, table
   header rows, link formatting, and caption and traceability
   requirements.
3. Only use the "Before Finishing" checklist at the end of this document as
   a final verification pass, not as the first time these rules are
   applied.

## Document Format

1. Every document starts with exactly one H1 title as its first line.
   `[LINT]` (MD041, MD025)
2. Heading levels increment one at a time: H1, then H2, then H3, never
   skipping a level. `[LINT]` (MD001)
3. Use ATX-style headings (`#`, `##`, `###`), not Setext underlines.
   `[LINT]` (MD003)
4. Headings are surrounded by a blank line above and below. `[LINT]` (MD022)
5. A bare `###` (or more) line used only as a visual divider, with no
   heading text, is banned. Use a real heading with text, or a horizontal
   rule (`---`) if a plain divider is genuinely needed. `[LINT]`
   (`NO-HR-DIVIDER-HASHES`)

## Typography

1. Use a hyphen (`-`), not an em dash (`\u2014`), anywhere in prose.
   Rewrite the sentence if a hyphen reads awkwardly. `[LINT]`
   (`NO-EMDASH`)
2. Arrows are banned, both Unicode arrow characters (for example `\u2192`)
   and ASCII sequences such as `->`, `<-`, and `=>` used in prose. Spell
   out the relationship in words instead (for example "leads to" or "maps
   to"). Code fences and inline code spans are exempt for the ASCII form,
   since operators like `->` are legitimate syntax in many languages.
   `[LINT]` (`NO-ARROWS-UNICODE`, `NO-ARROWS-ASCII`)
3. Body text renders in Noto Sans, 11pt, with a clear heading-size
   hierarchy (H1 largest, H2 smaller, H3 smaller still). `[EXPORT]`
4. Line spacing is 1.15 throughout the body. `[EXPORT]`

## Tables

1. Every table must have a header row; table content is exempt from the
   line-length limit since reference tables often contain long URLs.
   `[LINT]` (MD013 `tables:false`)
2. Table header rows render centered and bold. `[EXPORT]`
3. Tables render in black and white only (no colored fills or borders).
   `[EXPORT]`
4. Table rows keep minimal vertical padding, and font size shrinks as
   needed so the table fits the page width without overflowing.
   `[EXPORT]`
5. Every table is referenced by its caption somewhere in the surrounding
   body text (for example, "see Table 2"). `[AUTHOR]`

## Page Setup

1. Default page size is A4, portrait orientation. `[EXPORT]`
2. Wide tables or diagrams that do not fit portrait width get a landscape
   (or A3) section break around just that content, then return to A4
   portrait afterward. `[EXPORT]`

## Numbering and Indentation

1. Ordered lists use sequential `1.`, `2.`, `3.` numbering, never mixed
   with `1)` style. `[LINT]` (MD029 `style:ordered`)
2. Unordered list items use a dash marker (`-`), indented 2 spaces per
   nesting level. `[LINT]` (MD004, MD007)
3. Exactly one space follows every list marker. `[LINT]` (MD030)
4. In exported documents, nested outline numbering follows `1.`, then
   `(a)`, then `(i)` at each deeper level, with a 0.06 inch tab after each
   marker. `[EXPORT]`

## Captions

1. Figure and table captions read `Figure X:` or `Table X:` followed by a
   short description, and are numbered automatically by the export
   pipeline (via `pandoc-crossref`). `[AUTHOR+EXPORT]`
2. Captions render in Noto Sans, 10pt, italic. `[EXPORT]`

## Links and References

1. No bare URLs; wrap every link as `[link text](url)` or an
   angle-bracketed autolink `<https://example.com>`. `[LINT]` (MD034)
2. No empty links (`[text]()`). `[LINT]` (MD042)
3. No spaces inside link-text brackets (`[ text ]` is invalid, use
   `[text]`). `[LINT]` (MD039)
4. Link fragments, reference-style link definitions, and image references
   must all resolve to something real in the document; no dangling
   references. `[LINT]` (MD051, MD052, MD053, MD054)

## Diagrams

1. Diagrams are authored in draw.io (`.drawio` source file) and exported
   as adjacent PNG images, black-and-white only, with a transparent or
   white background. `[AUTHOR]`
2. Diagram source and exported PNG files live in a per-project folder
   named `Diagrams_<project>` (for example, `Diagrams_RDI_Scheme` in this
   repository). `[AUTHOR]`
3. Diagram files are named `Document_DiagramName_DDMMYYYY_HHMM`, using the
   local date and time the diagram was last edited, filled in manually by
   the author (not auto-generated). `[AUTHOR]`

## Traceability

1. Every diagram is tracked in
   `Traceability/Diagram_Document_Traceability.csv`, recording which
   document and section reference it, and its current status. `[AUTHOR]`
2. Every table and figure inserted into a document must be referenced by
   name somewhere in that document's body text (see Tables rule 5 and
   Captions rule 1). `[AUTHOR]`

## Before finishing any task that creates or edits a `.md` file in this

repository, an agent must:

1. Confirm the file starts with a single H1 title and has a clean heading
   hierarchy.
2. Search the new/changed text for em dashes, arrow characters or
   sequences, and bare `###` divider lines, and remove them.
3. Wrap any bare URLs as proper links.
4. Reference every new table or figure by name in the surrounding prose.
