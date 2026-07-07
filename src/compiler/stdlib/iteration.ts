// grid / scatter / blendAll の機構(元 stdlib.ts 338-622行)と、
// 反復セクション(range/map/grid/scatter の登録、元1579行付近)。

import type { Span } from "../diag.ts";
import type { NodeId } from "../ir.ts";
import {
  asNum,
  binValue,
  call,
  constF,
  constVec,
  describe,
  fail,
  num,
  staticNum,
  toShape,
  vecV,
} from "../ops.ts";
import type { Ctx, SpriteBatchSpec, StripBatchSpec, Value, VBuiltin, VList, VNum, VShape, VVec } from "../value.ts";
import { bi, binIR } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";

/** ループ展開の閾値(implementation.md 3.2-2)。超えたら WGSL の for ループにする */
const UNROLL_LIMIT = 64;
/**
 * blendAll 専用のループ化しきい値(implementation.md 3.2-2、ADR-0017)。
 * blendAll の展開コストは項目ごとに dist+colour の両方(colour は前段までの
 * 再帰評価を伴う)を積み増すため、scatter/grid の平坦な min 合成より生成
 * WGSL が重くなりやすい。実測(range N |> map ... |> blendAll での
 * ドライバのシェーダコンパイル時間)から、scatter/grid の UNROLL_LIMIT(64)
 * より小さいしきい値を採る
 */
export const BLEND_UNROLL_LIMIT = 24;

export function foldUnion(ctx: Ctx, shapes: VShape[], span: Span): VShape {
  if (shapes.length === 0) fail("空のリストは合成できません", span);
  let acc = shapes[0];
  for (let i = 1; i < shapes.length; i++) {
    const a = acc;
    const b = shapes[i];
    acc = {
      v: "shape",
      dim: a.dim === 0 ? b.dim : a.dim,
      dist: (c, p, s) => num(call(c, "min", [a.dist(c, p, s).ir, b.dist(c, p, s).ir], "f32")),
      colour: (c, p, s) => {
        const da = a.dist(c, p, s);
        const db = b.dist(c, p, s);
        const cond = c.arena.node({ k: "bin", op: "<", a: da.ir, b: db.ir, t: "bool" });
        return vecV(4, c.arena.node({ k: "select", c: cond, a: a.colour(c, p, s).ir, b: b.colour(c, p, s).ir, t: "vec4" }));
      },
    };
  }
  return acc;
}

/** N が大きいとき: dist は min ループ、colour は argmin ループで生成 */
/**
 * 個体生成ラムダを N 回ぶんの CSG ループ(min-union)に畳み込む(implementation.md 3.2-2)。
 *
 * `trySprite=true`(scatter からのみ)のとき、まず1回 gen() を試し呼びして
 * 各要素が「point |> move |> fill/glow」の連鎖(座標に依存しない中心・半径・色を
 * 持つ)かどうかを見る。該当すれば CSG ループ自体を作らず、インスタンス化描画用の
 * SpriteBatchSpec を返す(dist は定数 +∞ にすり替え、実体はレイマーチでなく
 * 専用の sprite パスが描く。ADR-0014)。同様に `line`/`bezier` の連鎖なら
 * StripBatchSpec を返し、三角形ストリップの instanced 描画に切り替える(ADR-0016、
 * 2D 限定)。この判定は「N が大きいほど得をする」の一般化で、見た目は変えず
 * 描画コストだけ O(N) の SDF ループからインスタンス化描画に置き換える
 */
export function loopShape(ctx: Ctx, n: number, gen: (i: VNum) => VShape, span: Span, trySprite = false): VShape {
  if (trySprite) {
    const probeId = ctx.arena.freshLoopId();
    const probe = gen(num(ctx.arena.node({ k: "loopi", id: probeId, t: "f32" })));
    if (probe.sprite) {
      const id = ctx.arena.freshLoopId();
      const iNode = ctx.arena.node({ k: "loopi", id, t: "f32" });
      const real = gen(num(iNode));
      if (real.sprite) {
        const centerRadiusIR = ctx.arena.node({
          k: "vec",
          parts: [real.sprite.center.ir, real.sprite.radius.ir],
          t: "vec4",
        });
        const batch: SpriteBatchSpec = { count: n, loopId: id, centerRadiusIR, colourIR: real.sprite.colour.ir };
        return {
          v: "shape",
          dim: 3,
          // レイマーチの合成(min)からは常に負ける定数(=描かない)。実体は sprite パスが描く
          dist: (c) => num(c.arena.node({ k: "const", v: 1e9, t: "f32" })),
          colour: (c) => {
            const zero = c.arena.node({ k: "const", v: 0, t: "f32" });
            return vecV(4, c.arena.node({ k: "vec", parts: [zero, zero, zero, zero], t: "vec4" }));
          },
          spriteBatches: [batch],
        };
      }
    }
    if (probe.strip2D) {
      const id = ctx.arena.freshLoopId();
      const iNode = ctx.arena.node({ k: "loopi", id, t: "f32" });
      const real = gen(num(iNode));
      if (real.strip2D) {
        const batch: StripBatchSpec = {
          count: n,
          loopId: id,
          p0IR: real.strip2D.p0.ir,
          p1IR: real.strip2D.p1.ir,
          p2IR: real.strip2D.p2.ir,
          widthIR: real.strip2D.width.ir,
          colourIR: real.strip2D.colour.ir,
        };
        return {
          v: "shape",
          dim: 2,
          dist: (c) => num(c.arena.node({ k: "const", v: 1e9, t: "f32" })),
          colour: (c) => {
            const zero = c.arena.node({ k: "const", v: 0, t: "f32" });
            return vecV(4, c.arena.node({ k: "vec", parts: [zero, zero, zero, zero], t: "vec4" }));
          },
          stripBatches: [batch],
        };
      }
    }
    // ここまで来た = instanced 描画(ADR-0014/0016)に昇格せず、以下の O(n) SDF
    // ループにフォールバックする。見た目は変わらないが、n が大きいシーンでは
    // フレームレートに直結する「見えない性能崖」なので警告で可視化する
    // (この崖を実際に踏んで気づいた: liftDist/liftField 周りの副チャンネル
    // 伝播の脆さを調べていた際、scatter で少し違う書き方をするだけで
    // O(1) の instanced 描画から無警告で O(n) ループに転落することが分かった)
    ctx.diags.push({
      severity: "warning",
      message:
        `scatter ${n}個が instanced 描画に昇格せず、O(n) の SDF ループになりました。` +
        `対象になるのは \`point r |> move v |> fill/glow\`(パーティクル、ADR-0014)か ` +
        `\`line/bezier |> outline w |> fill c\`(ストリップ、ADR-0016)という連鎖だけで、` +
        `move/fill/glow/outline 以外の合成子(warp/rot/scale/distort/<+> 等)を挟むと ` +
        `安全のため自動的にこの遅い経路へフォールバックします。n が大きいと ` +
        `フレームレートに直結するので、対象の連鎖に書き換えられないか確認してください`,
      span,
    });
  }
  return {
    v: "shape",
    dim: 0,
    dist: (c, p, s) => {
      const id = c.arena.freshLoopId();
      const iNode = c.arena.node({ k: "loopi", id, t: "f32" });
      const acc = c.arena.node({ k: "loopacc", id, t: "f32" });
      const sh = gen(num(iNode));
      const d = sh.dist(c, p, s);
      const body = call(c, "min", [acc, d.ir], "f32");
      const init = c.arena.node({ k: "const", v: 1e9, t: "f32" });
      return num(c.arena.node({ k: "loop", id, count: n, init, body, t: "f32" }));
    },
    colour: (c, p, s) => {
      // acc = vec2(bestDist, bestIndex)
      const id = c.arena.freshLoopId();
      const iNode = c.arena.node({ k: "loopi", id, t: "f32" });
      const acc = c.arena.node({ k: "loopacc", id, t: "vec2" });
      const sh = gen(num(iNode));
      const d = sh.dist(c, p, s);
      const accD = c.arena.node({ k: "swiz", a: acc, sel: "x", t: "f32" });
      const better = c.arena.node({ k: "bin", op: "<", a: d.ir, b: accD, t: "bool" });
      const cand = c.arena.node({ k: "vec", parts: [d.ir, iNode], t: "vec2" });
      const body = c.arena.node({ k: "select", c: better, a: cand, b: acc, t: "vec2" });
      const init = c.arena.node({
        k: "vec",
        parts: [c.arena.node({ k: "const", v: 1e9, t: "f32" }), c.arena.node({ k: "const", v: 0, t: "f32" })],
        t: "vec2",
      });
      const loop = c.arena.node({ k: "loop", id, count: n, init, body, t: "vec2" });
      const bestI = c.arena.node({ k: "swiz", a: loop, sel: "y", t: "f32" });
      const best = gen(num(bestI));
      return best.colour(c, p, s);
    },
  };
}

/**
 * `blendAll` の大 N 向けループ版(ADR-0017)。`range n |> map f` の `proto`
 * (loopi(loopId) を内部に持つ、まだ座標を与えていない Shape)を受け取り、
 * JS 側で N 回展開する代わりに WGSL の for ループ1個で smooth-union を畳み込む。
 *
 * アキュムレータは vec4(dist, colour.rgb) に詰める(colour.a は常に1と仮定—
 * 3D 図形の色は基本不透明なので実用上問題ない)。smin(+∞, x, k) = x が成り立つ
 * ため、初期値 +∞ から fold すれば展開版(items[0] から始めて残りを fold)と
 * 数学的に同じ結果になる(sminH(+∞, x, k) = 0 なので、1周目で必ず items[0] の
 * 色に上書きされることも同様に保証される)
 */
export function blendAllLoop(
  ctx: Ctx,
  k: VNum,
  sym: { loopId: number; count: number; proto: Value },
  span: Span,
): VShape {
  const proto = toShape(ctx, sym.proto, span);
  const buildLoop = (c: Ctx, p: VVec, s: Span): NodeId => {
    const protoDist = proto.dist(c, p, s).ir;
    const protoColour = proto.colour(c, p, s).ir;
    const accIn = c.arena.node({ k: "loopacc", id: sym.loopId, t: "vec4" });
    const distSoFar = c.arena.node({ k: "swiz", a: accIn, sel: "x", t: "f32" });
    const newDist = call(c, "smin", [distSoFar, protoDist, k.ir], "f32");
    const h = call(c, "sminH", [distSoFar, protoDist, k.ir], "f32");
    const accColourRGB = c.arena.node({ k: "swiz", a: accIn, sel: "yzw", t: "vec3" });
    const protoColourRGB = c.arena.node({ k: "swiz", a: protoColour, sel: "xyz", t: "vec3" });
    const newColourRGB = call(c, "mix", [protoColourRGB, accColourRGB, h], "vec3");
    const body = c.arena.node({ k: "vec", parts: [newDist, newColourRGB], t: "vec4" });
    const zero = c.arena.node({ k: "const", v: 0, t: "f32" });
    const initVec = c.arena.node({
      k: "vec",
      parts: [c.arena.node({ k: "const", v: 1e9, t: "f32" }), zero, zero, zero],
      t: "vec4",
    });
    return c.arena.node({ k: "loop", id: sym.loopId, count: sym.count, init: initVec, body, t: "vec4" });
  };
  return {
    v: "shape",
    dim: proto.dim,
    dist: (c, p, s) => num(c.arena.node({ k: "swiz", a: buildLoop(c, p, s), sel: "x", t: "f32" })),
    colour: (c, p, s) => {
      const loop = buildLoop(c, p, s);
      const rgb = c.arena.node({ k: "swiz", a: loop, sel: "yzw", t: "vec3" });
      const one = c.arena.node({ k: "const", v: 1, t: "f32" });
      return vecV(4, c.arena.node({ k: "vec", parts: [rgb, one], t: "vec4" }));
    },
  };
}

/** 数学 builtin を値に直接適用(内部用) */
export function mathApply(ctx: Ctx, fn: string, args: Value[], span: Span): Value {
  const irs = args.map((a) => asNum(a, span).ir);
  return num(call(ctx, fn, irs, "f32"));
}

function gridBuiltin(): VBuiltin {
  return bi("grid", 2, (ctx, [dims, f], span) => {
    const dl = dims.v === "list" ? dims.items : null;
    if (!dl || dl.length !== 2) fail("grid の第1引数は [nx, ny] です", span);
    const nx = Math.round(staticNum(dl[0], "グリッドの要素数", span));
    const ny = Math.round(staticNum(dl[1], "グリッドの要素数", span));
    if (nx <= 0 || ny <= 0) fail("グリッドの要素数は正の整数です", span);
    const cellW = 2 / nx;
    const cellH = 2 / ny;
    const cell = Math.min(cellW, cellH) / 2; // ローカル座標のスケール
    const makeCell = (ix: number, iy: number, i: VNum): VShape => {
      const sh = toShape(ctx, ctx.apply(ctx, f, i, span), span);
      const cxv = -1 + cellW * (ix + 0.5);
      const cyv = -1 + cellH * (iy + 0.5);
      const centre = constVec(ctx, [cxv, cyv]);
      const scale = constF(ctx, cell);
      const inv = constF(ctx, 1 / cell);
      return {
        v: "shape",
        dim: 2,
        dist: (c, p, s) => {
          const q = binIR(c, "*", binIR(c, "-", p.ir, centre.ir, "vec2"), inv.ir, "vec2");
          const d = sh.dist(c, vecV(2, q), s);
          return num(binIR(c, "*", d.ir, scale.ir, "f32"));
        },
        colour: (c, p, s) => {
          const q = binIR(c, "*", binIR(c, "-", p.ir, centre.ir, "vec2"), inv.ir, "vec2");
          return sh.colour(c, vecV(2, q), s);
        },
      };
    };
    const total = nx * ny;
    if (total <= UNROLL_LIMIT) {
      const cells: VShape[] = [];
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          cells.push(makeCell(ix, iy, constF(ctx, iy * nx + ix)));
        }
      }
      return foldUnion(ctx, cells, span);
    }
    // 大きなグリッドは軸整列した固定タイルなので、min ループで全セルを比較する
    // 必要がない。クエリ点 p から直接「属するセル」の添字を計算し(iq の
    // ドメイン反復と同じ考え方)、そのセルだけを評価する。O(n) → O(1)
    // (前提: 各セルの図形は自セルの外にはみ出さない。はみ出す図形を並べたい
    // 場合は scatter を使う)
    const scale = constF(ctx, cell);
    const inv = constF(ctx, 1 / cell);
    const cellAt = (c: Ctx, p: VVec, s: Span): { sh: VShape; cv: NodeId } => {
      const px = num(c.arena.node({ k: "swiz", a: p.ir, sel: "x", t: "f32" }));
      const py = num(c.arena.node({ k: "swiz", a: p.ir, sel: "y", t: "f32" }));
      const ixRaw = mathApply(c, "floor", [binValue(c, "/", binValue(c, "+", px, constF(c, 1), s), constF(c, cellW), s)], s);
      const iyRaw = mathApply(c, "floor", [binValue(c, "/", binValue(c, "+", py, constF(c, 1), s), constF(c, cellH), s)], s);
      const ix = mathApply(c, "clamp", [ixRaw, constF(c, 0), constF(c, nx - 1)], s);
      const iy = mathApply(c, "clamp", [iyRaw, constF(c, 0), constF(c, ny - 1)], s);
      const i = binValue(c, "+", binValue(c, "*", iy, constF(c, nx), s), ix, s);
      const cx = binValue(c, "-", binValue(c, "*", constF(c, cellW), binValue(c, "+", ix, constF(c, 0.5), s), s), constF(c, 1), s);
      const cy = binValue(c, "-", binValue(c, "*", constF(c, cellH), binValue(c, "+", iy, constF(c, 0.5), s), s), constF(c, 1), s);
      const sh = toShape(c, c.apply(c, f, i, s), s);
      const cv = c.arena.node({ k: "vec", parts: [asNum(cx, s).ir, asNum(cy, s).ir], t: "vec2" });
      return { sh, cv };
    };
    return {
      v: "shape",
      dim: 2,
      dist: (c, p, s) => {
        const { sh, cv } = cellAt(c, p, s);
        const q = binIR(c, "*", binIR(c, "-", p.ir, cv, "vec2"), inv.ir, "vec2");
        return num(binIR(c, "*", sh.dist(c, vecV(2, q), s).ir, scale.ir, "f32"));
      },
      colour: (c, p, s) => {
        const { sh, cv } = cellAt(c, p, s);
        const q = binIR(c, "*", binIR(c, "-", p.ir, cv, "vec2"), inv.ir, "vec2");
        return sh.colour(c, vecV(2, q), s);
      },
    } as VShape;
  });
}

function scatterBuiltin(): VBuiltin {
  return bi("scatter", 2, (ctx, [nV, f], span) => {
    const n = Math.round(staticNum(nV, "scatter の要素数", span));
    if (n <= 0) fail("scatter の要素数は正の整数です", span);
    const gen = (i: VNum): VShape => toShape(ctx, ctx.apply(ctx, f, i, span), span);
    if (n <= UNROLL_LIMIT) {
      const shapes: VShape[] = [];
      for (let i = 0; i < n; i++) shapes.push(gen(constF(ctx, i)));
      return foldUnion(ctx, shapes, span);
    }
    return loopShape(ctx, n, gen, span, true);
  });
}

export function installIteration(add: AddFn, addV: AddVFn): void {
  // ---- 反復 ----
  addV(
    "range",
    bi("range", 1, (ctx, [nV], span) => {
      const n = Math.round(staticNum(nV, "range の要素数", span));
      const items: Value[] = [];
      for (let i = 0; i < n; i++) items.push(constF(ctx, i));
      return { v: "list", items, rangeOf: n };
    }),
  );
  addV(
    "map",
    bi("map", 2, (ctx, [f, xs], span) => {
      if (xs.v !== "list") fail(`map にはリストが必要ですが、${describe(xs)} が渡されました`, span);
      const items = xs.items.map((x) => ctx.apply(ctx, f, x, span));
      const result: Value = { v: "list", items };
      // `range n |> map f` で n が(消費側 blendAll のしきい値超えを見込むほど)
      // 大きいとき、展開せずに使える「シンボリック」な版もついでに作っておく
      // (小さい N では余分な評価をしないよう、ここでも同じしきい値で絞る。ADR-0017)
      if (xs.rangeOf !== undefined && xs.rangeOf > BLEND_UNROLL_LIMIT && (f.v === "clo" || f.v === "bi")) {
        const loopId = ctx.arena.freshLoopId();
        const loopiNode = ctx.arena.node({ k: "loopi", id: loopId, t: "f32" });
        const proto = ctx.apply(ctx, f, num(loopiNode), span);
        (result as VList).symbolicLoop = { loopId, count: xs.rangeOf, proto };
      }
      return result;
    }),
  );
  addV("grid", gridBuiltin());
  addV("scatter", scatterBuiltin());
}
