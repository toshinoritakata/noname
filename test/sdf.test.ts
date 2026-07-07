// SDF 性質テスト(implementation.md 8章):
// プリミティブと合成子に対し「境界で ≈0」「Lipschitz ≤ 1+ε」を乱択サンプリングで検査。
// 評価は CPU 側 IR インタプリタ(interp.ts)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { stageShapeDist } from "../src/compiler/stage.ts";
import { interpret } from "../src/compiler/interp.ts";

// 再現可能な擬似乱数
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function distFn(src: string, dim: 2 | 3 = 2): (p: number[]) => number {
  const r = stageShapeDist(src, dim);
  if ("error" in r) throw new Error(r.error);
  return (p: number[]) => interpret(r.arena, r.root, { coord: p, inputs: { time: 0.7 } }) as number;
}

function checkLipschitz(name: string, src: string, dim: 2 | 3, lipMax = 1.05): void {
  test(`Lipschitz ≤ ${lipMax}: ${name}`, () => {
    const d = distFn(src, dim);
    const rand = rng(42);
    for (let i = 0; i < 500; i++) {
      const p = Array.from({ length: dim }, () => (rand() - 0.5) * 4);
      const q = Array.from({ length: dim }, () => (rand() - 0.5) * 4);
      const dp = d(p);
      const dq = d(q);
      const dist = Math.hypot(...p.map((x, j) => x - q[j]));
      if (dist < 1e-6) continue;
      const lip = Math.abs(dp - dq) / dist;
      assert.ok(
        lip <= lipMax + 1e-6,
        `${name}: Lipschitz 違反 ${lip.toFixed(3)} at p=${p.map((x) => x.toFixed(2))} q=${q.map((x) => x.toFixed(2))}`,
      );
    }
  });
}

function checkBoundary(name: string, src: string, dim: 2 | 3, boundaryPoints: number[][]): void {
  test(`境界 ≈ 0: ${name}`, () => {
    const d = distFn(src, dim);
    for (const p of boundaryPoints) {
      const v = d(p);
      assert.ok(Math.abs(v) < 1e-3, `${name}: 境界点 ${p} で dist=${v}`);
    }
  });
}

// ---- プリミティブ ----
checkBoundary("circle 0.5", "circle 0.5", 2, [
  [0.5, 0],
  [0, 0.5],
  [-0.5, 0],
  [0.353553, 0.353553],
]);
checkLipschitz("circle 0.5", "circle 0.5", 2);

checkBoundary("box 0.4", "box 0.4", 2, [
  [0.4, 0],
  [0, -0.4],
  [0.4, 0.4],
]);
checkLipschitz("box 0.4", "box 0.4", 2);

checkBoundary("sphere 0.8", "sphere 0.8", 3, [
  [0.8, 0, 0],
  [0, 0, -0.8],
]);
checkLipschitz("sphere 0.8", "sphere 0.8", 3);

checkLipschitz("tri 0.45", "tri 0.45", 2);

// ---- 合成子は距離場の性質を保つ ----
checkLipschitz("union", "circle 0.3 <+> (box 0.2 |> move [0.5, 0.1])", 2);
checkLipschitz("cut", "circle 0.5 |> cut (box 0.3)", 2);
checkLipschitz("outline", "circle 0.4 |> outline 0.05", 2);
checkLipschitz("move/rot/scale", "box 0.3 |> rot 0.7 |> scale 1.5 |> move [0.2, -0.1]", 2);
checkLipschitz("blendAll(smooth union)", "blendAll 0.3 [circle 0.3, box 0.25]", 2, 1.1);

// 境界: 変換後も正確
checkBoundary("scale 2 (circle 0.3)", "circle 0.3 |> scale 2", 2, [
  [0.6, 0],
  [0, -0.6],
]);
checkBoundary("move (circle 0.3)", "circle 0.3 |> move [0.5, 0.5]", 2, [
  [0.8, 0.5],
  [0.5, 0.2],
]);

// line/bezier には SDF が無い(ADR-0037で廃止、instanced strip 描画専用)。
// SDF性質テストは対象外。コンパイル可否・instanced昇格の検証は test/compile.test.ts 側
