# todo-harness

A cross-session TODO backlog for Claude Code, enforced by hooks rather than by
good intentions.

Claude forgets everything between sessions. The usual fix — "remember to write
notes" — fails the moment a session ends in a hurry. This makes it structural:

- **SessionStart** injects the project's open items into context, numbered and
  budget-capped, so a new session resumes where the last one stopped.
- **Stop** blocks a session that changed files but left the backlog untouched.

The backlog is a plain Markdown file committed to the repo, so it is shared
with the team through git — not stored in anyone's local Claude state.

## Install

```
/plugin marketplace add <your-org>/todo-harness
/plugin install todo-harness
```

On the first session in a repo it creates `docs/TODO.md`, adds a `merge=union`
line to `.gitattributes`, and appends a short section to `CLAUDE.md`. Commit
those so teammates inherit the convention.

## The backlog file

```markdown
## Open — active

- **Ship the export route.** Blocked on the font licence question.
- **Password reset.** Code done; one dashboard step left.

## Open — backlog

- **Refactor the PDF layer.** Not scheduled; notes in Docs/pdf.md.

## Done (2026-08-07) — export route

- Shipped. Charges once per deed via a partial unique index.
```

Every heading starting with `## Open` is collected; `## Done` never is. Two
sections are conventional — **active** and **backlog** — with active first, so
the low numbers are always live work.

At session start that becomes:

```
Open items carried over from previous sessions (docs/TODO.md), numbered 1–3 …

### active
1. **Ship the export route.** Blocked on the font licence question.
2. **Password reset.** Code done; one dashboard step left.

### backlog
3. **Refactor the PDF layer.** Not scheduled; notes in Docs/pdf.md.
```

You can then say "do item 2" and be understood.

## Rules that keep it working

- **Write items as `- ` bullets.** A section written as prose injects only its
  heading — its content is silently lost.
- **Front-load each item.** Only the first ~300 chars are injected: lead with
  what it *is*, then the rationale.
- **Move finished work to a `## Done` heading.** Struck-through items left
  under `## Open` spend injection budget and push real work past the cap.
- **Never number items in the file.** Numbers are positional and would
  renumber on every insert — precisely what conflicts under `merge=union`.
  The hook numbers the injection instead.

`## Done` costs nothing: it never enters context. Don't prune it to save
tokens — keep it for the history.

## Budget

The backlog may grow without bound; the injection may not. Defaults, at the top
of `hooks/todo.mjs`:

| Constant | Default | Meaning |
|---|---|---|
| `MAX_INJECT_CHARS` | 6000 (~1.5k tokens) | Total injection budget |
| `MAX_ITEM_CHARS` | 300 | Per-item clip, at a sentence boundary |

Budgeting by characters rather than item count is deliberate: a handful of
long prose entries can otherwise spend 25 KB before the rest are reached.
Anything cut is pointed at, never silently dropped.

## Where the backlog lives

Auto-detected from what git tracks — `docs/TODO.md`, `Docs/TODO.md` or
`TODO.md`, whichever the repo already uses. New repos get `docs/TODO.md`.

This matters more than it looks. Git matches `.gitattributes` patterns
case-sensitively, and `existsSync` is case-sensitive on Linux, so a hardcoded
`docs/` in a repo tracking `Docs/` fails **silently** — no error, just an
inert `merge=union` line and an empty injection on CI. Both are resolved from
the tracked spelling instead of assumed.

## Opting out

Create `.claude/no-todo-harness` in a repo the harness should leave alone.

## Precedence

A repo's own `.claude/hooks/todo.mjs` always wins; the plugin stands down when
it finds one, so exactly one copy runs. That lets a project pin a modified
harness without uninstalling the plugin.

## Requirements

Node (any version with ES modules) and git. No dependencies.
