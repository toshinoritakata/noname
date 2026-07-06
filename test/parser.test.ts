import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/compiler/parser.ts";
import type { Expr } from "../src/compiler/ast.ts";

function show(e: Expr): string {
  switch (e.k) {
    case "num":
      return String(e.value);
    case "time":
      return `${e.value}${e.unit}`;
    case "str":
      return JSON.stringify(e.text.slice(0, 12));
    case "var":
      return e.name;
    case "lam":
      return `(\\${e.params.map((p) => p.name).join(" ")} -> ${show(e.body)})`;
    case "app":
      return `(${show(e.fn)} ${show(e.arg)})`;
    case "bin":
      return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case "neg":
      return `(- ${show(e.expr)})`;
    case "if":
      return `(if ${show(e.cond)} ${show(e.then)} ${show(e.else_)})`;
    case "let":
      return `(let ${e.binds.map((b) => `${b.name}${b.params.map((p) => " " + p.name).join("")} = ${show(b.expr)}`).join("; ")} in ${show(e.body)})`;
    case "list":
      return `[${e.items.map(show).join(", ")}]`;
    case "record":
      return `{${e.fields.map((f) => `${f.name}: ${show(f.expr)}`).join(", ")}}`;
    case "field":
      return `${show(e.target)}.${e.name}`;
    case "error":
      return "<error>";
  }
}

test("例1: 最小のプログラム", () => {
  const r = parse(`out (circle (0.3 + 0.1 * sin time) |> fill white) <> 0.5s`);
  assert.equal(r.diagnostics.length, 0);
  assert.ok(r.program.out);
  assert.equal(show(r.program.out!), "((fill white) (circle (0.3 + (0.1 * (sin time)))))");
  assert.equal(show(r.program.fade!), "0.5s");
});

test("例2: グリッド+複数行ラムダ+行頭パイプ", () => {
  const r = parse(`pat = grid [8, 8] \\i ->
        box 0.3
        |> rot (time * 0.2 + hash i * tau)
        |> fill (hsv (hash i * 0.2 + 0.6) 0.6 1)

out pat`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  assert.equal(r.program.binds.length, 1);
  const b = r.program.binds[0];
  assert.equal(b.name, "pat");
  assert.match(show(b.expr), /^\(\(grid \[8, 8\]\) \(\\i -> /);
  assert.equal(show(r.program.out!), "pat");
});

test("暗黙のパイプ(行頭 |> の省略)", () => {
  const r = parse(`out (circle 0.3)
    fill white`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  assert.equal(show(r.program.out!), "((fill white) (circle 0.3))");
});

test("例6: let 複数束縛とリスト", () => {
  const r = parse(`rd = simulate (noise2 |> scale 4) \\s ->
       let a   = s.x
           b   = s.y
           lap = laplacian s
       in [ a + (0.21 * lap.x - a*b*b + 0.055 * (1 - a)) * dt
          , b + (0.11 * lap.y + a*b*b - 0.062 * b)       * dt ]

out (rd.y |> ramp [black, teal, white])`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  const b = r.program.binds[0];
  assert.match(show(b.expr), /let a = s\.x; b = s\.y; lap = \(laplacian s\) in \[/);
  assert.equal(show(r.program.out!), "((ramp [black, teal, white]) rd.y)");
});

test("例12: if-then-else とレコード", () => {
  const r = parse(`parts = simulate initPV \\s ->
          let vel = s.vel + gravity * dt
              pos = s.pos + vel * dt
          in if dist world pos < 0.02
             then { pos: s.pos, vel: reflect vel (grad world pos) * 0.8 }
             else { pos: pos, vel: vel }

out parts`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  assert.match(show(r.program.binds[0].expr), /\(if \(\(\(dist world\) pos\) < 0.02\) \{pos: s\.pos/);
});

test("単項マイナス", () => {
  const r = parse(`out (plane.y (-1))`);
  assert.equal(r.diagnostics.length, 0);
  assert.equal(show(r.program.out!), "(plane.y (- 1))");
});

test("エラー回復: 壊れた文の後も続きをパースする", () => {
  const r = parse(`a = circle (0.3
b = box 0.2
out b`);
  assert.ok(r.diagnostics.length >= 1);
  assert.ok(r.program.out, "エラー後も out が取れる");
});

test("FFI ブロック", () => {
  const r = parse(`myFbm = wgsl (Field Float) """
  fn f(p: vec2f, t: f32) -> f32 { return 0.0; }
"""
out (circle 0.3)`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  assert.match(show(r.program.binds[0].expr), /^\(\(wgsl \(Field Float\)\) "/);
});

test("例4: ラムダ本体はラムダ開始行以下のインデントで終わる", () => {
  const r = parse(`balls = range 6
      |> map \\i ->
           sphere 0.4
           |> move [ sin (time + i * 2.1) * 1.5
                   , cos (time * 1.3 + i) * 1.0
                   , sin (time * 0.7 + i * 4.0) ]
      |> blendAll 0.7

out balls`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  const s = show(r.program.binds[0].expr);
  // blendAll はラムダの外(map の結果)に適用される
  assert.match(s, /^\(\(blendAll 0.7\) \(\(map \(\\i -> /);
});
