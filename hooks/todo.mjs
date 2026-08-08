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

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const SELF = fileURLToPath(import.meta.url)
// Set by Claude Code when this runs from an installed plugin. Distinguishes
// "the plugin owns the hook" from the standalone modes (a global copy in
// ~/.claude/hooks, or a copy vendored into one repo).
const IS_PLUGIN = !!process.env.CLAUDE_PLUGIN_ROOT
const TODO_DEFAULT = 'docs/TODO.md'
const OPT_OUT = '.claude/no-todo-harness'
const MARK = 'todo.mjs' // marker used to detect our hook entries in settings.json

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

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
    if (tracked) return tracked
  } catch {
    // not a repo yet, or git unavailable — fall through
  }
  // Untracked but present (first session after someone created it by hand).
  for (const c of [TODO_DEFAULT, 'Docs/TODO.md', 'TODO.md']) {
    if (existsSync(join(root, c))) return c
  }
  return TODO_DEFAULT
}

const TEMPLATE = `# TODO — carried across sessions

Persistent backlog for this project. Claude reads this at session start and is
blocked from ending a session that changed files but left this untouched.

Write entries a teammate who wasn't here could act on: what's left and **where to
resume**, not just a task name.

## Open

- [ ] _(nothing yet — first session will fill this in)_

## Done

_(completed work, newest first, with the date it landed)_
`

const CLAUDE_SECTION = `## Cross-session TODO

\`docs/TODO.md\` is the persistent backlog — the only handoff between sessions, and
shared with the team through git. It is enforced by hooks, not by good intentions
(\`.claude/hooks/todo.mjs\`, wired in \`.claude/settings.json\`):

- **SessionStart** injects the open items into context.
- **Stop** blocks the session from ending if it changed files but left
  \`docs/TODO.md\` untouched. When blocked: record what's unfinished under \`## Open\`,
  move finished work to \`## Done\` with today's date, then finish.

\`.gitattributes\` sets \`merge=union\` on the file so parallel appends don't conflict.
`

function ensureFile(path, contents) {
  if (existsSync(path)) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return true
}

// `ci` for path needles: a repo tracking `Docs/TODO.md` that already has a
// stale `docs/TODO.md` line must not get a second, near-identical entry — the
// duplicate this exact bug produced in .gitattributes on 2026-08-07.
function appendOnce(path, needle, block, ci = false) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const haystack = ci ? existing.toLowerCase() : existing
  if (haystack.includes(ci ? needle.toLowerCase() : needle)) return false
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
  for (const [event, mode] of [['SessionStart', 'start'], ['Stop', 'stop']]) {
    cfg.hooks[event] ??= []
    const already = JSON.stringify(cfg.hooks[event]).includes(MARK)
    if (already) continue
    cfg.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command: cmd(mode), timeout: 10 }] })
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
  if (ensureFile(join(root, TODO_REL), TEMPLATE)) made.push(TODO_REL)
  if (
    appendOnce(
      join(root, '.gitattributes'),
      TODO_REL,
      `# Shared append-heavy backlog: keep both sides on merge instead of conflicting.\n` +
        `# Path is case-sensitive to git — it must match the tracked spelling.\n` +
        `${TODO_REL} merge=union\n`,
      true, // case-insensitive: don't duplicate a stale docs/ vs Docs/ line
    )
  )
    made.push('.gitattributes')
  if (appendOnce(join(root, 'CLAUDE.md'), 'Cross-session TODO', CLAUDE_SECTION)) made.push('CLAUDE.md')

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
    if (patchSettings(root)) made.push('.claude/settings.json')
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
const MAX_ITEM_CHARS = 300    // enough to identify the task and its file paths

// First sentence (or hard clip) — enough to recognise the item and decide
// whether to open the file, without carrying its full rationale.
function clip(text, max = MAX_ITEM_CHARS) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' — '), cut.lastIndexOf('; '))
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd()) + ' […]'
}

// Open items, with wrapped continuation lines folded back into one line each.
//
// Collects EVERY `## Open*` section, not just the first. `.find()` here used to
// silently discard the rest, so adding a second `## Open — <topic>` heading
// above the main backlog hid 350+ lines of real work from every session.
function openItems(root) {
  const path = join(root, TODO_REL)
  if (!existsSync(path)) return null
  const sections = readFileSync(path, 'utf8')
    .split(/^## /m)
    .filter((s) => s.startsWith('Open'))
  if (!sections.length) return []

  const items = []
  for (const section of sections) {
    const lines = section.split('\n')
    // Heading text, so an item from `## Open — auth audit` is attributable
    // once merged with items from other Open sections.
    const topic = lines[0].replace(/^Open\s*[—-]?\s*/, '').trim()
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
    const out = execFileSync('git', ['log', `-n${n}`, '--name-only', '--pretty=format:'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
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
        `Commit these so teammates inherit it. The backlog lives at ${TODO_REL} and stays project-local.`
    )
  }
  const items = openItems(root)
  if (items && items.length) {
    // Clip each item, then take as many as fit the budget.
    const shown = []
    let spent = 0
    for (const item of items) {
      const text = clip(item.text)
      if (spent + text.length > MAX_INJECT_CHARS) break
      shown.push({ topic: item.topic, text })
      spent += text.length
    }

    // Number CONTINUOUSLY across sections, not per-section: the number is a
    // handle the user says out loud ("do item 7"), so it has to be unique in
    // the whole list, not just within one heading. Assigned before grouping so
    // it reflects file order rather than group order.
    //
    // Numbers live only in this injection, never in TODO.md itself: the file
    // is `merge=union` in .gitattributes, and hand-numbered lists renumber
    // every item below an insert — which is exactly the shape that conflicts.
    shown.forEach((item, i) => {
      item.n = i + 1
    })

    // Group under their headings so multiple `## Open — <topic>` sections stay
    // distinguishable once flattened into one list.
    const byTopic = new Map()
    for (const item of shown) {
      const key = item.topic || 'General'
      if (!byTopic.has(key)) byTopic.set(key, [])
      byTopic.get(key).push(item)
    }
    const body = [...byTopic]
      .map(([topic, group]) => {
        const lines = group
          // Swap the leading `- ` for `N. ` — the source stays a plain bullet.
          .map((it) => `${it.n}. ${it.text.replace(/^-\s*/, '')}`)
          .join('\n')
        return `\n### ${topic}\n${lines}`
      })
      .join('\n')

    const omitted = items.length - shown.length
    const tail = omitted
      ? `\n\n(+${omitted} more open item(s) not shown, and entries above are truncated — read ${TODO_REL} for the full backlog.)`
      : `\n\n(Entries may be truncated — read ${TODO_REL} for full detail.)`
    console.log(
      `Open items carried over from previous sessions (${TODO_REL}), numbered ${shown[0].n}–${shown[shown.length - 1].n} ` +
        `in file order — you can refer to them by number this session. Resume from these, and update the file before it ends:` +
        `${body}${tail}`
    )
  } else {
    console.log(`${TODO_REL}: no open items.`)
  }
  process.exit(0)
}

if (mode === 'stop') {
  const input = readStdin()
  if (input.stop_hook_active) process.exit(0) // already blocked once; never twice

  const changed = changedFiles(root)
  if (!changed || changed.length === 0) process.exit(0)
  // Case-insensitive: this repo tracks the file as `Docs/TODO.md`, and
  // `git status --porcelain` reports the tracked spelling, so a case-sensitive
  // endsWith() never matches and the stop is blocked forever no matter how
  // many times the backlog is actually updated.
  if (changed.some((f) => f.toLowerCase().endsWith(TODO_REL.toLowerCase()))) process.exit(0)
  if (recentlyCommitted(root, TODO_REL)) process.exit(0)

  console.error(
    `This session changed ${changed.length} file(s) but left ${TODO_REL} untouched.\n` +
      `Before finishing: record what is still unfinished under "## Open", and move anything ` +
      `completed to "## Done" with today's date. Then stop again.\n` +
      `Changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', …' : ''}`
  )
  process.exit(2) // exit 2 = block the stop, feed stderr back to Claude
}

process.exit(0)
