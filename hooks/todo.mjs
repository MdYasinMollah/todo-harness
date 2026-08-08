#!/usr/bin/env node
// Cross-session TODO harness — global bootstrapper.
//
//   node ~/.claude/hooks/todo.mjs start  -> SessionStart: bootstrap project harness, inject open items
//   node ~/.claude/hooks/todo.mjs stop   -> Stop: block if the session changed code but not TODO.md
//
// The backlog itself is ALWAYS project-local (<repo>/docs/TODO.md) and committed,
// so teammates get it on clone. This global copy only ensures every project grows
// its own harness. Once a project has vendored its own .claude/hooks/todo.mjs,
// this global copy stands down and lets the project copy run.
//
// Never hard-fails: a broken hook must not be able to wedge a session.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
// Set by Claude Code when this runs from an installed plugin. Distinguishes
// "the plugin owns the hook" from the standalone modes (a global copy in
// ~/.claude/hooks, or a copy vendored into one repo).
const IS_PLUGIN = !!process.env.CLAUDE_PLUGIN_ROOT
const TODO_DEFAULT = 'docs/TODO.md'
const OPT_OUT = '.claude/no-todo-harness'
const MARK = 'todo.mjs' // marker used to detect our hook entries in settings.json
const CLAIM_TTL_HOURS = 2
const CLAIM_TTL_MS = CLAIM_TTL_HOURS * 60 * 60 * 1000

const git = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

// Project root = git toplevel. Returns null outside a repo (or when .git is
// renamed away, as some deploy scripts do) so we never touch loose directories.
function repoRoot() {
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  try {
    return resolve(git(['rev-parse', '--show-toplevel'], start))
  } catch {
    return null
  }
}

function isProtected(root) {
  const home = resolve(homedir())
  return root === home || root.startsWith(join(home, '.claude'))
}

// Which spelling of the backlog THIS repo uses. Case matters in two places
// that fail silently rather than erroring, so it is resolved once, from what
// git actually tracks, instead of hardcoded:
//
//   - `.gitattributes` patterns are matched case-sensitively by git, so a
//     `docs/TODO.md merge=union` line does nothing in a repo tracking `Docs/`.
//   - existsSync() is case-sensitive on Linux. A mismatch means the hook finds
//     no file and injects nothing — on CI or a teammate's box, not yours.
//
// Windows and macOS hide both, which is exactly why this went unnoticed in
// this repo until 2026-08-07.
function todoRel(root) {
  try {
    const tracked = git(['ls-files', '--full-name'], root)
      .split('\n')
      .find((f) => f.toLowerCase().endsWith('/todo.md') || f.toLowerCase() === 'todo.md')
    if (tracked) {
      return tracked
    }
  } catch {
    // not a repo yet, or git unavailable — fall through
  }
  // Untracked but present (first session after someone created it by hand).
  for (const c of [TODO_DEFAULT, 'Docs/TODO.md', 'TODO.md']) {
    if (existsSync(join(root, c))) {
      return c
    }
  }
  return TODO_DEFAULT
}

// Own section, own migration function (ensureInProgressSection) so a repo
// that bootstrapped before this existed gets it inserted without touching
// Backlog/Done.
const IN_PROGRESS_SECTION = `## In Progress

Append-only session locks, keyed by each item's permanent \`#N\` id (one
shared sequence across Backlog and Done — assigned once, shown next to the
item, never a content hash, so editing an item's wording never breaks its
lock). Never edit or delete a line here — union merge can't reconcile
in-place edits across sessions, only unioned appends. Formats:
\`- CLAIM #N session <session-id> <timestamp> "optional label"\`
\`- RELEASE #N session <session-id> <timestamp>\` (optional, only if you stop
early — a release from your own session cancels your own claim immediately)
The quoted label is optional but recommended: a future reader sees WHAT was
claimed, not just who/when — a session id alone answers "who," not "why."
Locks auto-expire after ${CLAIM_TTL_HOURS} hours with no release needed.

When the item is fully finished (moved to \`## Done\`): delete its CLAIM/
RELEASE line(s) from here entirely, in the same edit that writes the Done
entry — the Done entry is now the permanent record, the lock lines are pure
clutter once resolved. Safe specifically because it's one coordinated edit
by the session that just finished it, not a routine action or a race with
anyone. If only pausing an item that's still open, RELEASE but leave the
pair — it's a progress trail for whoever resumes it next.

If a session that claimed something gets closed, crashes, or is deleted
before finishing: don't wait out the timeout if you don't have to. The
SessionStart message shows which session id holds a locked item — write a
RELEASE line quoting THAT session's id (not your own) and it frees
immediately. The ${CLAIM_TTL_HOURS}h expiry is only the backstop for when
nobody notices.

`

const TEMPLATE = `# TODO — carried across sessions

Persistent backlog for this project. Claude reads this at session start and is
blocked from ending a session that changed files but left this untouched.

Write entries a teammate who wasn't here could act on: what's left and **where to
resume**, not just a task name.

## Backlog

- [ ] _(nothing yet — first session will fill this in)_

${IN_PROGRESS_SECTION}## Done

_(completed work, newest first, with the date it landed)_
`

const CLAUDE_SECTION = `## Cross-session TODO

\`docs/TODO.md\` is the persistent backlog — the only handoff between sessions, and
shared with the team through git. It is enforced by hooks, not by good intentions
(\`.claude/hooks/todo.mjs\`, wired in \`.claude/settings.json\`):

- **SessionStart** injects the backlog into context, minus any item another
  session currently has locked (see \`## In Progress\` below).
- **Stop** blocks the session from ending if it changed files but left
  \`docs/TODO.md\` untouched. When blocked: record what's unfinished under \`## Backlog\`,
  move finished work to \`## Done\` with today's date, then finish.

Every item — Backlog or Done — carries a permanent \`#N\` id from one shared
sequence, assigned once and never renumbered or reused: safe to say "fix #7"
across sessions or days even if the item's wording changes later, and no
second tag format to keep straight. A Backlog item keeps its own number when
it's completed and moved to Done — it doesn't get relabeled.

Running multiple sessions on this repo at once? Before starting a Backlog
item, append
\`- CLAIM #N session <id> <timestamp> "what you're about to do"\` under
\`## In Progress\` (the SessionStart message shows the exact line to copy; the
quoted label is optional but recommended — it's what makes the log useful
later, not just who/when). When it's fully finished, DELETE its CLAIM/
RELEASE line(s) from \`## In Progress\` entirely, in the same edit that
writes its \`## Done\` entry — the Done entry is now the permanent record, so
the lock lines are pure clutter (safe here specifically because it's one
coordinated edit by the session that just finished it). If only pausing an
item that's still open, \`RELEASE\` instead but leave the pair in place — a
progress trail for whoever resumes it next. Abandoning it early? Same rule:
\`RELEASE\` immediately — the ${CLAIM_TTL_HOURS}h auto-expiry is a crash
backstop, not a substitute for releasing.

\`.gitattributes\` sets \`merge=union\` on the file so parallel appends don't conflict.
`

function ensureFile(path, contents) {
  if (existsSync(path)) {
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return true
}

// Migrate a repo bootstrapped before this section existed: insert it right
// before "## Done" without touching Backlog/Done content. A structural
// insert, not a same-line edit, so it is safe to run once even if a
// teammate's clone does the same migration independently — guarded below.
function ensureInProgressSection(path) {
  if (!existsSync(path)) {
    return false
  }
  const content = readFileSync(path, 'utf8')
  if (/^## In Progress/m.test(content)) {
    return false
  }
  if (!/^## Done/m.test(content)) {
    writeFileSync(path, content.replace(/\s*$/, '\n\n') + IN_PROGRESS_SECTION)
    return true
  }
  writeFileSync(path, content.replace(/^## Done/m, IN_PROGRESS_SECTION + '## Done'))
  return true
}

// One-time heading rename for repos still on the old "## Open" / "## Claims"
// names (including this repo's own docs/TODO.md, created before this rename).
// Renames the heading LINE only — never touches item text below it — so it
// is a structural edit, not the kind of same-line content edit merge=union
// can't reconcile. Idempotent: no-ops once the new heading is already there.
//
// Keeps any suffix: `## Open — active (work on these now)` becomes
// `## Backlog — active (work on these now)`. Anchoring this to a bare
// `^## Open$` instead was a silent backlog-eater — the documented convention
// is multiple `## Open — <topic>` sections, so the rename would no-op on a
// real file while openItems moved on to looking for `## Backlog`, and every
// item in the repo would vanish from the injection with no error.
//
// Renames EVERY match, not just the first, for the same reason openItems
// collects every section: a file with both `## Open — active` and
// `## Open — backlog` must not come out half-migrated.
function renameHeadingOnce(path, fromHeading, toHeading) {
  if (!existsSync(path)) {
    return false
  }
  const content = readFileSync(path, 'utf8')
  const fromRe = new RegExp(`^## ${fromHeading}([ \\t]*(?:[—-][^\\n]*)?)$`, 'gm')
  if (!fromRe.test(content)) {
    return false
  }
  fromRe.lastIndex = 0
  writeFileSync(path, content.replace(fromRe, `## ${toHeading}$1`))
  return true
}

const ID_TAG_RE = /^-\s+`#(\d+)`\s+(.*)$/
// A CLAIM/RELEASE line, wherever it landed. These belong under
// `## In Progress`; the same shape appearing under any other heading is a
// misfiled lock line, not content — see assignIds and strayLockLines.
const LOCK_LINE_RE = /^-\s*(?:CLAIM|RELEASE)\s+#\d+\s+session\s+/i

// One-time, whole-file rewrite of legacy `#D<n>` (old Done-only) tags onto
// the unified `#N` scheme, run once before assignIds so it never sees a `#D`
// tag to worry about. Renumbers using the D-number's own order (D1 = oldest,
// preserved) so relative history stays readable, offset past whatever `#N`s
// already exist elsewhere (Backlog) so nothing collides. A plain whole-file
// regex replace is safe here specifically because `#D<n>` is a closed,
// unambiguous pattern that appears nowhere else in the file (never inside a
// CLAIM/RELEASE line, which are always plain `#<n>`).
function migrateLegacyDoneTags(path) {
  if (!existsSync(path)) {
    return false
  }
  const content = readFileSync(path, 'utf8')
  const dNums = [...new Set([...content.matchAll(/`#D(\d+)`/g)].map((m) => Number(m[1])))]
  if (!dNums.length) {
    return false
  }
  let maxPlain = 0
  for (const m of content.matchAll(/`#(\d+)`/g)) {
    maxPlain = Math.max(maxPlain, Number(m[1]))
  }
  const remap = new Map()
  let counter = maxPlain
  for (const d of dNums.sort((a, b) => a - b)) {
    counter += 1
    remap.set(d, counter)
  }
  const rewritten = content.replace(
    /`#D(\d+)`/g,
    (full, numStr) => `\`#${remap.get(Number(numStr))}\``,
  )
  writeFileSync(path, rewritten)
  return true
}

// Give every real Backlog/Done bullet a permanent `#N` id — one shared
// sequence across both sections, not two, so an item that completes just
// keeps the number it already had instead of getting relabeled. Assigned
// once, never renumbered, so it stays a valid reference (in conversation, in
// a CLAIM line) even after the item's own wording is edited. Self-healing:
// also repairs a duplicate id, which can only arise if two sessions each add
// a brand-new item (to either section) around the same time and both pick
// the same next number — a much narrower race than the per-session claim
// race this whole feature exists to prevent, and one this function fixes
// automatically on the very next SessionStart rather than needing a real
// distributed lock.
//
// Skips CLAIM/RELEASE-shaped lines wherever they land (not just under Done):
// tagging one as content would make a misfiled lock line look like a real
// Backlog/Done entry, inflate the counts, and hide it from strayLockLines.
//
// Operates on the `.split(/^## /m)` parts array (not string offsets) so
// mutating one section's line lengths can't desync the position of sections
// after it — the same trick `openItems` uses to survive multiple
// `## Backlog — <topic>` headings.
function assignIds(path) {
  if (!existsSync(path)) {
    return false
  }
  const parts = readFileSync(path, 'utf8').split(/^## /m)
  const isTaggable = (part) => part.startsWith('Backlog') || part.startsWith('Done')

  let globalMax = 0
  for (const part of parts) {
    if (!isTaggable(part)) {
      continue
    }
    for (const line of part.split('\n').slice(1)) {
      const m = ID_TAG_RE.exec(line)
      if (m) {
        globalMax = Math.max(globalMax, Number(m[1]))
      }
    }
  }

  let changed = false
  const usedIds = new Set()
  let counter = globalMax
  const newParts = parts.map((part) => {
    if (!isTaggable(part)) {
      return part
    }
    const lines = part.split('\n')
    const newLines = lines.map((line, i) => {
      if (
        i === 0 ||
        !/^- /.test(line) ||
        line.includes('_(nothing yet') ||
        line.includes('_(completed work') ||
        LOCK_LINE_RE.test(line)
      ) {
        return line
      }
      const m = ID_TAG_RE.exec(line)
      if (m) {
        const id = Number(m[1])
        if (!usedIds.has(id)) {
          usedIds.add(id)
          return line
        }
        // Duplicate — reassign past the known max, never colliding with
        // any id already present anywhere in the file.
        counter += 1
        changed = true
        return `- \`#${counter}\` ${m[2]}`
      }
      counter += 1
      changed = true
      return `- \`#${counter}\` ${line.replace(/^-\s+/, '')}`
    })
    return newLines.join('\n')
  })

  if (!changed) {
    return false
  }
  writeFileSync(path, newParts.join('## '))
  return true
}

// Total finished entries — the answer to "how many gaps are already fixed,"
// at a glance, without scrolling the whole Done log.
function countDone(root) {
  const path = join(root, TODO_REL)
  if (!existsSync(path)) {
    return 0
  }
  const section = readFileSync(path, 'utf8')
    .split(/^## /m)
    .find((s) => s.startsWith('Done'))
  if (!section) {
    return 0
  }
  return section
    .split('\n')
    .slice(1)
    .filter(
      (line) =>
        /^- /.test(line) &&
        !line.includes('_(completed work') &&
        // A misfiled CLAIM/RELEASE line is not completed work; counting it
        // would overstate Done for as long as it sits here.
        !LOCK_LINE_RE.test(line),
    ).length
}

// `ci` for path needles: a repo tracking `Docs/TODO.md` that already has a
// stale `docs/TODO.md` line must not get a second, near-identical entry — the
// duplicate this exact bug produced in .gitattributes on 2026-08-07.
function appendOnce(path, needle, block, ci = false) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const haystack = ci ? existing.toLowerCase() : existing
  if (haystack.includes(ci ? needle.toLowerCase() : needle)) {
    return false
  }
  writeFileSync(path, existing ? existing.replace(/\s*$/, '\n\n') + block : block)
  return true
}

// Add our SessionStart/Stop entries to the project's settings.json without
// disturbing hooks that are already there.
function patchSettings(root) {
  const path = join(root, '.claude', 'settings.json')
  let cfg = {}
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return false // malformed settings: leave it alone rather than clobber
    }
  }
  const cmd = (mode) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/todo.mjs" ${mode}`
  cfg.hooks ??= {}
  let changed = false
  for (const [event, mode] of [
    ['SessionStart', 'start'],
    ['Stop', 'stop'],
  ]) {
    cfg.hooks[event] ??= []
    const already = JSON.stringify(cfg.hooks[event]).includes(MARK)
    if (already) {
      continue
    }
    cfg.hooks[event].push({
      matcher: '',
      hooks: [{ type: 'command', command: cmd(mode), timeout: 10 }],
    })
    changed = true
  }
  if (changed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
  }
  return changed
}

function bootstrap(root) {
  const made = []
  if (ensureFile(join(root, TODO_REL), TEMPLATE)) {
    made.push(TODO_REL)
  }
  // Renames run before ensureInProgressSection: a repo already on "## Claims"
  // must be renamed to "## In Progress" in place, not left as-is while a
  // second, empty "## In Progress" section gets inserted alongside it.
  if (renameHeadingOnce(join(root, TODO_REL), 'Open', 'Backlog')) {
    made.push(`${TODO_REL} (renamed Open → Backlog)`)
  }
  if (renameHeadingOnce(join(root, TODO_REL), 'Claims', 'In Progress')) {
    made.push(`${TODO_REL} (renamed Claims → In Progress)`)
  }
  if (ensureInProgressSection(join(root, TODO_REL))) {
    made.push(`${TODO_REL} (added In Progress section)`)
  }
  // One-time only: converts old `#D<n>` tags onto the unified `#N` scheme.
  // Runs before assignIds so it never sees a legacy tag to worry about.
  if (migrateLegacyDoneTags(join(root, TODO_REL))) {
    made.push(`${TODO_REL} (migrated #D ids to unified #N scheme)`)
  }
  // Runs every bootstrap, not just once: it also repairs duplicate ids from
  // concurrent additions, so it must fire on every SessionStart, not be
  // guarded like the one-shot migrations above it.
  if (assignIds(join(root, TODO_REL))) {
    made.push(`${TODO_REL} (assigned/repaired ids)`)
  }
  if (
    appendOnce(
      join(root, '.gitattributes'),
      TODO_REL,
      `# Shared append-heavy backlog: keep both sides on merge instead of conflicting.\n` +
        `# Path is case-sensitive to git — it must match the tracked spelling.\n` +
        `${TODO_REL} merge=union\n`,
      true, // case-insensitive: don't duplicate a stale docs/ vs Docs/ line
    )
  ) {
    made.push('.gitattributes')
  }
  if (appendOnce(join(root, 'CLAUDE.md'), 'Cross-session TODO', CLAUDE_SECTION)) {
    made.push('CLAUDE.md')
  }

  // Vendor this script into the repo so teammates inherit the harness on clone.
  //
  // Skipped entirely when running as a plugin: the plugin already supplies the
  // hook and wires it through its own hooks.json, so copying it here would run
  // BOTH (double injection) and leave a stale copy that never sees the next
  // plugin update. In plugin mode the repo gets the backlog file and the
  // .gitattributes line — the shareable parts — and nothing else.
  if (!IS_PLUGIN) {
    const vendored = join(root, '.claude', 'hooks', 'todo.mjs')
    if (!existsSync(vendored)) {
      mkdirSync(dirname(vendored), { recursive: true })
      copyFileSync(SELF, vendored)
      made.push('.claude/hooks/todo.mjs')
    }
    if (patchSettings(root)) {
      made.push('.claude/settings.json')
    }
  }
  return made
}

// The backlog is allowed to grow without bound; the *injection* is not, or
// every session pays for the whole history before doing any work. The tail is
// pointed at, not dropped.
//
// Budget by CHARACTERS, not item count: this project's entries are prose
// paragraphs, several over 2,000 chars, so a count cap lets a handful of items
// spend 25KB. Each item is also clipped, so one essay cannot eat the budget
// and starve the items below it.
const MAX_INJECT_CHARS = 6000 // ~1.5k tokens
const MAX_ITEM_CHARS = 300 // enough to identify the task and its file paths

// First sentence (or hard clip) — enough to recognise the item and decide
// whether to open the file, without carrying its full rationale.
function clip(text, max = MAX_ITEM_CHARS) {
  if (text.length <= max) {
    return text
  }
  const cut = text.slice(0, max)
  const stop = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf(' — '),
    cut.lastIndexOf('; '),
  )
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd()) + ' […]'
}

// Backlog items, with wrapped continuation lines folded back into one line each.
//
// Collects EVERY `## Backlog*` section, not just the first. `.find()` here used
// to silently discard the rest, so adding a second `## Backlog — <topic>` heading
// above the main backlog hid 350+ lines of real work from every session.
function openItems(root) {
  const path = join(root, TODO_REL)
  if (!existsSync(path)) {
    return null
  }
  const sections = readFileSync(path, 'utf8')
    .split(/^## /m)
    .filter((s) => s.startsWith('Backlog'))
  if (!sections.length) {
    return []
  }

  const items = []
  for (const section of sections) {
    const lines = section.split('\n')
    // Heading text, so an item from `## Backlog — auth audit` is attributable
    // once merged with items from other Backlog sections.
    const topic = lines[0].replace(/^Backlog\s*[—-]?\s*/, '').trim()
    const before = items.length
    let collecting = false

    for (const line of lines.slice(1)) {
      // `- [ ]` checkboxes AND plain `- ` bullets: a backlog written in prose
      // (as this project's is) would otherwise report zero open items forever.
      if (/^\s*- \[x\]/i.test(line)) {
        collecting = false
      } else if (/^- /.test(line)) {
        items.push({ topic, text: line.trim() })
        collecting = true
      } else if (collecting && /^\s+\S/.test(line)) {
        items[items.length - 1].text += ' ' + line.trim()
      } else if (!line.trim()) {
        collecting = false
      }
    }

    // A section written as prose with no bullets contributes nothing above and
    // would vanish entirely — which is exactly how this bug went unnoticed.
    // Surface it by its heading so it is at least visible and followable.
    if (items.length === before && topic) {
      items.push({ topic, text: `- ${topic} — see ${TODO_REL} for detail.` })
    }
  }

  return items.filter((i) => !i.text.includes('_(nothing yet'))
}

// The item's permanent `#N` id, assigned by assignIds during
// bootstrap — this is the claim key. Returns null only for the rare
// synthetic "see file for detail" item openItems() fabricates for a
// prose-only section with no real bullet to tag.
function parseItemId(text) {
  const m = ID_TAG_RE.exec(text)
  return m ? Number(m[1]) : null
}

// Fallback identity for the id-less synthetic items above — content hash,
// same as the id system's first version. Not claimable in practice (nothing
// in the file to attach a `#N` tag to), but still needs a stable-ish key so
// it doesn't crash the display path.
function itemHash(text) {
  const normalized = text
    .replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '')
    .trim()
    .toLowerCase()
    .slice(0, 60)
  return createHash('sha1').update(normalized).digest('hex').slice(0, 8)
}

// `## In Progress` lines:
//   - CLAIM #N session <session-id> <ISO timestamp> "optional label"
//   - RELEASE #N session <session-id> <ISO timestamp>
// Malformed lines are ignored rather than thrown on — a hand-edited or
// partially-merged line must not crash the hook for every session after.
//
// Trailing quoted text on a CLAIM is an optional free-text label — what the
// session is actually working on, not just who/when. More useful for a
// future reader than a session id alone: a raw id says who, a label says
// what.
function parseLocks(root) {
  const path = join(root, TODO_REL)
  if (!existsSync(path)) {
    return { claims: [], releases: [] }
  }
  const section = readFileSync(path, 'utf8')
    .split(/^## /m)
    .find((s) => s.startsWith('In Progress'))
  if (!section) {
    return { claims: [], releases: [] }
  }
  const claims = []
  const releases = []
  for (const line of section.split('\n')) {
    const c = line.match(
      /^-\s*CLAIM\s+#(\d+)\s+session\s+(\S+)\s+(\S+)(?:\s+"([^"]*)")?/i,
    )
    if (c) {
      const ts = Date.parse(c[3])
      if (!Number.isNaN(ts)) {
        claims.push({ id: Number(c[1]), session: c[2], ts, label: c[4] || null })
      }
      continue
    }
    const r = line.match(/^-\s*RELEASE\s+#(\d+)\s+session\s+(\S+)\s+(\S+)/i)
    if (r) {
      const ts = Date.parse(r[3])
      if (!Number.isNaN(ts)) {
        releases.push({ id: Number(r[1]), session: r[2], ts })
      }
    }
  }
  return { claims, releases }
}

// CLAIM/RELEASE lines that landed outside `## In Progress`. parseLocks only
// reads that one section, so a misfiled lock line is otherwise inert: a
// CLAIM never locks, and — worse — a RELEASE never frees, leaving the item
// held for the full TTL with no visible reason. Both lines are hand-appended
// to a file whose own instruction is "append", so this is a slip worth
// catching rather than assuming away. Reported, never auto-moved: relocating
// a line is the one edit `merge=union` cannot reconcile across branches.
function strayLockLines(root) {
  const path = join(root, TODO_REL)
  if (!existsSync(path)) {
    return []
  }
  const stray = []
  for (const part of readFileSync(path, 'utf8').split(/^## /m)) {
    if (part.startsWith('In Progress')) {
      continue
    }
    const heading = part.split('\n')[0].trim()
    for (const line of part.split('\n').slice(1)) {
      // Match the tagged form too: an earlier version tagged these as Done
      // entries, so a repo upgrading from it can have `- \`#D7\` CLAIM #2 …`
      // already written into the file.
      const bare = line.replace(/^-\s+`#D?\d+`\s+/, '- ')
      if (LOCK_LINE_RE.test(bare)) {
        stray.push({ heading: heading || '(top of file)', line: line.trim() })
      }
    }
  }
  return stray
}

// Current lock holder per item id, or none if released/expired. A release
// from the SAME session at/after the claim's timestamp cancels it outright —
// that's the escape hatch for a session that grabs an item then decides not
// to do it, instead of it sitting locked for the full TTL.
//
// Two sessions claiming the same id before either has seen the other's
// claim (the one race this file-based design cannot prevent — no lock
// spans two sessions starting at the same instant) is detected here, not
// silently resolved: `active` still needs exactly one winner so other
// sessions know what's taken (earliest claim wins — first writer, not last
// writer, since "last" would mean a session's own claim can be evicted by
// someone else's later one without it ever finding out). `conflicts` carries
// every id with more than one distinct session actively claiming it, so the
// affected sessions get a loud warning instead of quietly duplicating work.
//
// Returns { active: Map<id, {session, ts}>, conflicts: Array<{id, sessions}> }.
function activeLocks(root, now) {
  const { claims, releases } = parseLocks(root)
  const bySessionPerId = new Map() // id -> Map<session, {ts, label} of that session's latest active claim>
  for (const c of claims) {
    const released = releases.some(
      (r) => r.id === c.id && r.session === c.session && r.ts >= c.ts,
    )
    const expired = now - c.ts >= CLAIM_TTL_MS
    if (released || expired) {
      continue
    }
    if (!bySessionPerId.has(c.id)) {
      bySessionPerId.set(c.id, new Map())
    }
    const bySession = bySessionPerId.get(c.id)
    const current = bySession.get(c.session)
    if (!current || c.ts > current.ts) {
      bySession.set(c.session, { ts: c.ts, label: c.label })
    }
  }

  const active = new Map()
  const conflicts = []
  for (const [id, bySession] of bySessionPerId) {
    if (bySession.size > 1) {
      conflicts.push({
        id,
        sessions: [...bySession].map(([session, v]) => ({
          session,
          ts: v.ts,
          label: v.label,
        })),
      })
    }
    let winner = null
    for (const [session, v] of bySession) {
      if (!winner || v.ts < winner.ts) {
        winner = { session, ts: v.ts, label: v.label }
      }
    }
    active.set(id, winner)
  }
  return { active, conflicts }
}

function changedFiles(root) {
  try {
    // NOTE: must not trim the whole output — porcelain lines start with a
    // significant space (" M file"), and trimming it shifts every path by one.
    const raw = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return raw
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).trim().replace(/\\/g, '/'))
      .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p)) // renames
  } catch {
    return null
  }
}

// Did a recent commit touch the backlog? Without this, committing your TODO
// update — the whole point of the file being shared through git — reads as
// "untouched" and blocks the stop forever, because the working tree can stay
// dirty for unrelated reasons the session never owned.
function recentlyCommitted(root, rel, n = 10) {
  try {
    // No pathspec here on purpose: `git log -nN -- <path>` counts N commits
    // *that touched the path*, which would match however far back it was and
    // pass forever. We want "did any of the last N commits touch it".
    const out = execFileSync(
      'git',
      ['log', `-n${n}`, '--name-only', '--pretty=format:'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    return out.split('\n').some((l) => l.trim().toLowerCase() === rel.toLowerCase())
  } catch {
    return false
  }
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

const mode = process.argv[2]
const root = repoRoot()

// Stand down: not a repo, protected dir, opted out, or the project vendored its
// own copy and this global one would just duplicate it.
//
// samePath, not `!==`: `git rev-parse --show-toplevel` echoes the casing from
// git's own records, which need not match how the path was resolved from disk
// (e.g. `F--Work-Station` vs `f--Work-Station` on Windows, or a mixed-case
// mount on macOS). Both name ONE directory, but a raw string compare calls
// them different — so the vendored copy mistook itself for the global one and
// stood down, injecting nothing at all. Case-fold on those platforms only;
// Linux paths really are case-sensitive.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
const samePath = (a, b) =>
  CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b

const vendoredHere = root && resolve(join(root, '.claude', 'hooks', 'todo.mjs'))

// A repo's own vendored copy always wins, whether the outsider is the global
// ~/.claude copy or the installed plugin. Exactly one of them must run: both
// firing means the open items are injected twice and the Stop check runs
// twice. Deferring to the repo also keeps a project that pinned a modified
// harness in control of its own behaviour.
//
// The vendored copy is wired through the project's own settings.json, so it
// still runs — this only silences the duplicate.
const isOutsideCopy = !samePath(resolve(SELF), vendoredHere || '')
if (
  !root ||
  isProtected(root) ||
  existsSync(join(root, OPT_OUT)) ||
  (isOutsideCopy && existsSync(vendoredHere))
) {
  process.exit(0)
}

// Resolved once, after the guard above proves we have a real repo. Everything
// below reads this rather than a hardcoded spelling.
const TODO_REL = todoRel(root)

if (mode === 'start') {
  const made = bootstrap(root)
  if (made.length) {
    console.log(
      `Bootstrapped the cross-session TODO harness for this project: ${made.join(', ')}. ` +
        `Commit these so teammates inherit it. The backlog lives at ${TODO_REL} and stays project-local.`,
    )
  }
  const input = readStdin()
  // Falls back to a pid-based id when the hook input carries no session_id
  // (older Claude Code builds, or a manual test invocation) — still unique
  // enough to tell "my claim" from "someone else's" within one run.
  const sessionId = input.session_id || `pid${process.pid}`

  const allItems = openItems(root)
  // id comes from the item's own permanent `#N` tag (assigned by
  // assignIds above, before this read) — stable across sessions and
  // across edits to the item's own wording. Only the rare synthetic
  // "see file for detail" item (prose section, no real bullet) falls back
  // to a content hash, since there is no line to tag.
  if (allItems) {
    allItems.forEach((i) => {
      i.id = parseItemId(i.text)
      if (i.id === null) {
        i.hash = itemHash(i.text)
      }
    })
  }

  const now = Date.now()
  const { active: locks, conflicts } = activeLocks(root, now)
  const lockedByOthers = new Map(
    [...locks].filter(([, lock]) => lock.session !== sessionId),
  )
  const items = allItems
    ? allItems.filter((i) => i.id === null || !lockedByOthers.has(i.id))
    : allItems
  const hidden = allItems ? allItems.filter((i) => !items.includes(i)) : []
  const summary =
    `Status: ${allItems ? allItems.length : 0} Backlog item(s) ` +
    `(${hidden.length} In Progress elsewhere), ${countDone(root)} Done.`

  // Two sessions can still claim the same item before either sees the
  // other's line — no file-based lock spans two sessions starting at the
  // same instant. This can't be prevented, only surfaced loudly instead of
  // silently letting one claim win and the other quietly duplicate work.
  // Shown to EVERY session (including the two conflicting ones — they may
  // not know their own claim collided) via a leading, unmissable line.
  const conflictWarning = conflicts.length
    ? `⚠ CLAIM CONFLICT — coordinate before continuing, only one should proceed:\n` +
      conflicts
        .map(
          (c) =>
            `  #${c.id}: ` +
            c.sessions
              .map((s) => {
                const what = s.label ? ` — "${s.label}"` : ''
                return `session ${s.session} (${new Date(s.ts).toISOString()}${what})`
              })
              .join(' AND '),
        )
        .join('\n') +
      `\n\n`
    : ''

  // A misfiled CLAIM/RELEASE is silent by construction — parseLocks reads
  // only `## In Progress`, so the line does nothing and nothing says why.
  // Prefixed onto the same warning block as conflicts so every output path
  // below carries it.
  const stray = strayLockLines(root)
  const strayWarning = stray.length
    ? `⚠ MISFILED LOCK LINE — these CLAIM/RELEASE lines are outside "## In Progress", ` +
      `so they have no effect (a CLAIM does not lock; a RELEASE does not free). ` +
      `Move each under "## In Progress" by hand:\n` +
      stray.map((s) => `  under "## ${s.heading}": ${s.line}`).join('\n') +
      `\n\n`
    : ''

  const warnings = `${strayWarning}${conflictWarning}`

  if (items && items.length) {
    // Clip each item, then take as many as fit the budget.
    const shown = []
    let spent = 0
    for (const item of items) {
      const text = clip(item.text)
      if (spent + text.length > MAX_INJECT_CHARS) {
        break
      }
      shown.push({ topic: item.topic, text, id: item.id, hash: item.hash })
      spent += text.length
    }

    // Group under their headings so multiple `## Backlog — <topic>` sections
    // stay distinguishable once flattened into one list.
    const byTopic = new Map()
    for (const item of shown) {
      const key = item.topic || 'General'
      if (!byTopic.has(key)) {
        byTopic.set(key, [])
      }
      byTopic.get(key).push(item)
    }
    const body = [...byTopic]
      .map(([topic, group]) => {
        const lines = group
          // `#N` is the item's permanent id — stable across sessions, safe to
          // say "fix #7" days later. Strip the raw `` `#N` `` tag from the
          // displayed text itself so it isn't shown twice.
          .map((it) => {
            const label = it.id !== null ? `#${it.id}` : `[${it.hash}]`
            // ID_TAG_RE needs the leading "- " still in place to match, so
            // it must run BEFORE the plain-bullet strip below (which would
            // otherwise remove that "- " first and make the tag unmatchable).
            const text = it.text.replace(ID_TAG_RE, '$2').replace(/^-\s*/, '')
            return `${label} ${text}`
          })
          .join('\n')
        return `\n### ${topic}\n${lines}`
      })
      .join('\n')

    const omitted = items.length - shown.length
    const hiddenNote = hidden.length
      ? ` In Progress elsewhere (hidden here): ${hidden
          .map((i) => {
            const lock = lockedByOthers.get(i.id)
            const what = lock.label ? ` — "${lock.label}"` : ''
            return `#${i.id} (session ${lock.session}, since ${new Date(lock.ts).toISOString()}${what})`
          })
          .join(', ')}.`
      : ''
    const tail = omitted
      ? `\n\n(+${omitted} more backlog item(s) not shown, and entries above are truncated — read ${TODO_REL} for the full backlog.${hiddenNote})`
      : `\n\n(Entries may be truncated — read ${TODO_REL} for full detail.${hiddenNote})`
    console.log(
      `${warnings}${summary}\n\n` +
        `Backlog items carried over from previous sessions (${TODO_REL}) — each is tagged with its permanent #id, ` +
        `safe to reference by that id across sessions. Resume from these, and update the file before it ends:` +
        `${body}${tail}\n\n` +
        `Before starting real work on one of these, append under ` +
        `"## In Progress" in ${TODO_REL}: \`- CLAIM #<id> session ${sessionId} ${new Date(now).toISOString()} ` +
        `"<what you're about to do>"\` (quoted label optional but recommended — a future reader sees WHAT was ` +
        `claimed, not just who/when) — mandatory, not just for concurrent sessions, since you can't know whether ` +
        `another one is running. Release it with a matching \`- RELEASE\` line the moment you finish or abandon ` +
        `it — don't rely on the ${CLAIM_TTL_HOURS}h auto-expiry, that's a crash backstop only.`,
    )
  } else if (hidden.length) {
    console.log(
      `${warnings}${summary}\n\n${TODO_REL}: no backlog items available — ${hidden.length} item(s) currently In Progress in another active session.`,
    )
  } else {
    console.log(`${warnings}${summary}\n\n${TODO_REL}: no backlog items.`)
  }
  process.exit(0)
}

if (mode === 'stop') {
  const input = readStdin()
  if (input.stop_hook_active) {
    process.exit(0)
  } // already blocked once; never twice

  const changed = changedFiles(root)
  if (!changed || changed.length === 0) {
    process.exit(0)
  }
  // Case-insensitive: this repo tracks the file as `Docs/TODO.md`, and
  // `git status --porcelain` reports the tracked spelling, so a case-sensitive
  // endsWith() never matches and the stop is blocked forever no matter how
  // many times the backlog is actually updated.
  if (changed.some((f) => f.toLowerCase().endsWith(TODO_REL.toLowerCase()))) {
    process.exit(0)
  }
  if (recentlyCommitted(root, TODO_REL)) {
    process.exit(0)
  }

  console.error(
    `This session changed ${changed.length} file(s) but left ${TODO_REL} untouched.\n` +
      `Before finishing: record what is still unfinished under "## Backlog", and move anything ` +
      `completed to "## Done" with today's date. Then stop again.\n` +
      `Changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', …' : ''}`,
  )
  process.exit(2) // exit 2 = block the stop, feed stderr back to Claude
}

process.exit(0)
