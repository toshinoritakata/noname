// 標準ライブラリ(dream-code.md 総括「合成子の族」の実装)。
// 各 builtin は staging 時に IR を組み立てる。値レベルの関数は `lifted` で
// 場(Field)への自動リフトを持つ(スカラー昇格の一般化)。
//
// このファイルはバレル: カテゴリ別の実装は src/compiler/stdlib/ 以下に分割されている。
// 公開インターフェース(getBuiltin / stageWgslBlock / GlslFrontend)はここから変わらず提供する。

import type { Span } from "./diag.ts";
import type { Ctx, Value, VBuiltin } from "./value.ts";
import type { AddFn, AddVFn } from "./stdlib/shared.ts";
import { installMath } from "./stdlib/math.ts";
import { installNoise } from "./stdlib/noise.ts";
import { installShapes } from "./stdlib/shapes.ts";
import { installColor } from "./stdlib/color.ts";
import { installPostfx } from "./stdlib/postfx.ts";
import { installTime } from "./stdlib/time.ts";
import { installSimulate } from "./stdlib/simulate.ts";
import { installPhysics3D } from "./stdlib/physics3d.ts";
import { installIteration } from "./stdlib/iteration.ts";
import { installInputs } from "./stdlib/inputs.ts";

export { stageWgslBlock, type GlslFrontend } from "./stdlib/ffi.ts";

// ---- builtin 表 -----------------------------------------------------------------

let cache: Map<string, (ctx: Ctx, span: Span) => Value> | null = null;

export function getBuiltin(ctx: Ctx, name: string, span: Span): Value | undefined {
  if (!cache) cache = buildTable();
  const f = cache.get(name);
  return f ? f(ctx, span) : undefined;
}

function buildTable(): Map<string, (ctx: Ctx, span: Span) => Value> {
  const t = new Map<string, (ctx: Ctx, span: Span) => Value>();
  const add: AddFn = (name, f) => {
    t.set(name, f);
  };
  const addV: AddVFn = (name, v: VBuiltin) => {
    add(name, () => v);
  };

  installTime(add, addV);
  installColor(add, addV);
  installMath(add, addV);
  installNoise(add, addV);
  installShapes(add, addV);
  installPostfx(add, addV);
  installSimulate(add, addV);
  installPhysics3D(add, addV);
  installIteration(add, addV);
  installInputs(add, addV);

  return t;
}
