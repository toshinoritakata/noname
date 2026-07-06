// GLSL / Shadertoy 互換層(implementation.md 6.2、ADR-0011)。
//
// 設計では naga(wasm)の GLSL フロントエンドを想定しているが、依存ゼロの方針
// (ADR-0006)に合わせ、Shadertoy 頻出サブセットを対象にした軽量トランスパイラを
// この「遅延ロード境界」に置く。インタフェース(GlslFrontend)は naga 差し替えを
// 想定したまま維持している。
//
// 対応する構文(サブセット):
//   - 型: float/int/bool/vec2..4/mat2..4/void
//   - 関数定義・for/if/while・変数宣言(const 含む)
//   - 組み込み: mod→ヘルパ、atan(y,x)→atan2、mix/clamp/fract/... はそのまま
//   - 三項演算子(単純なもの)→ select
//   - #define(オブジェクトマクロのみ)
//   - Shadertoy: mainImage(out vec4, in vec2) を Image にラップ、
//     iTime / iResolution / iMouse(常に0)/ fragCoord のシムを注入

const TYPE_MAP: [RegExp, string][] = [
  [/\bvec2\b/g, "vec2f"],
  [/\bvec3\b/g, "vec3f"],
  [/\bvec4\b/g, "vec4f"],
  [/\bivec2\b/g, "vec2i"],
  [/\bivec3\b/g, "vec3i"],
  [/\bivec4\b/g, "vec4i"],
  [/\bmat2\b/g, "mat2x2f"],
  [/\bmat3\b/g, "mat3x3f"],
  [/\bmat4\b/g, "mat4x4f"],
];

const WGSL_TYPES = new Set(["f32", "i32", "bool", "vec2f", "vec3f", "vec4f", "mat2x2f", "mat3x3f", "mat4x4f"]);

const MOD_HELPERS = `
fn glsl_mod_f(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }
fn glsl_mod_v2(a: vec2f, b: vec2f) -> vec2f { return a - b * floor(a / b); }
fn glsl_mod_v3(a: vec3f, b: vec3f) -> vec3f { return a - b * floor(a / b); }
fn glsl_mod_v4(a: vec4f, b: vec4f) -> vec4f { return a - b * floor(a / b); }
fn glsl_mod_v2f(a: vec2f, b: f32) -> vec2f { return a - b * floor(a / b); }
fn glsl_mod_v3f(a: vec3f, b: f32) -> vec3f { return a - b * floor(a / b); }
`;

export function glslToWgsl(src: string, kind: "glsl" | "shadertoy", fnName: string): string {
  let code = src;

  // コメントは保持したいがマクロ処理を単純にするため、まず #define を集める
  const defines: [RegExp, string][] = [];
  code = code.replace(/^[ \t]*#define[ \t]+(\w+)[ \t]+(.+)$/gm, (_, name: string, val: string) => {
    defines.push([new RegExp(`\\b${name}\\b`, "g"), `(${val.trim()})`]);
    return "";
  });
  code = code.replace(/^[ \t]*#(ifdef|ifndef|if|else|endif|version|precision).*$/gm, "");
  for (const [re, val] of defines) code = code.replace(re, val);

  // 型キーワード
  for (const [re, to] of TYPE_MAP) code = code.replace(re, to);

  // float リテラル `1.` → `1.0`
  code = code.replace(/(\d)\.(?=[^0-9]|$)/g, "$1.0");

  // atan(y, x) → atan2(y, x)(引数2つのときだけ)
  code = code.replace(/\batan\s*\(([^(),]+),([^()]+)\)/g, "atan2($1,$2)");

  // mod(...) → 型別ヘルパ(引数の型は分からないので f32 版に寄せ、
  // ベクトルが必要な場合に備えて全オーバーロードを同梱し名前だけ振り分けない)
  code = code.replace(/\bmod\s*\(/g, "glsl_mod_f(");

  // texture / textureLod は非対応(iChannel は範囲外)
  // 三項演算子(ネストなしの単純形)→ select
  for (let i = 0; i < 4; i++) {
    code = code.replace(
      /([A-Za-z0-9_.()\[\] ]+?)\s*\?\s*([^?:;]+?)\s*:\s*([^?:;,)]+)/g,
      "select(($3), ($2), ($1))",
    );
  }

  // 関数定義: `TYPE name(args) {` → `fn name(args) -> TYPE {`
  code = code.replace(
    /^([ \t]*)(f32|i32|bool|vec2f|vec3f|vec4f|mat2x2f|mat3x3f|mat4x4f|void|float|int)[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*\{/gm,
    (_m, indent: string, retType: string, name: string, args: string) => {
      const ret = normType(retType);
      const wargs = args
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0)
        .map((a) => {
          const parts = a.replace(/\b(in|highp|mediump|lowp)\b/g, "").trim().split(/\s+/);
          if (parts[0] === "out" || parts[0] === "inout") {
            const t = normType(parts[1]);
            return `${parts[2]}: ptr<function, ${t}>`;
          }
          const t = normType(parts[0]);
          return `${parts[1]}: ${t}`;
        })
        .join(", ");
      const retClause = ret === "void" ? "" : ` -> ${ret}`;
      return `${indent}fn ${name}(${wargs})${retClause} {`;
    },
  );

  // 変数宣言: `TYPE x = ...` → `var x: TYPE = ...`(const は let)
  code = code.replace(
    /\bconst[ \t]+(f32|i32|bool|vec2f|vec3f|vec4f|mat2x2f|mat3x3f|mat4x4f|float|int)[ \t]+(\w+)[ \t]*=/g,
    (_m, t: string, n: string) => `let ${n}: ${normType(t)} =`,
  );
  code = code.replace(
    /(^|[;{(][ \t]*|\n[ \t]*)(f32|i32|bool|vec2f|vec3f|vec4f|mat2x2f|mat3x3f|mat4x4f|float|int)[ \t]+(\w+)[ \t]*(=|;|,)/g,
    (_m, pre: string, t: string, n: string, tail: string) => {
      const ty = normType(t);
      if (tail === ";") return `${pre}var ${n}: ${ty};`;
      if (tail === ",") return `${pre}var ${n}: ${ty};`; // 複数宣言は最初のみ(限界はドキュメント参照)
      return `${pre}var ${n}: ${ty} =`;
    },
  );

  // for (int i = 0; ...) → for (var i: i32 = 0; ...)
  code = code.replace(/for[ \t]*\([ \t]*var[ \t]+(\w+):[ \t]*(i32|f32)/g, "for (var $1: $2");

  // 残った float/int(キャスト用途)
  code = code.replace(/\bfloat\b/g, "f32").replace(/\bint\b/g, "i32");
  code = code.replace(/\bf32[ \t]*\(/g, "f32(").replace(/\bi32[ \t]*\(/g, "i32(");

  if (kind === "shadertoy") {
    // mainImage をリネームして Image 型のエントリでラップ
    const mainName = `${fnName}_main`;
    code = code.replace(/\bmainImage\b/g, mainName);
    // out 引数への代入を ptr 経由に(mainImage の第1引数名を拾う)
    const sig = code.match(new RegExp(`fn ${mainName}\\((\\w+): ptr<function, vec4f>, *(\\w+): vec2f`));
    if (sig) {
      const outName = sig[1];
      // 本文中の `outName =` / `outName.x =` を `(*outName)` に
      code = code.replace(new RegExp(`\\b${outName}\\b(?![:\\w])`, "g"), `(*${outName})`);
      // 宣言部は元に戻す
      code = code.replace(`fn ${mainName}((*${outName}): ptr<function, vec4f>`, `fn ${mainName}(${outName}: ptr<function, vec4f>`);
    }
    // iTime / iResolution / iMouse / fragCoord のシム
    code = code
      .replace(/\biTime\b/g, "st_iTime")
      .replace(/\biResolution\b/g, "st_iRes")
      .replace(/\biMouse\b/g, "st_iMouse");
    const wrapper = `
var<private> st_iTime: f32;
var<private> st_iRes: vec3f;
var<private> st_iMouse: vec4f;
fn ${fnName}(p: vec2f, t: f32) -> vec4f {
  let res = U.header.xy;
  st_iTime = t;
  st_iRes = vec3f(res, 1.0);
  st_iMouse = vec4f(0.0);
  let aspect = res.x / max(res.y, 1.0);
  var s: vec2f;
  if (aspect >= 1.0) { s = vec2f(aspect, -1.0); } else { s = vec2f(1.0, -1.0 / aspect); }
  let uv01 = (p / s + 1.0) * 0.5;
  let fragCoord = vec2f(uv01.x * res.x, (1.0 - uv01.y) * res.y);
  var fragColor = vec4f(0.0, 0.0, 0.0, 1.0);
  ${fnName}_main(&fragColor, fragCoord);
  return fragColor;
}`;
    // mainImage は (out vec4, in vec2) 想定。iTime はグローバル private 経由
    return MOD_HELPERS + "\n" + code + "\n" + wrapper;
  }

  // glsl: 最初の関数を fnName にリネーム(wgsl ブロックと同じ扱い)
  const m = code.match(/\bfn\s+(\w+)\s*\(/);
  if (m) {
    code = code.replaceAll(new RegExp(`\\b${m[1]}\\b`, "g"), fnName);
  }
  return MOD_HELPERS + "\n" + code;
}

function normType(t: string): string {
  if (t === "float") return "f32";
  if (t === "int") return "i32";
  if (WGSL_TYPES.has(t) || t === "void") return t;
  return t;
}
