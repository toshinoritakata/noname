// IR スナップショット(golden)テスト(implementation.md 8章)。
// ソース → Field IR の文字列化を golden 比較してコンパイラの回帰を検出する。
// 更新: UPDATE_GOLDEN=1 node --test test/snapshot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { parse } from "../src/compiler/parser.ts";
import { stageProgram } from "../src/compiler/stage.ts";
import { EXAMPLES } from "../src/examples.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "golden");
mkdirSync(dir, { recursive: true });

function dumpExample(source: string): string {
  const p = parse(source);
  const st = stageProgram(p.program, source);
  if (!st.program) return "ERROR: " + JSON.stringify(st.diagnostics.map((d) => d.message));
  const prog = st.program;
  const parts: string[] = [];
  for (const sim of prog.sims) {
    parts.push(`== sim ${sim.handle.name} (${sim.handle.sig})`);
    sim.initRoots.forEach((r, i) => parts.push(`init[${i}] = ${prog.arena.dump(r)}`));
    sim.updateRoots.forEach((r, i) => parts.push(`update[${i}] = ${prog.arena.dump(r)}`));
  }
  for (const rm of prog.raymarches) {
    parts.push(`== raymarch ${rm.id}`);
    parts.push(`dist = ${prog.arena.dump(rm.dist)}`);
    parts.push(`colour = ${prog.arena.dump(rm.colour)}`);
    parts.push(`eye = ${prog.arena.dump(rm.eye)}`);
  }
  parts.push(`== image`);
  parts.push(prog.arena.dump(prog.imageRoot));
  return parts.join("\n");
}

for (const [i, ex] of EXAMPLES.entries()) {
  test(`IR snapshot: ${ex.name}`, () => {
    const got = dumpExample(ex.source);
    const file = join(dir, `example-${String(i + 1).padStart(2, "0")}.txt`);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
      writeFileSync(file, got);
      return;
    }
    const want = readFileSync(file, "utf8");
    assert.equal(got, want, `IR が golden と異なります: ${file}(意図した変更なら UPDATE_GOLDEN=1 で更新)`);
  });
}
