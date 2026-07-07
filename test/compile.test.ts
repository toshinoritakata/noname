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
