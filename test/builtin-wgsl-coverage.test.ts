// builtin 登録の名前空間適合テスト(改善提案「builtin 登録を deep interface に集約する」の
// 安全なスコープ版)。stdlib/*.ts が call() / mathFn() に渡す WGSL 関数名は、必ず
// WGSL 組み込み(WGSL_BUILTIN)か LIB のどちらかで解決できなければならない。
// 満たさないと generateWGSL 内で `LIB[n].src` が undefined になり、わかりにくい場所で
// クラッシュする(候補となるバグが実際に一箇所あった wgsl.ts の LIB ルックアップを参照)。
// stdlib は文字列でしか名前を渡さないため、正規表現でソースを静的走査し
// wgslCanResolveCall() という1つの窓口に照らし合わせる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wgslCanResolveCall } from "../src/compiler/wgsl.ts";

const here = dirname(fileURLToPath(import.meta.url));
const stdlibDir = join(here, "..", "src", "compiler", "stdlib");

function collectCallNames(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const record = (name: string, file: string) => {
    if (!found.has(name)) found.set(name, []);
    found.get(name)!.push(file);
  };
  for (const file of readdirSync(stdlibDir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(stdlibDir, file), "utf8");
    // call(ctx, "name", ...) / call(c, "name", ...)
    for (const m of src.matchAll(/\bcall\(\s*\w+,\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g)) {
      record(m[1], file);
    }
    // mathFn("name", "wgslName", ...) — 第2引数(WGSL 側に渡る名前)だけを見る
    for (const m of src.matchAll(/\bmathFn\(\s*"[a-zA-Z_][a-zA-Z0-9_]*"\s*,\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g)) {
      record(m[1], file);
    }
  }
  return found;
}

test("stdlib が WGSL へ渡す call 名は全て WGSL_BUILTIN か LIB で解決できる", () => {
  const names = collectCallNames();
  assert.ok(names.size > 10, `stdlib から抽出できた call 名が少なすぎる(走査ロジックの回帰疑い): ${names.size}`);
  const unresolved: string[] = [];
  for (const [name, files] of names) {
    if (!wgslCanResolveCall(name)) unresolved.push(`${name}(${files.join(",")})`);
  }
  assert.deepEqual(unresolved, [], `WGSL 側で解決できない builtin 名: ${unresolved.join(", ")}`);
});
