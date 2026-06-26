# Watchtower

Passive agent-supervision extension for **Antigravity** (VS Code-based IDE).

Built directly from `Watchtower_PRD.docx` (v0.1, draft for internal use). This repo implements all six development phases described in PRD §6, plus the Phase 0 de-risking spike.

---

## What it does

AI coding agents inside IDEs make broad, multi-file edits from short, vague prompts — and can silently break relationships between files the agent isn't tracking (e.g. resizing a frontend button accidentally desyncs the backend route it calls). Watchtower passively builds and maintains a JSON map of how your codebase's files and functions connect — within a language and across languages — plus a running change log, and uses that shared foundation to power four capabilities:

1. **Passive Connection-Break Detection** (`Alt+A`) — flags when a change breaks a tracked cross-file relationship.
2. **Change Logging Over Time** — records what changed, where, and whether it was reverted or repeated ("thrash").
3. **Prompt Refinement** (`Alt+P`) — rewrites a vague prompt into an explicit one, grounded in the map + log, output via a pseudo-terminal and auto-copied to your clipboard to paste into Antigravity.
4. **Context-Aware Chat** (`Alt+C`) — answers questions about the codebase grounded in real project structure and history, not generic explanation.

A small circular HUD shows passive-watch status at a glance (Off / Scanning / Watching / Flagged).

Mistral (cloud API) is used **only** as a reasoning layer on top of this data — refining prompts, answering questions, explaining flags. It never edits the relationship map or the codebase; map-building stays mechanical and deterministic.

---

## Repository layout

```
watchtower/
├── package.json              VS Code extension manifest (commands, keybindings, settings)
├── README.md                 This file
├── src/
│   ├── extension.js           Entry point — wires Alt+A / Alt+P / Alt+C + HUD together
│   ├── core/
│   │   ├── constants.js       Shared file names, HUD states, thresholds
│   │   ├── storage.js         All .watchtower/ JSON read/write goes through here
│   │   ├── pseudoTerminal.js  Shared output-channel UI for alt+p output & alt+c chat
│   │   └── watcher.js         File-save watching → incremental map update → detection
│   ├── parsers/
│   │   ├── parserRegistry.js  Plugin architecture + graceful fallback
│   │   ├── jsParser.js        JS/Node plugin (functions, calls, imports, fetch/Express routes)
│   │   └── pythonParser.js    Python plugin (defs, calls, imports, Flask/FastAPI routes)
│   ├── matcher/
│   │   └── routeMatcher.js    Language-agnostic route/string cross-language bridge
│   ├── map/
│   │   └── relationshipMap.js Full scan (Phase 1) + incremental update (Phase 2)
│   ├── log/
│   │   └── changeLog.js       Change recording, revert detection, thrash detection
│   ├── detection/
│   │   └── connectionBreakDetector.js   Flag logic, tunable via flagThreshold setting
│   ├── hud/
│   │   └── hud.js             Circular status webview (Off/Scanning/Watching/Flagged)
│   ├── prompt/
│   │   └── promptRefiner.js   Context-scoping for Alt+P + Mistral call
│   ├── chat/
│   │   └── chatAssistant.js   Context-retrieval for Alt+C + Mistral call
│   └── mistral/
│       └── mistralClient.js   Cloud API wrapper — advisory-only, never touches the map
├── test/
│   └── runTests.js            Zero-dependency assertion test suite (43 checks)
├── test-fixtures/
│   └── sample-project/        Small JS+Python fixture project used by tests
└── phase0-spike/
    └── spike.js                Standalone Phase 0 proof-of-concept (see below)
```

---

## Phase 0 — De-risking spike (standalone, run first)

Before any of the real extension code, `phase0-spike/spike.js` proves the core idea works in isolation: a JS-only relationship map + route matcher that catches a contrived frontend/backend break, with **no dependencies, no Mistral, no VS Code API**.

```bash
cd phase0-spike
node spike.js demo
```

This runs: scan (clean) → check (clean) → apply a contrived breaking edit → check again (flags it). Exit code 0 and a `✅ SUCCESS` line confirm the PRD's Phase 0 success check: *"Can it actually catch a contrived version of the original example — a frontend change breaking a tracked backend connection?"*

You can also run the steps individually: `node spike.js scan`, `node spike.js break`, `node spike.js check`.

---

## Running the test suite (Phases 1–5 core logic)

No install step needed — the extension has zero runtime dependencies outside the Node/VS Code standard library.

```bash
node test/runTests.js
```

This exercises, without needing a real VS Code host or network access:
- JS and Python parser plugins against fixture files
- The cross-language route matcher (JS frontend ↔ Python Flask backend)
- A full relationship-map build end-to-end
- An incremental update + connection-break detection cycle (the Phase 0 idea, now running through the real architecture) — including a regression test for adjacent same-path routes (e.g. `GET` and `PUT` on `/api/items/:id`) not bleeding parameters into each other
- Change-log revert detection and thrash detection
- Context-scoping logic used by prompt refinement and chat (no network call — fake context only)
- HUD HTML rendering for all four states

All 43 checks should pass (`node test/runTests.js` exits 0).

---

## Installing into Antigravity / VS Code for real use

Watchtower has zero npm dependencies, so there's no `npm install` step.

1. Copy (or symlink) the `watchtower/` folder into your extensions directory, e.g.:
   - macOS/Linux: `~/.vscode/extensions/watchtower-dev.watchtower-0.1.0`
   - Antigravity should follow the same VS Code extensions convention.
2. Reload the IDE window.
3. Run **Watchtower: Set Mistral API Key** from the command palette and paste in your Mistral cloud API key (stored via VS Code SecretStorage, not plaintext settings).
4. Open a project folder and press **Alt+A**. The HUD should appear and enter "Scanning," then settle into "Watching" once the first scan completes.

### Keybindings

| Key | Action |
| --- | --- |
| `Alt+A` | First press: one-time scan + build relationship map. Later presses: toggle passive watching on/off. |
| `Alt+P` | Select a rough prompt or code, then press to get a refined prompt (copied to clipboard). Requires Alt+A to have run at least once. |
| `Alt+C` | Open the context-aware chat prompt box. |

### Settings (`watchtower.*`)

- `mistralModel` — Mistral model name (default `mistral-large-latest`).
- `flagThreshold` — `strict` / `balanced` (default) / `lenient` — how aggressively connection breaks are flagged.
- `maxLogEntriesInPromptContext` — caps how much change-log history is pulled into Alt+P / Alt+C context, per PRD §5's open question about token-wasteful over-stuffing.

---

## Mapping to the PRD's development phases

| Phase | PRD Goal | Where it lives | Status |
| --- | --- | --- | --- |
| 0 | Prove the core detection idea | `phase0-spike/spike.js` | ✅ Built & validated (`node spike.js demo` → SUCCESS) |
| 1 | Relationship map + Alt+A first scan | `src/parsers/`, `src/matcher/`, `src/map/relationshipMap.js` (`buildFullMap`) | ✅ Built & tested |
| 2 | Change log + passive detection | `src/log/changeLog.js`, `src/detection/connectionBreakDetector.js`, `src/core/watcher.js` | ✅ Built & tested |
| 3 | Circular HUD | `src/hud/hud.js` | ✅ Built & tested (HTML rendering for all 4 states) |
| 4 | Prompt refinement (Alt+P) | `src/prompt/promptRefiner.js`, `src/mistral/mistralClient.js`, `src/core/pseudoTerminal.js` | ✅ Built & tested (context-scoping logic; Mistral call itself requires a live API key) |
| 5 | Context-aware chat (Alt+C) | `src/chat/chatAssistant.js`, same Mistral client + pseudo-terminal | ✅ Built & tested (retrieval logic; Mistral call itself requires a live API key) |
| 6 | Hardening & future hooks | Config surface (`flagThreshold`, `maxLogEntriesInPromptContext`), architecture comments throughout flagging SDK-hook-access as a future swap point | ✅ Addressed — this phase is explicitly open-ended in the PRD ("ongoing refinement based on real usage") |

**Note on what "Built" means here:** every phase's *mechanical* logic (parsing, matching, map building, diffing, flagging, thrash/revert detection, HUD states, context-scoping for the Mistral calls) is implemented and covered by the automated test suite, which doesn't require network access. The three points that call the live Mistral API (project summary, prompt refinement, chat answers) are implemented and call a real `https://api.mistral.ai` endpoint, but obviously need a real API key and a live VS Code extension host to exercise end-to-end — they're structured so the *context assembled for Mistral* is fully unit-testable independent of the network call itself.

---

## Design notes carried over from the PRD

- **One shared foundation, four views** (PRD §1.4, §2.2): every capability reads/writes the same `.watchtower/relationship-map.json` and `.watchtower/change-log.json` — there's no per-feature duplicate state.
- **Mistral is advisory-only** (PRD §1.4, §4.2): `mistralClient.js` only ever returns text for display; nothing it returns is fed back into `relationshipMap.js`'s map-building logic.
- **Graceful fallback** (PRD §2.3, §4.1): `parserRegistry.js` returns a `fallback: true` result for any file extension without a registered plugin (or if a plugin throws), so unsupported languages never block a scan — they're still eligible for the language-agnostic route/string matcher.
- **No screen automation in v1** (PRD §1.6, §4.2): refined prompts are written to the pseudo-terminal and the OS clipboard only; nothing simulates clicks or typing into Antigravity's own chat UI.
- **Built against the file-system layer, not an assumed agent hook** (PRD §1.5): `watcher.js` is a `FileSystemWatcher`-based implementation. Revisiting Antigravity's SDK hook surface is explicitly deferred to Phase 6 / future versions, per the PRD's open questions (§5).
