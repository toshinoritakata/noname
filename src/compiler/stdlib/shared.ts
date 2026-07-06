// stdlib 全カテゴリから使われる汎用ヘルパー(元 stdlib.ts 60-163行)。
// 循環 import を避けるため、このファイルはカテゴリ別ファイルに依存してはいけない
// (value.ts/ops.ts/ir.ts/diag.ts のみに依存する)。

import type { Span } from "../diag.ts";
import { vecType, type IRType, type NodeId } from "../ir.ts";
import { asNum, asVec, call, constVec, describe, fail, lowerPattern, num, simToField, toField, vecV } from "../ops.ts";
import type { Ctx, Dim, Value, VBuiltin, VField, VNum, VShape, VVec } from "../value.ts";

/** builtin テーブルへの登録関数(ctx/span から値を作る遅延評価版) */
export type AddFn = (name: string, f: (ctx: Ctx, span: Span) => Value) => void;
/** builtin テーブルへの登録関数(値が固定な VBuiltin 版) */
export type AddVFn = (name: string, v: VBuiltin) => void;

export function bi(
  name: string,
  arity: number,
  impl: (ctx: Ctx, args: Value[], span: Span) => Value,
): VBuiltin {
  return { v: "bi", name, arity, args: [], impl };
}

export function rec(fields: [string, Value][]): Value {
  return { v: "rec", fields: new Map(fields) };
}

/** 引数のどれかが場なら、全体を場にリフトして点ごとに適用する */
export function lifted(
  name: string,
  arity: number,
  impl: (ctx: Ctx, args: Value[], span: Span) => Value,
): VBuiltin {
  const wrapped = (ctx: Ctx, args: Value[], span: Span): Value => {
    const fieldArgs = args.map((a) => (a.v === "field" ? a : a.v === "sim" ? simToField(ctx, a.handle) : null));
    if (fieldArgs.some((f) => f !== null)) {
      let dim: Dim = 0;
      for (const f of fieldArgs) if (f) dim = dim === 0 ? f.dim : dim;
      return {
        v: "field",
        dim,
        fn: (c, p, s) => wrapped(c, args.map((a, i) => (fieldArgs[i] ? fieldArgs[i]!.fn(c, p, s) : a)), s),
      } as VField;
    }
    return impl(ctx, args, span);
  };
  return bi(name, arity, wrapped);
}

export function numArg(v: Value, span: Span): VNum {
  return asNum(v, span);
}

/** 数学関数(num または vec に成分ごと)。resultT: 引数と同型 / 常に f32 など */
export function mathFn(name: string, wgslName: string, arity: number, result: "same" | "f32" | "vec3" = "same"): VBuiltin {
  return lifted(name, arity, (ctx, args, span) => {
    const irs: NodeId[] = [];
    let t: IRType = "f32";
    for (const a of args) {
      if (a.v === "vec") {
        irs.push(a.ir);
        if (t === "f32") t = vecType(a.n);
      } else if (a.v === "list") {
        const v = asVec(ctx, a, span);
        irs.push(v.ir);
        if (t === "f32") t = vecType(v.n);
      } else {
        irs.push(numArg(a, span).ir);
      }
    }
    const rt: IRType = result === "same" ? t : result === "f32" ? "f32" : "vec3";
    const node = call(ctx, wgslName, irs, rt as "f32" | "vec2" | "vec3" | "vec4");
    if (rt === "f32") return num(node);
    return vecV((rt === "vec2" ? 2 : rt === "vec3" ? 3 : 4) as 2 | 3 | 4, node);
  });
}

/** shape/field の座標を f: p → p' で変換する(warp の実体) */
export function warpValue(ctx: Ctx, f: (c: Ctx, p: VVec, s: Span) => VVec, target: Value, span: Span, distScale?: NodeId): Value {
  if (target.v === "shape") {
    const sh = target;
    return {
      v: "shape",
      dim: sh.dim,
      dist: (c, p, s) => {
        const d = sh.dist(c, f(c, p, s), s);
        return distScale ? num(c.arena.node({ k: "bin", op: "*", a: d.ir, b: distScale, t: "f32" })) : d;
      },
      colour: (c, p, s) => sh.colour(c, f(c, p, s), s),
    } as VShape;
  }
  if (target.v === "field" || target.v === "sim") {
    const fl = toField(ctx, target, span);
    return { v: "field", dim: fl.dim, fn: (c, p, s) => fl.fn(c, f(c, p, s), s) } as VField;
  }
  if (target.v === "pat") {
    // パターンはその場で展開してから変形する(cycle ... |> morph ... |> rot ... の形)
    return warpValue(ctx, f, lowerPattern(ctx, target, span, (x) => x), span, distScale);
  }
  fail(`変形できるのは図形か場ですが、${describe(target)} が渡されました`, span);
}

export function defaultColour(ctx: Ctx): VVec {
  return constVec(ctx, [0.92, 0.92, 0.9, 1]);
}

export function shape(dim: Dim, dist: VShape["dist"], colour?: VShape["colour"]): VShape {
  return {
    v: "shape",
    dim,
    dist,
    colour: colour ?? ((c) => defaultColour(c)),
  };
}

export function binIR(ctx: Ctx, op: "+" | "-" | "*" | "/" | "%", a: NodeId, b: NodeId, t: IRType): NodeId {
  return ctx.arena.node({ k: "bin", op, a, b, t });
}
