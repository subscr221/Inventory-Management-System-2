# Agent Instructions

## Markdown Formatting Rules (load before writing, not after)

This repository has a mandatory formatting spec for every Markdown file:
`FORMATTING_RULES.md` (project root).

Load and apply `FORMATTING_RULES.md` at the start of any task that will
create a new `.md` file or edit an existing one, before drafting a single
line, not as a cleanup pass once the document exists. If a task plan
includes writing or editing Markdown, treat reading `FORMATTING_RULES.md`
as the first step of that plan.

The rules that most often get violated if applied only after the fact:

1. One H1 title as the first line; headings increment one level at a time
   (H1, H2, H3, never skipping a level).
2. Hyphens (`-`) instead of em dashes anywhere in prose.
3. No arrow characters or ASCII arrow sequences (`->`, `<-`, `=>`) in
   prose; code fences and inline code are exempt.
4. No bare `###` (or deeper) divider lines with no heading text; use a
   real heading or a `---` horizontal rule.
5. Every table has a header row and is referenced by name in the
   surrounding body text.
6. No bare URLs; wrap links as `[text](url)`.

See `FORMATTING_RULES.md` for the complete, authoritative rule set,
including export, page-setup, captioning, and traceability requirements.
That file's "Before Starting" section is a precondition for drafting; its
"Before Finishing" checklist is a final verification pass only, not the
first time these rules should be applied.
