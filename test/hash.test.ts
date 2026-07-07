// hash 系関数の分布品質テスト。旧実装(10進小数の演算を fract で畳み込む方式)は
// f32 の有効桁(約7桁)を超える大きさの入力で衝突が急増する欠陥があった
// (scatter の N が数万規模、time が長時間経過後など)。ADR-0039 の bitcast+
// MurmurHash3 fmix32 実装がこれを解消していることを検査する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { IRArena } from "../src/compiler/ir.ts";
import { interpret } from "../src/compiler/interp.ts";

function hash11(n: number): number {
  const arena = new IRArena();
  const arg = arena.node({ k: "const", v: n, t: "f32" });
  const root = arena.node({ k: "call", fn: "hash11", args: [arg], t: "f32" });
  return interpret(arena, root, { coord: [0, 0] }) as number;
}

test("hash11: 整数0..99999は衝突なくユニーク(旧実装はN=100,000で12,025止まり)", () => {
  const outs = new Set<number>();
  for (let i = 0; i < 100000; i++) outs.add(hash11(i));
  assert.equal(outs.size, 100000, `ユニーク数=${outs.size}/100000`);
});

test("hash11: 大きな入力(time経過を想定)でも衝突しない(旧実装はtime~100,000で19.5%まで劣化)", () => {
  for (const base of [0, 1000, 100000, 1000000]) {
    const outs = new Set<number>();
    for (let i = 0; i < 1000; i++) outs.add(hash11(base + i * 0.1));
    assert.equal(outs.size, 1000, `base=${base}: ユニーク数=${outs.size}/1000`);
  }
});

test("hash11: 出力は常に [0, 1) の範囲", () => {
  for (const n of [0, 1, -1, 0.5, 12345.678, -99999.9, 1e7]) {
    const v = hash11(n);
    assert.ok(v >= 0 && v < 1, `hash11(${n}) = ${v}`);
  }
});
