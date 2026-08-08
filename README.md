# todo-harness

A cross-session TODO backlog for Claude Code, enforced by hooks rather than by
good intentions.

Claude forgets everything between sessions. The usual fix — "remember to write
notes" — fails the moment a session ends in a hurry. This makes it structural:

- **SessionStart** injects the project's backlog into context — grouped,
  budget-capped, and minus anything another active session already has
  locked — so a new session resumes where the last one stopped, without
  duplicating work someone else is mid-way through.
- **Stop** blocks a session that changed files but left the backlog untouched.

The backlog is a plain Markdown file committed to the repo, so it is shared
with the team through git — not stored in anyone's local Claude state, and
safe for several sessions (or several people) to work against at once.

## Install

```
/plugin marketplace add MdYasinMollah/todo-harness
/plugin install todo-harness
```

On the first session in a repo it creates `docs/TODO.md`, adds a `merge=union`
line to `.gitattributes`, and appends a short section to `CLAUDE.md`. Commit
those so teammates inherit the convention.

## The backlog file

```markdown
## Backlog — active

- `#1` **Ship the export route.** Blocked on the font licence question.
- `#2` **Password reset.** Code done; one dashboard step left.

## Backlog — later

- `#3` **Refactor the PDF layer.** Not scheduled; notes in Docs/pdf.md.

## In Progress

- CLAIM #2 session abc123 2026-08-08T14:00:00.000Z "fixing the last dashboard step"

## Done

- `#4` **2026-08-07** Shipped the export route. Charges once per deed via a
  partial unique index.
```

Every heading starting with `## Backlog` is collected; `## In Progress` and
`## Done` never are. Multiple `## Backlog — <topic>` sections are conventional
for splitting active work from a longer-term list.

At session start that becomes:

```
Status: 2 Backlog item(s) (1 In Progress elsewhere), 1 Done.

Backlog items carried over from previous sessions (docs/TODO.md) — each is
tagged with its permanent #id, safe to reference by that id across sessions:

### active
#1 **Ship the export route.** Blocked on the font licence question.

(In Progress elsewhere (hidden here): #2 (session abc123, since ...).)
```

You can then say "do #1" and be understood — today, next week, or in a
completely different session.

## Item ids — and a deliberate break from the old rule

Earlier versions of this harness said "never number items in the file" —
numbers were positional, injected fresh each session, and would drift the
moment something above them was marked done. That rule still holds for
*positional* numbers.

This version assigns a **permanent** id instead: `` `#N` ``, from **one
shared sequence across both Backlog and Done** — not a separate format for
each. Written into the item's own line once, at creation, and never
reassigned — editing the item's wording later doesn't change its id, and
completing it doesn't relabel it: a Backlog item keeps the exact number it
already had once it's moved to Done. This is what makes two things possible
that positional numbering can't do:

- **Multi-session locking** (below) needs a key for an item that survives the
  item's own text being edited mid-claim.
- **A stable reference** — "fix #7" means the same thing next week, which a
  number recomputed fresh every session start cannot promise.

(An earlier iteration of this feature used a second tag shape, `` `#DN` ``,
for Done specifically. Dropped in favor of one format everywhere — two shapes
to keep straight was worse than the ambiguity it was solving. A repo carrying
old `#DN` tags migrates them onto the unified scheme automatically.)

The id is assigned by the hook itself (`assignIds`, run every `SessionStart`),
not hand-typed, so it doesn't reintroduce the original problem (manually
renumbering a list on every insert). If two sessions each add a new item
around the same moment and pick the same next id — the one race this can't
prevent outright — the very next `SessionStart` detects the duplicate and
reassigns it past the current max automatically. Narrower race, self-healing,
no distributed lock required.

## Multi-session locking

Running more than one Claude session against the same repo? Before starting a
Backlog item, append under `## In Progress`:

```
- CLAIM #<id> session <session-id> <ISO timestamp> "optional label"
```

The quoted label is optional but recommended — a session id alone tells a
future reader *who* claimed something, not *what* they were doing; the label
is what makes the log worth reading back later.

The next `SessionStart` in any other session hides that item instead of
picking it up too. Stopping early? Free it right away instead of waiting out
the expiry:

```
- RELEASE #<id> session <session-id> <ISO timestamp>
```

Locks auto-expire after 2 hours with no release needed — the constant is
`CLAIM_TTL_HOURS` at the top of `hooks/todo.mjs`.

**If a session crashes or gets closed/deleted mid-claim:** don't wait out the
timeout. The SessionStart message for other sessions shows exactly which
session id holds the lock — write a `RELEASE` line quoting *that* session's
id (not your own) and it frees immediately. The 2h expiry is only the
backstop for when nobody notices.

**When the item is fully finished:** delete its CLAIM/RELEASE line(s)
entirely, in the same edit that writes the `## Done` entry — the Done entry
is now the permanent record, so the lock lines are pure clutter once
resolved. This is the one deliberate exception to append-only, and it's safe
specifically because it's a single coordinated edit by the session that just
finished the item, not a routine action or something racing anyone else. If
you're only pausing an item that's still open, `RELEASE` but leave the pair —
it's a progress trail for whoever resumes it next.

Both lines are otherwise **append-only** — don't edit or delete a lock line
for any other reason. That's what keeps this safe under `merge=union`:
unioned appends from two branches always combine cleanly, but a same-line
edit from each side does not, and routine deletion risks the same problem
(one branch's delete can be silently undone by a union merge with a branch
that never saw it).

**On the race this can't prevent:** two sessions starting at the same instant
can still both see an item unclaimed and both write a `CLAIM` line before
either sees the other's — there's no lock that spans two independent sessions
here, only a file. This can't be eliminated, so instead of letting it fail
silently (one claim quietly "winning" while the other duplicates work), the
next `SessionStart` for *either* session detects it and prints an unmissable
warning naming both sessions and timestamps, so a human decides who
continues. The earliest claimant is still treated as the effective holder for
every *other* session's filtering — the warning is for the two sessions in
conflict, not a reason to change what everyone else sees.

**Put lock lines under `## In Progress`, nowhere else.** Only that section is
read, so a `CLAIM` or `RELEASE` appended to the wrong one does nothing — and
a misfiled `RELEASE` is the bad case: the item stays locked for the full TTL
with nothing saying why. Easy to do by hand, so `SessionStart` reports any it
finds outside the section and leaves them untouched (moving a line is exactly
the edit `merge=union` can't reconcile — that part is yours to do).

## Rules that keep it working

- **Write items as `- ` bullets.** A section written as prose injects only its
  heading — its content is silently lost.
- **Front-load each item.** Only the first ~300 chars are injected: lead with
  what it *is*, then the rationale.
- **Move finished work to `## Done`.** Struck-through items left under
  `## Backlog` spend injection budget and push real work past the cap.
- **Don't hand-edit a `` `#N` `` tag once assigned.** It's meant to be
  permanent; the hook assigns and repairs them, you shouldn't need to.

`## Done` costs nothing beyond a one-line count: full entries never enter
context. Don't prune it to save tokens — keep it for the history.

## Budget

The backlog may grow without bound; the injection may not. Defaults, at the top
of `hooks/todo.mjs`:

| Constant | Default | Meaning |
|---|---|---|
| `MAX_INJECT_CHARS` | 6000 (~1.5k tokens) | Total injection budget |
| `MAX_ITEM_CHARS` | 300 | Per-item clip, at a sentence boundary |
| `CLAIM_TTL_HOURS` | 2 | How long a lock holds before auto-expiring |

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

## Upgrading from an older backlog file

A repo still on the old `## Open` / `## Claims` names, with no ids at all, or
carrying old `` `#DN` `` Done tags, migrates automatically and idempotently on
the next `SessionStart` — headings are renamed in place (suffix preserved:
`## Open — active` → `## Backlog — active`), ids are assigned or converted,
nothing is deleted or reordered. Safe to run even if two clones migrate
independently.

## Opting out

Create `.claude/no-todo-harness` in a repo the harness should leave alone.

## Precedence

A repo's own `.claude/hooks/todo.mjs` always wins; the plugin stands down when
it finds one, so exactly one copy runs. That lets a project pin a modified
harness without uninstalling the plugin.

## Requirements

Node (any version with ES modules) and git. No dependencies.

## Licence

MIT — see [LICENSE](LICENSE).
