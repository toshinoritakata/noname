import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compiler/index.ts";
import { EXAMPLES } from "../src/examples.ts";

for (const ex of EXAMPLES) {
  test(`コンパイル: ${ex.name}`, () => {
    const r = compile(ex.source);
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    assert.equal(errors.length, 0, JSON.stringify(errors, null, 2));
    assert.ok(r.program, "program が生成される");
    assert.ok(r.program!.passes.length >= 1);
    const image = r.program!.passes.find((p) => p.kind === "image");
    assert.ok(image, "最終 image パスがある");
    assert.match(image!.code, /@fragment/);
  });
}

test("リテラル変更で構造ハッシュが変わらない(uniform 昇格・ADR-0008)", () => {
  const a = compile(`out (circle (0.3 + 0.1 * sin time) |> fill white)`);
  const b = compile(`out (circle (0.35 + 0.12 * sin time) |> fill white)`);
  assert.ok(a.program && b.program);
  assert.equal(a.program!.programHash, b.program!.programHash);
  assert.notDeepEqual(
    a.program!.literals.map((l) => l.value),
    b.program!.literals.map((l) => l.value),
  );
});

test("構造変更でハッシュが変わる", () => {
  const a = compile(`out (circle 0.3 |> fill white)`);
  const b = compile(`out (box 0.3 |> fill white)`);
  assert.notEqual(a.program!.programHash, b.program!.programHash);
});

test("グリッド数の変更は構造変更(構造定数)", () => {
  const a = compile(`out (grid [2,2] \\i -> circle 0.3)`);
  const b = compile(`out (grid [3,3] \\i -> circle 0.3)`);
  assert.ok(a.program && b.program, "both compile");
  assert.notEqual(a.program!.programHash, b.program!.programHash);
});

test("scatter数の変更はinstanced描画(sprite/strip)でも構造変更になる(ADR-0041)", () => {
  // sprite/strip/strip3d の instanced 描画バッチは、N が変わっても IR の式グラフ
  // 自体は同じ(loopi 経由の同じ式を N 回描くだけ)なので、パスのハッシュ計算に
  // batch.count を明示的に含めないと「形が同じ」と誤判定され、uniform 更新のみの
  // 高速経路(ADR-0008)に落ちて N の変更が一切反映されなくなるバグがあった
  const spriteA = compile(`out (scatter 5 \\i -> point 0.02 |> move [hash i, hash (i+1)] |> fill white)`);
  const spriteB = compile(`out (scatter 50 \\i -> point 0.02 |> move [hash i, hash (i+1)] |> fill white)`);
  assert.ok(spriteA.program && spriteB.program);
  assert.notEqual(spriteA.program!.programHash, spriteB.program!.programHash, "sprite: N変更でハッシュ不変");

  const stripA = compile(`out (scatter 5 \\i -> line [hash i, hash (i+1)] [hash (i+2), hash (i+3)] |> outline 0.01 |> fill white)`);
  const stripB = compile(`out (scatter 50 \\i -> line [hash i, hash (i+1)] [hash (i+2), hash (i+3)] |> outline 0.01 |> fill white)`);
  assert.ok(stripA.program && stripB.program);
  assert.notEqual(stripA.program!.programHash, stripB.program!.programHash, "strip: N変更でハッシュ不変");

  const strip3A = compile(
    `out (render (orbit 4 0) (scatter 5 \\i -> line [hash i, hash (i+1), hash (i+2)] [hash (i+3), hash (i+4), hash (i+5)] |> outline 0.01 |> fill white))`,
  );
  const strip3B = compile(
    `out (render (orbit 4 0) (scatter 50 \\i -> line [hash i, hash (i+1), hash (i+2)] [hash (i+3), hash (i+4), hash (i+5)] |> outline 0.01 |> fill white))`,
  );
  assert.ok(strip3A.program && strip3B.program);
  assert.notEqual(strip3A.program!.programHash, strip3B.program!.programHash, "strip3d: N変更でハッシュ不変");
});

test("checker/voronoi/brick は2D/3D(brickは2Dのみ)でコンパイルできる(ADR-0043)", () => {
  for (const src of [
    `out (circle 0.8 |> fill (checker 0.15))`,
    `out (circle 0.8 |> fill (voronoi 0.15))`,
    `out (circle 0.8 |> fill (brick 0.2))`,
    `out (render (orbit 4 0) (sphere 0.9 |> shade (sun [1,1,1]) |> fill (checker 0.2)))`,
    `out (render (orbit 4 0) (sphere 0.9 |> shade (sun [1,1,1]) |> fill (voronoi 0.2)))`,
  ]) {
    const r = compile(src);
    assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, `${src}\n${JSON.stringify(r.diagnostics)}`);
    assert.ok(r.program, src);
  }
});

test("brick は Field2 専用(stripes と同じ扱い)だが、3D図形にも平面投影として使える", () => {
  // fill は Field の次元を Shape と照合しない(stripes も同じ)。brick は xy 平面への
  // 投影になるだけでコンパイルエラーにはならない
  const r = compile(`out (render (orbit 4 0) (sphere 0.9 |> shade (sun [1,1,1]) |> fill (brick 0.2)))`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
});

test("エラー時は program が null(ADR-0010 のための前提)", () => {
  const r = compile(`out (circle (0.3`);
  assert.ok(r.diagnostics.some((d) => d.severity === "error"));
  assert.equal(r.program, null);
});

test("osc.f n は入力参照にコンパイルされる(ADR-0029)", () => {
  const r = compile(`out (circle (0.3 + osc.f 0 * 0.1) |> fill white)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(r.program!.uniformLayout.inputs.includes("osc.f0"));
});

test("osc.f の範囲外(32以上)はコンパイルエラー", () => {
  const r = compile(`out (circle (0.3 + osc.f 32 * 0.1) |> fill white)`);
  assert.ok(r.diagnostics.some((d) => d.severity === "error" && /osc\.f/.test(d.message)));
  assert.equal(r.program, null);
});

test("webcam は cam テクスチャを参照する image パスにコンパイルされる(ADR-0030)", () => {
  const r = compile(`out (webcam |> chromatic 0.05)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  const image = r.program!.passes.find((p) => p.kind === "image")!;
  assert.ok(image.textures.includes("cam"), JSON.stringify(image.textures));
});

test("ws.value は入力参照にコンパイルされる(ADR-0033)", () => {
  const r = compile(`out (circle (0.2 + ws.value * 0.01) |> fill white)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(r.program!.uniformLayout.inputs.includes("ws.value"));
});

test("text は文字列リテラルを受け取り、text:<hash>:aspect 入力とtextTexturesを持つ(ADR-0032)", () => {
  const r = compile(`out (text 0.3 "Hello" |> fill white)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.equal(r.program!.textTextures.length, 1);
  assert.equal(r.program!.textTextures[0].text, "Hello");
  const aspectInput = r.program!.uniformLayout.inputs.find((n) => n.endsWith(":aspect"));
  assert.ok(aspectInput, JSON.stringify(r.program!.uniformLayout.inputs));
  assert.equal(aspectInput, `${r.program!.textTextures[0].key}:aspect`);
});

test("同じ文字列を複数回使っても textTextures は重複しない", () => {
  const r = compile(`out (text 0.3 "Hi" <+> (text 0.3 "Hi" |> move [0.5, 0]))`);
  assert.ok(r.program);
  assert.equal(r.program!.textTextures.length, 1);
});

test("scatter が instanced 描画に昇格し損ねると警告が出る(見えない性能崖の可視化)", () => {
  // rot を挟むと sprite マーカーが引き継がれず(move/fill/glow 以外は安全フォールバック)
  // O(n) の SDF ループに転落する。n=100 > UNROLL_LIMIT(64)なので loopShape が働く
  const r = compile(`out (scatter 100 \\i ->
    point 0.05
    |> move [hash i * 2 - 1, hash (i+1) * 2 - 1]
    |> rot (hash i)
    |> fill white)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(
    r.diagnostics.some((d) => d.severity === "warning" && /instanced 描画に昇格せず/.test(d.message)),
    JSON.stringify(r.diagnostics),
  );
});

test("scatter が sprite 経路に昇格すれば警告は出ない", () => {
  const r = compile(`out (render (orbit 4 0)
    (scatter 100 \\i ->
      point 0.05
      |> move [hash i * 2 - 1, hash (i+1) * 2 - 1, 0]
      |> fill white))`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(!r.diagnostics.some((d) => /instanced 描画に昇格せず/.test(d.message)), JSON.stringify(r.diagnostics));
});

test("scatter が strip 経路に昇格すれば警告は出ない", () => {
  const r = compile(`out (scatter 100 \\i ->
    line [hash i * 2 - 1, hash (i+1) * 2 - 1] [hash (i+2) * 2 - 1, hash (i+3) * 2 - 1]
    |> outline 0.01
    |> fill white)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(!r.diagnostics.some((d) => /instanced 描画に昇格せず/.test(d.message)), JSON.stringify(r.diagnostics));
});

test("3D line/bezier の scatter は strip3d 経路に昇格し、警告は出ない(ADR-0036)", () => {
  const r = compile(`scene = scatter 100 \\i ->
    line [hash i, hash (i+1), hash (i+2)] [hash (i+3), hash (i+4), hash (i+5)]
    |> outline 0.02
    |> fill white

out (render (orbit 4 0) scene)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(!r.diagnostics.some((d) => /instanced 描画に昇格せず/.test(d.message)), JSON.stringify(r.diagnostics));
  assert.ok(r.program!.passes.some((p) => p.kind === "strip3d"), JSON.stringify(r.program!.passes.map((p) => p.kind)));
});

test("3D bezier の scatter も strip3d 経路に昇格する", () => {
  const r = compile(`scene = scatter 100 \\i ->
    bezier [hash i, hash (i+1), hash (i+2)] [hash (i+3), hash (i+4), hash (i+5)] [hash (i+6), hash (i+7), hash (i+8)]
    |> outline 0.02
    |> fill (hsv (hash i) 0.6 1)
    |> glow 0.5

out (render (orbit 4 0) scene)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(r.program!.passes.some((p) => p.kind === "strip3d"), JSON.stringify(r.program!.passes.map((p) => p.kind)));
});

test("scatter した3D lineに rot を挟むと strip3d に昇格せず、SDFも無いのでコンパイルエラーになる(ADR-0037)", () => {
  // rot が strip3D を落とす(move/fill/glow/outline 以外は安全フォールバック)ので
  // ADR-0035 の警告も出るが、line/bezier には ADR-0037 でSDFが無いので、
  // フォールバック先の O(n) ループ自体が dist を呼んでコンパイルエラーになる
  const r = compile(`scene = scatter 100 \\i ->
    line [hash i, hash (i+1), hash (i+2)] [hash (i+3), hash (i+4), hash (i+5)]
    |> outline 0.02
    |> rotY (hash i)
    |> fill white

out (render (orbit 4 0) scene)`);
  assert.ok(r.diagnostics.some((d) => d.severity === "error" && /line にはSDFがありません/.test(d.message)), JSON.stringify(r.diagnostics));
  assert.equal(r.program, null);
});

test("line/bezier 単体を move/cut/inter/<+>/if/morph と組み合わせるとコンパイルエラーになる(ADR-0037)", () => {
  const cases = [
    `out (line [0, 0] [0.3, 0.3] |> outline 0.02 |> move [0.1, 0] |> fill white)`,
    `out (cut (box 0.3) (line [0, 0] [0.3, 0.3] |> outline 0.02 |> fill white))`,
    `out (inter (box 0.3) (line [0, 0] [0.3, 0.3] |> outline 0.02 |> fill white))`,
    `out ((line [0, 0] [0.3, 0.3] |> outline 0.02 |> fill white) <+> circle 0.3)`,
    `out (if (hash 1 |> \\x -> x > 0.5) then (line [0, 0] [0.3, 0.3] |> outline 0.02 |> fill white) else circle 0.3)`,
  ];
  for (const src of cases) {
    const r = compile(src);
    assert.ok(
      r.diagnostics.some((d) => d.severity === "error" && /にはSDFがありません/.test(d.message)),
      `${src}\n${JSON.stringify(r.diagnostics)}`,
    );
    assert.equal(r.program, null, src);
  }
});

test("line/bezier 単体は outline/fill/glow だけなら dist に触れずコンパイルできる(ADR-0037)", () => {
  const r = compile(`out (bezier [0, 0] [0.2, 0.5] [0.4, 0] |> outline 0.03 |> fill white)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(r.program!.passes.some((p) => p.kind === "strip"), JSON.stringify(r.program!.passes.map((p) => p.kind)));
});

test("line a b w は line a b |> outline w と同じ意味になる(ADR-0038)", () => {
  const withW = compile(`out (line [0, 0] [0.3, 0.3] 0.02 |> fill white)`);
  assert.equal(withW.diagnostics.length, 0, JSON.stringify(withW.diagnostics));
  assert.ok(withW.program);
  assert.ok(withW.program!.passes.some((p) => p.kind === "strip"), JSON.stringify(withW.program!.passes.map((p) => p.kind)));
});

test("bezier a b c w も同じ糖衣構文になる(ADR-0038)", () => {
  const r = compile(`out (bezier [0, 0] [0.2, 0.5] [0.4, 0] 0.03 |> fill white)`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(r.program!.passes.some((p) => p.kind === "strip"), JSON.stringify(r.program!.passes.map((p) => p.kind)));
});

test("3D line a b w も strip3d に昇格する(ADR-0038)", () => {
  const r = compile(`out (render (orbit 4 0) (line [0, 0, 0] [0.3, 0.3, 0.3] 0.02 |> fill white))`);
  assert.equal(r.diagnostics.length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  assert.ok(r.program!.passes.some((p) => p.kind === "strip3d"), JSON.stringify(r.program!.passes.map((p) => p.kind)));
});

test("line/bezier 以外の Shape に数値を適用するとコンパイルエラーになる", () => {
  const r = compile(`out (circle 0.3 0.05)`);
  assert.ok(r.diagnostics.some((d) => d.severity === "error" && /は関数ではないので適用できません/.test(d.message)), JSON.stringify(r.diagnostics));
  assert.equal(r.program, null);
});

test("glitch は image パスにコンパイルされる", () => {
  const r = compile(`out (circle 0.3 |> fill white |> glitch 0.5)`);
  assert.equal(r.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(r.diagnostics));
  assert.ok(r.program);
  const image = r.program!.passes.find((p) => p.kind === "image");
  assert.ok(image);
  assert.match(image!.code, /hash11/);
});

test("大きな scatter は WGSL の for ループになる", () => {
  const r = compile(`out (scatter 300 \\i -> circle 0.01 |> move [hash i * 2 - 1, hash (i+7) * 2 - 1])`);
  assert.ok(r.program, JSON.stringify(r.diagnostics));
  const img = r.program!.passes.find((p) => p.kind === "image")!;
  assert.match(img.code, /for \(var li/);
});
