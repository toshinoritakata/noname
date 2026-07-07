// 値の算術リフトと型変換。
// - スカラー昇格(ADR-0009): Float は必要な場所で定数場に自動リフト
// - Field 同士・Field とスカラーの算術は点ごとの合成(クロージャ合成)
// - Shape → Image(flatten)、リスト → ベクトル などの暗黙変換もここ
// - cycle パターンの select/mix 展開(implementation.md 5.4)

import { CompileError, type Span } from "./diag.ts";
import { vecType, type NodeId } from "./ir.ts";
import type {
  Ctx,
  Dim,
  SimHandle,
  StripBatchSpec,
  Value,
  VBool,
  VField,
  VNum,
  VPattern,
  VShape,
  VVec,
} from "./value.ts";

// ---- 基本コンストラクタ --------------------------------------------------------

export function num(ir: NodeId, sval?: number): VNum {
  return sval === undefined ? { v: "num", ir } : { v: "num", ir, sval };
}
export function boolV(ir: NodeId, sval?: boolean): VBool {
  return sval === undefined ? { v: "bool", ir } : { v: "bool", ir, sval };
}
export function vecV(n: 2 | 3 | 4, ir: NodeId, sval?: number[]): VVec {
  return sval === undefined ? { v: "vec", n, ir } : { v: "vec", n, ir, sval };
}

export function constF(ctx: Ctx, v: number): VNum {
  return num(ctx.arena.node({ k: "const", v, t: "f32" }), v);
}
export function constVec(ctx: Ctx, vals: number[]): VVec {
  const parts = vals.map((v) => ctx.arena.node({ k: "const", v, t: "f32" }));
  return vecV(
    vals.length as 2 | 3 | 4,
    ctx.arena.node({ k: "vec", parts, t: vecType(vals.length) as "vec2" | "vec3" | "vec4" }),
    vals,
  );
}
export function inputNum(ctx: Ctx, name: string): VNum {
  return num(ctx.arena.node({ k: "input", name, t: "f32" }));
}
export function timeNode(ctx: Ctx): NodeId {
  return ctx.timeStack.length > 0
    ? ctx.timeStack[ctx.timeStack.length - 1]
    : ctx.arena.node({ k: "input", name: "time", t: "f32" });
}
export function call(ctx: Ctx, fn: string, args: NodeId[], t: "f32" | "bool" | "vec2" | "vec3" | "vec4"): NodeId {
  return ctx.arena.node({ k: "call", fn, args, t });
}

// ---- 型の言い換え辞書(ADR-0009: ドメイン語彙でのエラー) ------------------------

export function describe(v: Value): string {
  switch (v.v) {
    case "num":
      return "数(シグナル)";
    case "bool":
      return "真偽値";
    case "vec":
      return `${v.n}次元ベクトル`;
    case "dur":
      return "時間の長さ";
    case "str":
      return "文字列";
    case "clo":
    case "bi":
      return "関数";
    case "field":
      return v.dim === 2 ? "2Dの場" : v.dim === 3 ? "3Dの場" : "場";
    case "shape":
      return v.dim === 3 ? "3D図形(SDF)" : "図形(SDF)";
    case "cam":
      return "カメラ";
    case "light":
      return "ライト";
    case "list":
      return `リスト(${v.items.length}要素)`;
    case "rec":
      return "レコード";
    case "sim":
      return `シミュレーション場 \`${v.handle.name}\``;
    case "pat":
      return "時間パターン";
  }
}

export function fail(msg: string, span: Span): never {
  throw new CompileError(msg, span);
}

// ---- 次元 --------------------------------------------------------------------

export function unifyDim(a: Dim, b: Dim, span: Span): Dim {
  if (a === 0) return b;
  if (b === 0) return a;
  if (a === b) return a;
  fail(`次元が合いません: ${a}D と ${b}D`, span);
}

// ---- 変換 --------------------------------------------------------------------

export function asNum(v: Value, span: Span): VNum {
  if (v.v === "num") return v;
  if (v.v === "dur") return num(v.ir, v.sval);
  if (v.v === "bool") return v as unknown as VNum; // bool→num は WGSL 側で select
  fail(`数が必要ですが、${describe(v)} が渡されました`, span);
}

/** 静的に決まる数(構造定数)を要求する(implementation.md 3.2-2) */
export function staticNum(v: Value, what: string, span: Span): number {
  if ((v.v === "num" || v.v === "dur") && v.sval !== undefined) return v.sval;
  fail(`${what}は静的に決まる必要があります(数値リテラルか、その定数演算で書いてください)`, span);
}

export function asVec(ctx: Ctx, v: Value, span: Span, n?: 2 | 3 | 4): VVec {
  if (v.v === "vec") {
    if (n && v.n !== n) fail(`${n}次元ベクトルが必要ですが、${v.n}次元ベクトルが渡されました`, span);
    return v;
  }
  if (v.v === "list") {
    const parts = v.items.map((it) => asNum(it, span));
    const len = parts.length;
    if (len < 2 || len > 4) fail(`ベクトルは2〜4要素です(${len}要素のリストが渡されました)`, span);
    if (n && len !== n) fail(`${n}次元ベクトルが必要ですが、${len}要素のリストが渡されました`, span);
    const svals = parts.map((p) => p.sval);
    return vecV(
      len as 2 | 3 | 4,
      ctx.arena.node({ k: "vec", parts: parts.map((p) => p.ir), t: vecType(len) as "vec2" | "vec3" | "vec4" }),
      svals.every((s) => s !== undefined) ? (svals as number[]) : undefined,
    );
  }
  fail(`ベクトルが必要ですが、${describe(v)} が渡されました`, span);
}

/** 色として解釈(vec3 → alpha 1 を補う) */
export function asColor(ctx: Ctx, v: Value, span: Span): VVec {
  if (v.v === "vec" && v.n === 4) return v;
  if (v.v === "vec" && v.n === 3) {
    const one = ctx.arena.node({ k: "const", v: 1, t: "f32" });
    return vecV(4, ctx.arena.node({ k: "vec", parts: [v.ir, one], t: "vec4" }));
  }
  if (v.v === "num") {
    const one = ctx.arena.node({ k: "const", v: 1, t: "f32" });
    return vecV(4, ctx.arena.node({ k: "vec", parts: [v.ir, v.ir, v.ir, one], t: "vec4" }));
  }
  if (v.v === "list") return asColor(ctx, asVec(ctx, v, span), span);
  fail(`色が必要ですが、${describe(v)} が渡されました`, span);
}

/** 場へのリフト。数・ベクトル・色は定数場に、関数(座標→値)は場になる */
export function toField(ctx: Ctx, v: Value, span: Span): VField {
  if (v.v === "field") return v;
  if (v.v === "sim") return simToField(ctx, v.handle);
  if (v.v === "num" || v.v === "vec" || v.v === "bool") {
    return { v: "field", dim: 0, fn: () => v };
  }
  if (v.v === "clo" || v.v === "bi") {
    return { v: "field", dim: 0, fn: (c, p, s) => c.apply(c, v, p, s) };
  }
  if (v.v === "pat") {
    return lowerPattern(ctx, v, span, (item) => toField(ctx, item, span)) as VField;
  }
  fail(`場が必要ですが、${describe(v)} が渡されました`, span);
}

/** 画像(2Dの色場)へのリフト。Shape2 は flatten(外側透明)される */
export function toImage(ctx: Ctx, v: Value, span: Span): VField {
  if (v.v === "shape") {
    const sh = v;
    if (sh.dim === 3) fail("3D図形はそのまま画像にできません。`render カメラ 図形` を通してください", span);
    if (sh.strip2D) {
      // line/bezier 単体(scatterしていない)は dist を持たない(ADR-0037)ので、
      // ここで dist に一切触れず、インスタンス数1のバッチとして直接登録する
      // (scatter 集約後の stripBatches と同じ描画経路に乗せる)
      const id = ctx.arena.freshLoopId();
      const batch: StripBatchSpec = {
        count: 1,
        loopId: id,
        p0IR: sh.strip2D.p0.ir,
        p1IR: sh.strip2D.p1.ir,
        p2IR: sh.strip2D.p2.ir,
        widthIR: sh.strip2D.width.ir,
        colourIR: sh.strip2D.colour.ir,
      };
      return {
        v: "field",
        dim: 2,
        fn: (c) => {
          const zero = c.arena.node({ k: "const", v: 0, t: "f32" });
          return vecV(4, c.arena.node({ k: "vec", parts: [zero, zero, zero, zero], t: "vec4" }));
        },
        stripBatches: [batch],
      };
    }
    return {
      v: "field",
      dim: 2,
      fn: (c, p, s) => {
        const d = sh.dist(c, p, s);
        const col = sh.colour(c, p, s);
        // アンチエイリアス: px = 1ピクセルのワールド幅(ランタイム供給)
        const px = c.arena.node({ k: "input", name: "px", t: "f32" });
        const negPx = c.arena.node({ k: "un", op: "neg", a: px, t: "f32" });
        const alpha = call(c, "smoothstep", [px, negPx, d.ir], "f32");
        const a0 = c.arena.node({ k: "swiz", a: col.ir, sel: "w", t: "f32" });
        const aa = c.arena.node({ k: "bin", op: "*", a: alpha, b: a0, t: "f32" });
        const rgb = c.arena.node({ k: "swiz", a: col.ir, sel: "xyz", t: "vec3" });
        return vecV(4, c.arena.node({ k: "vec", parts: [rgb, aa], t: "vec4" }));
      },
      stripBatches: sh.stripBatches,
    };
  }
  if (v.v === "field" || v.v === "sim") {
    const f = toField(ctx, v, span);
    return liftField(f, (c, p, s) => asColorValue(c, f.fn(c, p, s), s), 2);
  }
  if (v.v === "vec" || v.v === "num") {
    const col = asColor(ctx, v, span);
    return { v: "field", dim: 2, fn: () => col };
  }
  if (v.v === "pat") {
    return lowerPattern(ctx, v, span, (item) => toImage(ctx, item, span)) as VField;
  }
  fail(`画像(2Dの色場)が必要ですが、${describe(v)} が渡されました`, span);
}

/** 場のサンプル結果を色に揃える */
function asColorValue(ctx: Ctx, v: Value, span: Span): VVec {
  if (v.v === "vec" && v.n === 4) return v;
  if (v.v === "vec" && v.n === 2) {
    // 2ch は (x, y, 0, 1)
    const zero = ctx.arena.node({ k: "const", v: 0, t: "f32" });
    const one = ctx.arena.node({ k: "const", v: 1, t: "f32" });
    return vecV(4, ctx.arena.node({ k: "vec", parts: [v.ir, zero, one], t: "vec4" }));
  }
  return asColor(ctx, v, span);
}

export function toShape(ctx: Ctx, v: Value, span: Span): VShape {
  if (v.v === "shape") return v;
  if (v.v === "pat") {
    return lowerPattern(ctx, v, span, (item) => toShape(ctx, item, span)) as VShape;
  }
  fail(`図形(SDF)が必要ですが、${describe(v)} が渡されました`, span);
}

// ---- 算術のリフト --------------------------------------------------------------

function foldConst(op: string, a?: number, b?: number): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? undefined : a / b;
    case "%":
      return b === 0 ? undefined : ((a % b) + b) % b;
    default:
      return undefined;
  }
}

const CMP = new Set(["<", ">", "<=", ">=", "==", "!="]);

/** 二項演算の総合ディスパッチ(場・図形・画像へのリフト込み) */
export function binValue(ctx: Ctx, op: string, a: Value, b: Value, span: Span): Value {
  // パターンはまず展開
  if (a.v === "pat") a = lowerPattern(ctx, a, span, (x) => x);
  if (b.v === "pat") b = lowerPattern(ctx, b, span, (x) => x);

  if (op === "<+>") {
    return shapeUnion(ctx, toShape(ctx, a, span), toShape(ctx, b, span), span);
  }
  if (op === "<over>") {
    return imageOver(ctx, toImage(ctx, a, span), toImage(ctx, b, span), span);
  }
  if (op === "<>") {
    fail("`<>`(クロスフェード)は out の直後にだけ書けます", span);
  }

  // 図形の算術は誤りやすいので明示エラー
  if (a.v === "shape" || b.v === "shape") {
    fail(
      `図形同士の \`${op}\` はできません(合成には <+> / cut / inter / morph を使います)`,
      span,
    );
  }

  // 場が絡むなら点ごとの合成にリフト
  if (a.v === "field" || b.v === "field" || a.v === "sim" || b.v === "sim") {
    const fa = a.v === "field" || a.v === "sim" ? toField(ctx, a, span) : null;
    const fb = b.v === "field" || b.v === "sim" ? toField(ctx, b, span) : null;
    const dim = unifyDim(fa ? fa.dim : 0, fb ? fb.dim : 0, span);
    const ca = a;
    const cb = b;
    return {
      v: "field",
      dim,
      fn: (c, p, s) => binValue(c, op, fa ? fa.fn(c, p, s) : ca, fb ? fb.fn(c, p, s) : cb, s),
    } as VField;
  }

  // 関数値(クロージャ)同士の算術: 引数を先送りしてリフト(warp 合成などで使う)
  if (a.v === "clo" || a.v === "bi" || b.v === "clo" || b.v === "bi") {
    fail(`関数に \`${op}\` は適用できません(先に引数を与えてください)`, span);
  }

  const an = a.v === "dur" ? num(a.ir, a.sval) : a;
  const bn = b.v === "dur" ? num(b.ir, b.sval) : b;

  if (CMP.has(op)) {
    const x = asNum(an, span);
    const y = asNum(bn, span);
    const irOp = op as "<" | ">" | "<=" | ">=" | "==" | "!=";
    return boolV(ctx.arena.node({ k: "bin", op: irOp, a: x.ir, b: y.ir, t: "bool" }));
  }

  const irOp = op as "+" | "-" | "*" | "/" | "%";
  if (an.v === "num" && bn.v === "num") {
    return num(
      ctx.arena.node({ k: "bin", op: irOp, a: an.ir, b: bn.ir, t: "f32" }),
      foldConst(op, an.sval, bn.sval),
    );
  }
  const av = an.v === "vec" ? an : an.v === "list" ? asVec(ctx, an, span) : null;
  const bv = bn.v === "vec" ? bn : bn.v === "list" ? asVec(ctx, bn, span) : null;
  if (av && bv) {
    if (av.n !== bv.n) fail(`ベクトルの次元が合いません: ${av.n} と ${bv.n}`, span);
    return vecV(av.n, ctx.arena.node({ k: "bin", op: irOp, a: av.ir, b: bv.ir, t: vecType(av.n) }));
  }
  if (av && bn.v === "num") {
    return vecV(av.n, ctx.arena.node({ k: "bin", op: irOp, a: av.ir, b: bn.ir, t: vecType(av.n) }));
  }
  if (an.v === "num" && bv) {
    return vecV(bv.n, ctx.arena.node({ k: "bin", op: irOp, a: an.ir, b: bv.ir, t: vecType(bv.n) }));
  }
  fail(`\`${op}\` は ${describe(a)} と ${describe(b)} には適用できません`, span);
}

export function negValue(ctx: Ctx, v: Value, span: Span): Value {
  if (v.v === "num") {
    return num(ctx.arena.node({ k: "un", op: "neg", a: v.ir, t: "f32" }), v.sval === undefined ? undefined : -v.sval);
  }
  if (v.v === "dur") return negValue(ctx, num(v.ir, v.sval), span);
  if (v.v === "vec") {
    return vecV(v.n, ctx.arena.node({ k: "un", op: "neg", a: v.ir, t: vecType(v.n) }));
  }
  if (v.v === "field") {
    const f = v;
    return { v: "field", dim: f.dim, fn: (c, p, s) => negValue(c, f.fn(c, p, s), s) } as VField;
  }
  if (v.v === "list") return negValue(ctx, asVec(ctx, v, span), span);
  fail(`${describe(v)} は負にできません`, span);
}

// ---- select / mix(if と morph の実体) ----------------------------------------

export function selectValue(ctx: Ctx, cond: Value, a: Value, b: Value, span: Span): Value {
  if (cond.v === "bool" && cond.sval !== undefined) return cond.sval ? a : b;
  // 条件が場なら全体を場にリフト
  if (cond.v === "field" || a.v === "field" || b.v === "field" || a.v === "sim" || b.v === "sim") {
    const fc = cond.v === "field" ? cond : null;
    const fa = a.v === "field" || a.v === "sim" ? toField(ctx, a, span) : null;
    const fb = b.v === "field" || b.v === "sim" ? toField(ctx, b, span) : null;
    const dim = unifyDim(unifyDim(fc ? fc.dim : 0, fa ? fa.dim : 0, span), fb ? fb.dim : 0, span);
    // stripBatches(scatter 集約後の instanced 描画バッチ)は選ばれなかった側の分も
    // 無条件で引き継ぐ。dist が無いためフォールバック手段がなく、落とすと消える
    const stripBatches = [...(fa?.stripBatches ?? []), ...(fb?.stripBatches ?? [])];
    return {
      v: "field",
      dim,
      fn: (c, p, s) =>
        selectValue(c, fc ? fc.fn(c, p, s) : cond, fa ? fa.fn(c, p, s) : a, fb ? fb.fn(c, p, s) : b, s),
      stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
    } as VField;
  }
  if (cond.v !== "bool") fail(`if の条件は真偽値が必要ですが、${describe(cond)} です`, span);
  const c = cond.ir;
  const merge = (x: Value, y: Value): Value => {
    // レコードの中に場が残っているケース(simulate の更新則など)は場にリフト
    if (x.v === "field" || y.v === "field" || x.v === "sim" || y.v === "sim") {
      const fx = toField(ctx, x, span);
      const fy = toField(ctx, y, span);
      const dim = unifyDim(fx.dim, fy.dim, span);
      const stripBatches = [...(fx.stripBatches ?? []), ...(fy.stripBatches ?? [])];
      return {
        v: "field",
        dim,
        fn: (cc, p, s) => selectValue(cc, boolV(c), fx.fn(cc, p, s), fy.fn(cc, p, s), s),
        stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
      } as VField;
    }
    if (x.v === "num" && y.v === "num") {
      return num(ctx.arena.node({ k: "select", c, a: x.ir, b: y.ir, t: "f32" }));
    }
    if ((x.v === "vec" || x.v === "list") && (y.v === "vec" || y.v === "list")) {
      const xv = asVec(ctx, x, span);
      const yv = asVec(ctx, y, span);
      if (xv.n !== yv.n) fail(`then と else のベクトル次元が合いません: ${xv.n} と ${yv.n}`, span);
      return vecV(xv.n, ctx.arena.node({ k: "select", c, a: xv.ir, b: yv.ir, t: vecType(xv.n) }));
    }
    if (x.v === "rec" && y.v === "rec") {
      const fields = new Map<string, Value>();
      for (const [k, xv] of x.fields) {
        const yv = y.fields.get(k);
        if (!yv) fail(`then と else のレコードの形が違います(\`${k}\` がありません)`, span);
        fields.set(k, merge(xv, yv));
      }
      return { v: "rec", fields };
    }
    if (x.v === "shape" && y.v === "shape") {
      const dim = unifyDim(x.dim, y.dim, span);
      const xs = x;
      const ys = y;
      // spriteBatches/stripBatches/strip3Batches(集約後)はどちらの枝が選ばれても
      // 無条件で引き継ぐ(shapeUnion と同じ理由)。sprite/strip2D/strip3D(集約前の
      // 単項マーカー)は二項combinatorで意味が壊れるため明示的に落とす(= 安全に SDF フォールバック)
      const spriteBatches = [...(xs.spriteBatches ?? []), ...(ys.spriteBatches ?? [])];
      const stripBatches = [...(xs.stripBatches ?? []), ...(ys.stripBatches ?? [])];
      const strip3Batches = [...(xs.strip3Batches ?? []), ...(ys.strip3Batches ?? [])];
      return {
        v: "shape",
        dim,
        dist: (cx, p, s) =>
          num(cx.arena.node({ k: "select", c, a: xs.dist(cx, p, s).ir, b: ys.dist(cx, p, s).ir, t: "f32" })),
        colour: (cx, p, s) =>
          vecV(4, cx.arena.node({ k: "select", c, a: xs.colour(cx, p, s).ir, b: ys.colour(cx, p, s).ir, t: "vec4" })),
        sprite: undefined,
        strip2D: undefined,
        strip3D: undefined,
        spriteBatches: spriteBatches.length > 0 ? spriteBatches : undefined,
        stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
        strip3Batches: strip3Batches.length > 0 ? strip3Batches : undefined,
      } as VShape;
    }
    fail(`then と else の型が合いません: ${describe(x)} と ${describe(y)}`, span);
  };
  return merge(a, b);
}

/** 線形補間の総合版(morph / パターン境界のブレンドに使う) */
export function mixValue(ctx: Ctx, a: Value, b: Value, t: VNum, span: Span): Value {
  if (a.v === "field" || b.v === "field" || a.v === "sim" || b.v === "sim") {
    const fa = toField(ctx, a, span);
    const fb = toField(ctx, b, span);
    const dim = unifyDim(fa.dim, fb.dim, span);
    const stripBatches = [...(fa.stripBatches ?? []), ...(fb.stripBatches ?? [])];
    return {
      v: "field",
      dim,
      fn: (c, p, s) => mixValue(c, fa.fn(c, p, s), fb.fn(c, p, s), t, s),
      stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
    } as VField;
  }
  if (a.v === "shape" && b.v === "shape") {
    const dim = unifyDim(a.dim, b.dim, span);
    const as_ = a;
    const bs = b;
    // selectValue と同じ理由: spriteBatches/stripBatches/strip3Batches は無条件で引き継ぎ、
    // sprite/strip2D/strip3D(単項マーカー)は補間で意味が壊れるため明示的に落とす
    const spriteBatches = [...(as_.spriteBatches ?? []), ...(bs.spriteBatches ?? [])];
    const stripBatches = [...(as_.stripBatches ?? []), ...(bs.stripBatches ?? [])];
    const strip3Batches = [...(as_.strip3Batches ?? []), ...(bs.strip3Batches ?? [])];
    return {
      v: "shape",
      dim,
      dist: (c, p, s) =>
        num(call(c, "mix", [as_.dist(c, p, s).ir, bs.dist(c, p, s).ir, t.ir], "f32")),
      colour: (c, p, s) =>
        vecV(4, call(c, "mix", [as_.colour(c, p, s).ir, bs.colour(c, p, s).ir, t.ir], "vec4")),
      sprite: undefined,
      strip2D: undefined,
      strip3D: undefined,
      spriteBatches: spriteBatches.length > 0 ? spriteBatches : undefined,
      stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
      strip3Batches: strip3Batches.length > 0 ? strip3Batches : undefined,
    } as VShape;
  }
  if (a.v === "num" && b.v === "num") {
    return num(call(ctx, "mix", [a.ir, b.ir, t.ir], "f32"));
  }
  const av = a.v === "vec" || a.v === "list" ? asVec(ctx, a, span) : null;
  const bv = b.v === "vec" || b.v === "list" ? asVec(ctx, b, span) : null;
  if (av && bv && av.n === bv.n) {
    return vecV(av.n, call(ctx, "mix", [av.ir, bv.ir, t.ir], vecType(av.n) as "vec2" | "vec3" | "vec4"));
  }
  if (a.v === "rec" && b.v === "rec") {
    const fields = new Map<string, Value>();
    for (const [k, xv] of a.fields) {
      const yv = b.fields.get(k);
      if (!yv) fail(`morph するレコードの形が違います(\`${k}\` がありません)`, span);
      fields.set(k, mixValue(ctx, xv, yv, t, span));
    }
    return { v: "rec", fields };
  }
  fail(`${describe(a)} と ${describe(b)} は補間できません`, span);
}

// ---- 図形・画像の合成 -----------------------------------------------------------

/** base を丸ごと引き継ぎ、fn(と必要なら dim)だけ差し替えて場をリフトする。
 * state/stripBatches は「fn が何をしようと安全に持ち越せる」性質なので無条件で継承する */
export function liftField(base: VField, fn: VField["fn"], dim: Dim = base.dim): VField {
  return { ...base, dim, fn };
}

/**
 * dist を変える図形合成子の共通リフト。spriteBatches/stripBatches(scatter 集約後の
 * instanced 描画バッチ)は dist を書き換えても描画実体は別パスなので無条件で base
 * から継承する。一方 sprite/strip2D(集約前の単項マーカー、ADR-0014/0016)は
 * 「中心・半径・制御点が座標に依存しない」という前提を dist の変更が壊しうるため、
 * 呼び出し側に(undefined でもよいので)必ず明示させる — 書き忘れて安全側に転ぶバグを
 * 型で防ぐ。colour は省略時 base.colour のまま(dist だけの変更なら十分)。
 * warp 系のように colour も座標変換で変わる場合は明示的に渡す
 */
export function liftDist(
  base: VShape,
  dist: VShape["dist"],
  opts: { colour?: VShape["colour"]; sprite: VShape["sprite"]; strip2D: VShape["strip2D"]; strip3D: VShape["strip3D"] },
): VShape {
  return {
    ...base,
    dist,
    colour: opts.colour ?? base.colour,
    sprite: opts.sprite,
    strip2D: opts.strip2D,
    strip3D: opts.strip3D,
  };
}

/**
 * `outline w x` の実体。line/bezier の strip2D/strip3D は幅を更新しつつ引き継ぐ。
 * `stdlib/shapes.ts` の `outline` ビルトインと、line/bezier が返す Shape に数値を
 * 直接適用したとき(`line a b w`、ADR-0038)の両方から呼ばれる共通実装
 */
export function outlineShape(ctx: Ctx, sh: VShape, wn: VNum, span: Span): VShape {
  return liftDist(
    sh,
    (c, p, s) => {
      const d = call(c, "abs", [sh.dist(c, p, s).ir], "f32");
      return num(c.arena.node({ k: "bin", op: "-", a: d, b: wn.ir, t: "f32" }));
    },
    {
      // outline は abs(d)-w で「点」を帯に太らせるので、sprite(塗りつぶし円板の
      // instanced 描画)の前提と食い違う —— 明示的に落とす。line/bezier の
      // strip2D/strip3D(ADR-0016/0036)だけは幅を更新しつつ引き継ぐ
      sprite: undefined,
      strip2D: sh.strip2D ? { ...sh.strip2D, width: wn } : undefined,
      strip3D: sh.strip3D ? { ...sh.strip3D, width: wn } : undefined,
    },
  );
}

export function shapeUnion(ctx: Ctx, a: VShape, b: VShape, span: Span): VShape {
  const dim = unifyDim(a.dim, b.dim, span);
  // スプライト/ストリップバッチ(scatter の instanced 描画。ADR-0014/0016)は合成後も
  // 引き継ぐ。バッチを持つ側の dist は定数 +∞ にすり替え済みなので、通常の min/select
  // ロジックはそのまま安全に動く(常に「実体のある側」が選ばれる)。この2つは
  // 「集約後は無条件で継承」が唯一の正しい選択で、落とすと該当図形が描画されず消える
  // (集約前の sprite/strip2D と違い、dist の SDF フォールバックが存在しないため)
  const spriteBatches = [...(a.spriteBatches ?? []), ...(b.spriteBatches ?? [])];
  const stripBatches = [...(a.stripBatches ?? []), ...(b.stripBatches ?? [])];
  const strip3Batches = [...(a.strip3Batches ?? []), ...(b.strip3Batches ?? [])];
  return {
    v: "shape",
    dim,
    dist: (c, p, s) => {
      const da = a.dist(c, p, s);
      const db = b.dist(c, p, s);
      return num(call(c, "min", [da.ir, db.ir], "f32"));
    },
    colour: (c, p, s) => {
      const da = a.dist(c, p, s);
      const db = b.dist(c, p, s);
      const cond = c.arena.node({ k: "bin", op: "<", a: da.ir, b: db.ir, t: "bool" });
      const ca = a.colour(c, p, s);
      const cb = b.colour(c, p, s);
      return vecV(4, c.arena.node({ k: "select", c: cond, a: ca.ir, b: cb.ir, t: "vec4" }));
    },
    spriteBatches: spriteBatches.length > 0 ? spriteBatches : undefined,
    stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
    strip3Batches: strip3Batches.length > 0 ? strip3Batches : undefined,
  };
}

/** アルファ合成(over)。左が上 */
export function imageOver(ctx: Ctx, top: VField, bottom: VField, span: Span): VField {
  const stripBatches = [...(top.stripBatches ?? []), ...(bottom.stripBatches ?? [])];
  return {
    v: "field",
    dim: 2,
    fn: (c, p, s) => {
      const ta = asColorValue(c, top.fn(c, p, s), s);
      const ba = asColorValue(c, bottom.fn(c, p, s), s);
      return vecV(4, call(c, "overBlend", [ta.ir, ba.ir], "vec4"));
    },
    stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
  };
}

// ---- パターンの展開(cycle / morph) --------------------------------------------

export function lowerPattern(
  ctx: Ctx,
  pat: VPattern,
  span: Span,
  coerce: (item: Value) => Value,
): Value {
  const n = pat.items.length;
  if (n === 0) fail("cycle のリストが空です", span);
  const items = pat.items.map(coerce);
  if (n === 1) return items[0];

  const t = timeNode(ctx);
  const a = ctx.arena;
  // ph = (time / dur) mod n
  const cyc = a.node({ k: "bin", op: "/", a: t, b: pat.durSec, t: "f32" });
  const nConst = a.node({ k: "const", v: n, t: "f32" });
  const ph = a.node({ k: "bin", op: "%", a: cyc, b: nConst, t: "f32" });
  const i0 = call(ctx, "floor", [ph], "f32");
  const frac = a.node({ k: "bin", op: "-", a: ph, b: i0, t: "f32" });

  // morph 幅 w: frac > 1-w の区間で次の要素へ補間
  let blended: Value[] = items;
  if (pat.morph !== null) {
    const w = pat.morph;
    const oneMinusW = a.node({
      k: "bin",
      op: "-",
      a: a.node({ k: "const", v: 1, t: "f32" }),
      b: w,
      t: "f32",
    });
    const tt = call(
      ctx,
      "clamp",
      [
        a.node({
          k: "bin",
          op: "/",
          a: a.node({ k: "bin", op: "-", a: frac, b: oneMinusW, t: "f32" }),
          b: call(ctx, "max", [w, a.node({ k: "const", v: 1e-4, t: "f32" })], "f32"),
          t: "f32",
        }),
        a.node({ k: "const", v: 0, t: "f32" }),
        a.node({ k: "const", v: 1, t: "f32" }),
      ],
      "f32",
    );
    blended = items.map((item, k) => mixValue(ctx, item, items[(k + 1) % n], num(tt), span));
  }

  // select 連鎖: i0 == k
  let acc: Value = blended[n - 1];
  for (let k = n - 2; k >= 0; k--) {
    const kConst = a.node({ k: "const", v: k, t: "f32" });
    const cond = boolV(a.node({ k: "bin", op: "<", a: i0, b: a.node({ k: "bin", op: "+", a: kConst, b: a.node({ k: "const", v: 0.5, t: "f32" }), t: "f32" }), t: "bool" }));
    acc = selectValue(ctx, cond, blended[k], acc, span);
  }
  return acc;
}

// ---- simulate の状態アクセス -----------------------------------------------------

/** 状態テクスチャ(複数)を UV でサンプルして vec4 群を返す */
export function sampleStateAt(ctx: Ctx, handle: SimHandle, uv: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (let i = 0; i < handle.texCount; i++) {
    out.push(ctx.arena.node({ k: "sample", tex: handle.texKey(i), p: uv, t: "vec4" }));
  }
  return out;
}

export function fetchStateAt(ctx: Ctx, handle: SimHandle, idx: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (let i = 0; i < handle.texCount; i++) {
    out.push(ctx.arena.node({ k: "fetch", tex: handle.texKey(i), i: idx, t: "vec4" }));
  }
  return out;
}

/** チャネル [offset, len] を vec4 群から取り出す */
export function extractChannel(ctx: Ctx, texels: NodeId[], offset: number, len: number): Value {
  const texIdx = Math.floor(offset / 4);
  const inner = offset % 4;
  if (inner + len > 4) {
    // テクスチャ境界を跨ぐチャネルはパック時に禁止している
    fail("内部エラー: チャネルがテクスチャ境界を跨いでいます", { start: 0, end: 0 });
  }
  const sel = "xyzw".slice(inner, inner + len);
  const t = len === 1 ? "f32" : (vecType(len) as "vec2" | "vec3" | "vec4");
  const irNode = ctx.arena.node({ k: "swiz", a: texels[texIdx], sel, t });
  return len === 1 ? num(irNode) : vecV(len as 2 | 3 | 4, irNode);
}

/** 状態全体を Value(レコード / ベクトル / 数)に展開する */
export function unpackState(ctx: Ctx, handle: SimHandle, texels: NodeId[]): Value {
  if (handle.channels.length === 1 && handle.channels[0].path.length === 0) {
    const ch = handle.channels[0];
    return extractChannel(ctx, texels, ch.offset, ch.len);
  }
  const fields = new Map<string, Value>();
  for (const ch of handle.channels) {
    // 1階層のレコードのみ(パック時に保証)
    fields.set(ch.path[0], extractChannel(ctx, texels, ch.offset, ch.len));
  }
  return { v: "rec", fields };
}

/** UV: ワールド座標(短辺 -1..1)→ [0,1]² */
export function worldToUv(ctx: Ctx, p: NodeId): NodeId {
  return call(ctx, "worldToUv", [p], "vec2");
}

/** simulate の結果を場として読む(rd.y |> ramp ... の rd) */
export function simToField(ctx: Ctx, handle: SimHandle): VField {
  if (handle.kind === "grid") {
    return {
      v: "field",
      dim: 2,
      fn: (c, p) => unpackState(c, handle, sampleStateAt(c, handle, simUv(c, handle, p.ir))),
      state: { handle, offset: 0, len: handle.totalFloats },
    };
  }
  return {
    v: "field",
    dim: 1,
    fn: (c, p) => {
      // 1D: p.x をインデックスとして読む
      const ix = c.arena.node({ k: "swiz", a: p.ir, sel: "x", t: "f32" });
      return unpackState(c, handle, fetchStateAt(c, handle, ix));
    },
    state: { handle, offset: 0, len: handle.totalFloats },
  };
}

/** グリッド状態のサンプル UV(状態テクスチャはワールド全域 [-1,1]² を覆う) */
export function simUv(ctx: Ctx, _handle: SimHandle, p: NodeId): NodeId {
  return call(ctx, "gridUv", [p], "vec2");
}
