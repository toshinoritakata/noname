// BufferRegistry の照合キー(束縛名+型シグネチャ)のテスト(implementation.md 5.2、ADR-0004)。
// 「状態保持スワップ」の成否を握る keep / resample / reset の判定を検査する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSim } from "../src/runtime/registry.ts";
import { compile } from "../src/compiler/index.ts";

const RD = (feed: string, kill: string): string => `rd = simulate (noise2 |> scale 4) \\s ->
       let a   = s.x
           b   = s.y
           lap = laplacian s
       in [ a + (0.21 * lap.x - a*b*b + ${feed} * (1 - a)) * dt
          , b + (0.11 * lap.y + a*b*b - ${kill} * b)       * dt ]

out (rd.y |> ramp [black, teal, white])`;

test("更新則だけの変更 → sig 不変(中身を保持して差し替え)", () => {
  const a = compile(RD("0.055", "0.062"));
  const b = compile(RD("0.030", "0.058"));
  assert.ok(a.program && b.program);
  const sa = a.program!.sims[0];
  const sb = b.program!.sims[0];
  assert.equal(sa.sig, sb.sig);
  assert.equal(matchSim(sa, sb), "keep");
});

test("状態レイアウトが変わる → reset", () => {
  const a = compile(RD("0.055", "0.062"));
  const b = compile(`rd = simulate (noise |> scale 4) \\s -> s * 0.99

out (rd |> ramp [black, white])`);
  assert.ok(a.program && b.program, JSON.stringify(b.diagnostics));
  assert.equal(matchSim(a.program!.sims[0], b.program!.sims[0]), "reset");
});

test("サイズだけ変わる → resample", () => {
  const spec = (w: number): Parameters<typeof matchSim>[0] => ({
    name: "rd",
    sig: `grid:${w}x${w}:x#1@0,y#1@1`.replace("x#1@0,y#1@1", "#2@0"),
    kind: "grid",
    width: w,
    height: w,
    texCount: 1,
  });
  assert.equal(matchSim(spec(256), spec(512)), "resample");
});

test("束縛名が変わると別状態(名前が状態の同一性)", () => {
  // 名前は Registry のキーそのもの。ここではコンパイル結果に名前が乗ることだけ確認
  const a = compile(RD("0.055", "0.062"));
  assert.equal(a.program!.sims[0].name, "rd");
});
