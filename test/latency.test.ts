// レイテンシ予算のベンチマーク(implementation.md 7章)。
// 「予算超過を fail に」— TypeScript 実装の限界を推測ではなく計測で監視する(ADR-0006)。
//   - パース+型推論+IR(staging): < 20ms
//   - フル再コンパイル(WGSL 生成まで。ドライバ内コンパイルは除く): < 300ms
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/compiler/parser.ts";
import { stageProgram } from "../src/compiler/stage.ts";
import { compile } from "../src/compiler/index.ts";
import { inferProgram } from "../src/compiler/infer.ts";
import { EXAMPLES } from "../src/examples.ts";

function bestOf(n: number, f: () => void): number {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

for (const ex of EXAMPLES) {
  test(`予算 パース+型推論+IR < 20ms: ${ex.name}`, () => {
    const ms = bestOf(5, () => {
      const p = parse(ex.source);
      inferProgram(p.program, ex.source);
      stageProgram(p.program, ex.source);
    });
    assert.ok(ms < 20, `${ms.toFixed(2)}ms(予算 20ms)`);
  });

  test(`予算 フル再コンパイル < 300ms: ${ex.name}`, () => {
    const ms = bestOf(3, () => compile(ex.source));
    assert.ok(ms < 300, `${ms.toFixed(2)}ms(予算 300ms)`);
  });
}
