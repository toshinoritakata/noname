// 生成 WGSL の静的検証(wgsl_reflect のパーサで構文チェック)。
// 実 GPU での描画確認はブラウザで行うが、構文エラーはここで CI 的に捕まえる。
//
// 注意: wgsl_reflect はブロックスコープを厳密に検証しない。実際に
// 「ループ内で巻き上げた変数の宣言が for(...) { の内側に紛れ込み、ループの
// 外から参照すると unresolved value になる」というバグ(ADR-0017)は
// wgsl_reflect の構文チェックを素通りしていた(実 GPU ドライバでのみ検出された)。
// そのため、コンパイラが生成する変数名(n123/acc0/fi0/li0 の形)についてだけ、
// 「使用箇所が宣言のスコープ内にあるか」を独自にチェックする(checkGeneratedVarScoping)。
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 型定義パスなしの devDependency(module ビルドを直接読む)
import { WgslParser } from "wgsl_reflect/wgsl_reflect.module.js";
import { compile } from "../src/compiler/index.ts";
import { EXAMPLES } from "../src/examples.ts";

/**
 * コンパイラが生成する変数(`n<id>`/`acc<loopId>`/`fi<loopId>`/`li<loopId>`)
 * について、行ベースの波括弧深さ追跡でブロックスコープ違反(宣言より外側の
 * ブロックからの参照)を検出する。関数引数(P/N/RD 等)やライブラリ関数名は
 * この命名パターンに一致しないため対象外(誤検知しない)。
 */
function checkGeneratedVarScoping(code: string, label: string): void {
  const genVar = /\b(?:n|acc|fi|li)\d+\b/g;
  const declRe = /\b(?:let|var)\s+((?:n|acc|fi|li)\d+)\s*:/;
  const scopes: Set<string>[] = [new Set()];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const declMatch = declRe.exec(line);
    genVar.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = genVar.exec(line))) {
      const name = m[0];
      if (declMatch && name === declMatch[1]) continue; // 宣言そのものはスキップ
      const inScope = scopes.some((s) => s.has(name));
      assert.ok(
        inScope,
        `${label}: 生成変数 '${name}' がスコープ外から参照されています(行 ${i + 1}): ${line.trim()}\n--- full code ---\n${code}`,
      );
    }
    if (declMatch) scopes[scopes.length - 1].add(declMatch[1]);
    for (const ch of line) {
      if (ch === "{") scopes.push(new Set());
      else if (ch === "}") scopes.pop();
    }
  }
}

for (const ex of EXAMPLES) {
  test(`WGSL 構文: ${ex.name}`, () => {
    const r = compile(ex.source);
    assert.ok(r.program, JSON.stringify(r.diagnostics));
    for (const pass of r.program!.passes) {
      const parser = new WgslParser();
      try {
        parser.parse(pass.code);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 行番号があれば周辺を出す
        const lineM = /line (\d+)/i.exec(msg);
        let ctx = "";
        if (lineM) {
          const ln = Number(lineM[1]);
          const lines = pass.code.split("\n");
          ctx = lines.slice(Math.max(0, ln - 3), ln + 2).join("\n");
        }
        assert.fail(`${ex.name} / ${pass.kind} パスの WGSL が壊れています: ${msg}\n${ctx}\n--- full code---\n${pass.code}`);
      }
      checkGeneratedVarScoping(pass.code, `${ex.name} / ${pass.kind}`);
    }
  });
}

// ADR-0017 の回帰テスト: range n |> map f |> blendAll k が大 N(BLEND_UNROLL_LIMIT
// 超え)で WGSL ループに畳み込まれる際、ループ非依存の定数(defaultColour の
// アルファ成分など)がループ本体の中から親スコープへ巻き上げられる。この巻き
// 上げが for(...) { より前に正しく配置されているかを検証する
// (このテストが無い間、wgsl_reflect は素通ししてしまっていた)。
for (const n of [6, 25, 60, 500]) {
  test(`WGSL ブロックスコープ: メタボール blendAll ループ化 N=${n}`, () => {
    const src = `balls = range ${n}
      |> map \\i ->
           sphere 0.4
           |> move [ sin (time + i * 2.1) * 1.5
                   , cos (time * 1.3 + i) * 1.0
                   , sin (time * 0.7 + i * 4.0) ]
      |> blendAll 0.7

out (render (orbit 5 0) (balls |> shade (sun [1,1,1])))`;
    const r = compile(src);
    assert.ok(r.program, JSON.stringify(r.diagnostics));
    for (const pass of r.program!.passes) {
      const parser = new WgslParser();
      parser.parse(pass.code); // 構文エラーなら例外で fail
      checkGeneratedVarScoping(pass.code, `blendAll N=${n} / ${pass.kind}`);
    }
  });
}
