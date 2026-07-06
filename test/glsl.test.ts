// GLSL / Shadertoy 互換層のテスト(ADR-0011)。
// 変換結果が WGSL としてパースでき、コンパイルパイプラインに乗ることを確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 型定義パスなしの devDependency
import { WgslParser } from "wgsl_reflect/wgsl_reflect.module.js";
import { glslToWgsl } from "../src/compiler/glsl.ts";
import { compile } from "../src/compiler/index.ts";

function wrapForParse(body: string): string {
  // 変換結果は U(uniform 構造体)を参照し得るので、検証用に補って構文チェックする
  return `struct Uniforms { header: vec4f, slots: array<vec4f, 1> }
@group(0) @binding(0) var<uniform> U: Uniforms;
${body}`;
}

test("glsl: 単純な関数の変換", () => {
  const out = glslToWgsl(
    `float pattern(vec2 p, float t) {
  float v = sin(p.x * 3.0 + t);
  return v * 0.5 + 0.5;
}`,
    "glsl",
    "ffi_test1",
  );
  assert.match(out, /fn ffi_test1\(p: vec2f, t: f32\) -> f32/);
  new WgslParser().parse(wrapForParse(out));
});

test("shadertoy: mainImage のラップとシム", () => {
  const out = glslToWgsl(
    `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
  fragColor = vec4(col, 1.0);
}`,
    "shadertoy",
    "ffi_st1",
  );
  assert.match(out, /fn ffi_st1\(p: vec2f, t: f32\) -> vec4f/);
  assert.match(out, /st_iTime/);
  new WgslParser().parse(wrapForParse(out));
});

test("shadertoy ブロックがコンパイルパイプラインを通る", () => {
  const src = `sky = shadertoy """
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}
"""

out (sky |> vignette 0.3)`;
  const r = compile(src, glslToWgsl);
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(r.program);
  const img = r.program!.passes.find((p) => p.kind === "image")!;
  new WgslParser().parse(img.code);
});

test("glsl ブロック + ネイティブ合成子", () => {
  const src = `pat = glsl (Field Float) """
float f(vec2 p, float t) {
  return sin(p.x * 4.0 + t) * sin(p.y * 4.0);
}
"""

out (pat |> scale 2 |> ramp [black, teal, white])`;
  const r = compile(src, glslToWgsl);
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 0, JSON.stringify(errors));
});
