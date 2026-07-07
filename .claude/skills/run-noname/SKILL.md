---
name: run-noname
description: Launch this project's WebGPU app (npm run dev) and drive it in a real browser with a real WebGPU adapter to verify changes actually render. Use when asked to run, start, or screenshot the noname app, or to confirm a runtime/compiler change works end-to-end (not just tsc/tests) — including the Alt+drag numeric scrub interaction.
---

# Running noname in a real browser

This project has no `chromium-cli` and no bundled headless-browser tool.
`claude-in-chrome` also isn't reliably connected in every session. The
verified path is: **Playwright, launched with `channel: "chrome"`**, which
drives the system-installed Google Chrome and gets a real `GPUAdapter` —
not a software/SwiftShader fallback.

## 1. Start the dev server

```bash
npm run dev > /tmp/noname-dev.log 2>&1 &
for i in $(seq 1 20); do curl -sf http://localhost:8787/ >/dev/null && break; sleep 0.5; done
```

Stop it when done: `pkill -f "scripts/serve.mjs"`.

## 2. Get Playwright and the driver into one scratch directory

`playwright` is not a project dependency, and Node's ESM resolver looks
for packages next to the *script's own path* (not `cwd`, and NOT
`NODE_PATH` — that's CJS-only), so the driver must be copied alongside
wherever `playwright` gets installed:

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH" && npm init -y >/dev/null && npm install playwright@1.61.1 >/dev/null
cp /Users/takata/Work/noname/.claude/skills/run-noname/scripts/verify.mjs "$SCRATCH/"
```

## 3. Run the driver

```bash
cd "$SCRATCH"
node verify.mjs
node verify.mjs --scrub
node verify.mjs --url http://localhost:8787/ --out /tmp/shot.png
```

It waits for `#boot.ready`, confirms `navigator.gpu.requestAdapter()`
returns a real adapter, optionally exercises the Alt+drag numeric-scrub
gesture (mousedown+Alt over the first numeric literal in the editor, 60
rapid `mousemove`s, mouseup — this is the interaction ADR-0028's scrub
coalescing fix targets), reads `#fps`/`#status`, screenshots, and reports
console errors. Exits non-zero if the adapter is missing or a real
(non-favicon) console error appeared.

Read the screenshot afterward — a blank/black frame with `fps` still
ticking is a real bug, not a pass.

## Gotchas

- A `favicon.ico` 404 in the console is expected (this project ships no
  favicon) — the script already filters it out; don't treat it as a
  regression.
- `#status` text tells you which path a compile took: `swap NNms` (new
  GPU program), `uniform 更新のみ N.Nms` (fast path, ADR-0008), or an
  error message (ADR-0010: last-good program keeps rendering).
- To poke at internals from a driver script, `window.__noname` is the
  live `Renderer` instance (wired in `main.ts` for exactly this purpose).
