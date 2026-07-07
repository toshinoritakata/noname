// scatter された line/bezier(ADR-0016)は dist=+∞ にすり替えられ、実体は
// stripBatches(専用の instanced strip パス)だけが描く。このバッチは通常の SDF
// フォールバックが効かないため、合成子が黙って落とすと図形が完全に消える。
// この経路を通る主要な合成子(2D postfx / <+> / if / cut / inter)がバッチを
// 引き継ぐことを確認する回帰テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/compiler/parser.ts";
import { stageProgram } from "../src/compiler/stage.ts";

const STRANDS = `strands = scatter 200 \\i ->
  let a0 = hash i * 6.283185
      a1 = hash (i + 500) * 6.283185
      r0 = 0.3 + hash (i + 1000) * 0.6
      r1 = 0.3 + hash (i + 1500) * 0.6
      p0 = [cos a0, sin a0] * r0
      p1 = [cos a1, sin a1] * r1
      mid = (p0 + p1) * 0.5
  in bezier p0 mid p1
     |> outline 0.0035
     |> fill (hsv (hash (i + 2000)) 0.6 1)
`;

function stripCount(source: string): number {
  const p = parse(source);
  const st = stageProgram(p.program, source);
  if (st.diagnostics.some((d) => d.severity === "error")) {
    throw new Error(st.diagnostics.map((d) => d.message).join("\n"));
  }
  return st.program?.stripBatches?.length ?? 0;
}

test("bloom (and other 2D postfx) keep stripBatches", () => {
  for (const postfx of ["bloom 0.5", "vignette 0.3", "chromatic 0.02", "grain 0.05", "fade 0.9", "zoom 1.1"]) {
    assert.ok(stripCount(`${STRANDS}\nout (strands |> ${postfx})`) > 0, `${postfx} dropped stripBatches`);
  }
});

test("<+> (shapeUnion) merges stripBatches from both operands", () => {
  const n = stripCount(`${STRANDS}\nout (strands <+> circle 0.5 |> fill white)`);
  assert.equal(n, 1);
});

test("if merges stripBatches from both branches", () => {
  const n = stripCount(`${STRANDS}\nout (if (hash 1 |> \\x -> x > 0.5) then strands else (circle 0.5 |> fill white))`);
  assert.ok(n > 0);
});

test("cut/inter keep stripBatches from the base shape", () => {
  assert.ok(stripCount(`${STRANDS}\nout (cut (circle 0.5) strands)`) > 0);
  assert.ok(stripCount(`${STRANDS}\nout (inter strands (circle 5))`) > 0);
});
