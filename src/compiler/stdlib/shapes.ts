// 2D/3D 形状 + warp 族 + 形状合成(元 stdlib.ts 860-1186行)。

import { asNum, asVec, call, constF, constVec, fail, liftDist, mixValue, num, outlineShape, toField, toShape, vecV } from "../ops.ts";
import { fnv1a, vecType } from "../ir.ts";
import type { Dim, VShape } from "../value.ts";
import { bi, binIR, defaultColour, rec, shape, warpValue } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";
import { BLEND_UNROLL_LIMIT, blendAllLoop } from "./iteration.ts";

/**
 * line/bezier には SDF が無い(ADR-0037で完全に廃止)。`outline`/`fill`/`glow`
 * (3Dのみ)/`scatter` 以外の合成子(move/rot/scale/warp/distort/cut/inter/
 * <+>/if/morph 等)は内部で dist を評価しようとするため、ここで明確な
 * コンパイルエラーにする。単体使用(scatterしない場合)は toImage/render が
 * strip2D/strip3D を見つけた時点で dist を一切呼ばずに描画するので、
 * この関数が実際に呼ばれるのは「対象外の合成をした時」だけになる
 */
function noStripDist(kind: "line" | "bezier"): VShape["dist"] {
  return (_c, _p, s) =>
    fail(
      `${kind} にはSDFがありません(ADR-0037)。outline/fill/glow(3Dのみ)/scatter 以外の合成` +
        `(move/rot/scale/warp/distort/cut/inter/<+>/if/morph 等)はできません`,
      s,
    );
}

function planeAxis(axis: 0 | 1 | 2) {
  const sel = ["x", "y", "z"][axis];
  return bi(`plane.${sel}`, 1, (ctx, [hV], span) => {
    const h = asNum(hV, span);
    return shape(3, (c, p) => {
      const comp = c.arena.node({ k: "swiz", a: p.ir, sel, t: "f32" });
      return num(binIR(c, "-", comp, h.ir, "f32"));
    });
  });
}

export function installShapes(add: AddFn, addV: AddVFn): void {
  // ---- 2D/3D 形状 ----
  addV(
    "circle",
    bi("circle", 1, (ctx, [r], span) => {
      const rn = asNum(r, span);
      return shape(2, (c, p) => num(binIR(c, "-", call(c, "length", [p.ir], "f32"), rn.ir, "f32")));
    }),
  );
  addV(
    "sphere",
    bi("sphere", 1, (ctx, [r], span) => {
      const rn = asNum(r, span);
      return shape(3, (c, p) => num(binIR(c, "-", call(c, "length", [p.ir], "f32"), rn.ir, "f32")));
    }),
  );
  addV(
    "point",
    bi("point", 1, (ctx, [r], span) => {
      const rn = asNum(r, span);
      const sh = shape(0, (c, p) => num(binIR(c, "-", call(c, "length", [p.ir], "f32"), rn.ir, "f32")));
      // スプライト伝播の起点(implementation.md 追加、ADR-0014)。中心は move が積む
      sh.sprite = { center: constVec(ctx, [0, 0, 0]), radius: rn, colour: defaultColour(ctx) };
      return sh;
    }),
  );
  addV(
    "box",
    bi("box", 1, (ctx, [s], span) => {
      if (s.v === "vec" || s.v === "list") {
        const sv = asVec(ctx, s, span);
        if (sv.n === 2) return shape(2, (c, p) => num(call(c, "sdBox2", [p.ir, sv.ir], "f32")));
        return shape(3, (c, p) => num(call(c, "sdBox3", [p.ir, sv.ir], "f32")));
      }
      const sn = asNum(s, span);
      return shape(0, (c, p) => {
        const pt = c.arena.typeOf(p.ir);
        const bv = pt === "vec3" ? c.arena.node({ k: "vec", parts: [sn.ir, sn.ir, sn.ir], t: "vec3" }) : c.arena.node({ k: "vec", parts: [sn.ir, sn.ir], t: "vec2" });
        return num(call(c, pt === "vec3" ? "sdBox3" : "sdBox2", [p.ir, bv], "f32"));
      });
    }),
  );
  addV(
    "tri",
    bi("tri", 1, (ctx, [r], span) => {
      const rn = asNum(r, span);
      return shape(2, (c, p) => num(call(c, "sdTri", [p.ir, rn.ir], "f32")));
    }),
  );
  addV(
    "line",
    bi("line", 2, (ctx, [aV, bV], span) => {
      const a = asVec(ctx, aV, span);
      const b = asVec(ctx, bV, span);
      if (a.n !== b.n) fail(`line の2点の次元が合いません: ${a.n} と ${b.n}`, span);
      const dim = (a.n === 3 ? 3 : 2) as Dim;
      const sh = shape(dim, noStripDist("line"));
      if (a.n === 2) {
        // ストリップ描画マーカー(ADR-0016)。line は制御点=中点の退化ベジエとして扱う
        const mid = vecV(2, binIR(ctx, "*", binIR(ctx, "+", a.ir, b.ir, "vec2"), constF(ctx, 0.5).ir, "vec2"));
        sh.strip2D = { p0: a, p1: mid, p2: b, width: constF(ctx, 0), colour: defaultColour(ctx) };
      } else {
        // 3Dストリップ描画マーカー(ADR-0036)。2Dと同じく中点=退化ベジエ
        const mid = vecV(3, binIR(ctx, "*", binIR(ctx, "+", a.ir, b.ir, "vec3"), constF(ctx, 0.5).ir, "vec3"));
        sh.strip3D = { p0: a, p1: mid, p2: b, width: constF(ctx, 0), colour: defaultColour(ctx) };
      }
      return sh;
    }),
  );
  addV(
    "bezier",
    bi("bezier", 3, (ctx, [aV, bV, cV], span) => {
      const a = asVec(ctx, aV, span);
      const b = asVec(ctx, bV, span);
      const cc = asVec(ctx, cV, span);
      if (a.n !== b.n || a.n !== cc.n) {
        fail(`bezier の3点の次元が合いません: ${a.n} / ${b.n} / ${cc.n}`, span);
      }
      const dim = (a.n === 3 ? 3 : 2) as Dim;
      const sh = shape(dim, noStripDist("bezier"));
      if (a.n === 2) {
        sh.strip2D = { p0: a, p1: b, p2: cc, width: constF(ctx, 0), colour: defaultColour(ctx) };
      } else {
        sh.strip3D = { p0: a, p1: b, p2: cc, width: constF(ctx, 0), colour: defaultColour(ctx) };
      }
      return sh;
    }),
  );
  addV(
    "text",
    bi("text", 2, (ctx, [hV, strV], span) => {
      const hn = asNum(hV, span);
      if (strV.v !== "str") fail(`text の2引数目は文字列(\"...\")が必要です`, span);
      const str = strV.text;
      // ラスタライズ(Canvas2D→GPUテクスチャ)はメインスレッド側で行う(ADR-0032)。
      // コンパイラ(Worker)はここで文字列とキーだけを登録する
      const key = "text:" + fnv1a(str);
      if (!ctx.textTextures.some((t) => t.key === key)) ctx.textTextures.push({ key, text: str });
      // 実測アスペクト比(文字列の長さで幅が変わる)はランタイムが毎フレーム供給する
      // 入力にする(px と同じ扱い)。コンパイラ側は DOM/Canvas2D に一切触れない
      return shape(2, (c, p) => {
        const aspect = c.arena.node({ k: "input", name: `${key}:aspect`, t: "f32" });
        const halfH = hn.ir;
        const halfW = binIR(c, "*", halfH, aspect, "f32");
        const halfExtent = c.arena.node({ k: "vec", parts: [halfW, halfH], t: "vec2" });
        const boxDist = call(c, "sdBox2", [p.ir, halfExtent], "f32");
        // ローカル座標 p([-halfW,halfW]x[-halfH,halfH]) を uv([0,1]x[0,1]、
        // canvas は上が原点なので v は反転)に写像してラスタライズ結果をサンプルする
        const px = c.arena.node({ k: "swiz", a: p.ir, sel: "x", t: "f32" });
        const py = c.arena.node({ k: "swiz", a: p.ir, sel: "y", t: "f32" });
        const u = binIR(c, "/", binIR(c, "+", px, halfW, "f32"), binIR(c, "*", halfW, constF(c, 2).ir, "f32"), "f32");
        const v = binIR(
          c,
          "-",
          constF(c, 1).ir,
          binIR(c, "/", binIR(c, "+", py, halfH, "f32"), binIR(c, "*", halfH, constF(c, 2).ir, "f32"), "f32"),
          "f32",
        );
        const uv = c.arena.node({ k: "vec", parts: [u, v], t: "vec2" });
        const texel = c.arena.node({ k: "sample", tex: key, p: uv, t: "vec4" });
        const alpha = c.arena.node({ k: "swiz", a: texel, sel: "w", t: "f32" });
        // 真のSDFではない近似(ラスタライズ済みアルファからの疑似distance、Lipschitz規律の対象外)。
        // 外接矩形の外は sdBox2 が、内側は「文字の塗り具合」が支配するよう max で交差させる
        const textDist = binIR(c, "-", constF(c, 0.5).ir, alpha, "f32");
        return num(call(c, "max", [boxDist, textDist], "f32"));
      });
    }),
  );
  add("plane", (ctx) =>
    rec([
      ["x", planeAxis(0)],
      ["y", planeAxis(1)],
      ["z", planeAxis(2)],
    ]),
  );
  addV(
    "heightfield",
    bi("heightfield", 1, (ctx, [f], span) => {
      return shape(3, (c, p, s) => {
        const xz = c.arena.node({ k: "swiz", a: p.ir, sel: "xz", t: "vec2" });
        const h = asNum(c.apply(c, f, vecV(2, xz), s), s);
        const y = c.arena.node({ k: "swiz", a: p.ir, sel: "y", t: "f32" });
        const d = binIR(c, "-", y, h.ir, "f32");
        // Lipschitz 対策の安全係数(ADR-0002)
        return num(binIR(c, "*", d, c.arena.node({ k: "const", v: 0.6, t: "f32" }), "f32"));
      });
    }),
  );

  // ---- warp 族 ----
  addV(
    "warp",
    bi("warp", 2, (ctx, [f, x], span) =>
      warpValue(
        ctx,
        (c, p, s) => asVec(c, c.apply(c, f, p, s), s),
        x,
        span,
      ),
    ),
  );
  addV(
    "move",
    bi("move", 2, (ctx, [v, x], span) => {
      const off = asVec(ctx, v, span);
      const result = warpValue(
        ctx,
        (c, p, s) => {
          if (off.n !== (c.arena.typeOf(p.ir) === "vec3" ? 3 : 2)) {
            fail(`move のベクトル(${off.n}次元)と図形の次元が合いません`, s);
          }
          return vecV(off.n, binIR(c, "-", p.ir, off.ir, vecType(off.n)));
        },
        x,
        span,
      );
      // スプライト伝播: point |> move の連鎖だけ中心座標を積んで引き継ぐ(ADR-0014)
      if (result.v === "shape" && x.v === "shape" && x.sprite && off.n === 3) {
        result.sprite = {
          ...x.sprite,
          center: vecV(3, binIR(ctx, "+", x.sprite.center.ir, off.ir, "vec3")),
        };
      }
      return result;
    }),
  );
  addV(
    "rot",
    bi("rot", 2, (ctx, [a, x], span) => {
      const an = asNum(a, span);
      return warpValue(ctx, (c, p) => vecV(2, call(c, "rot2", [p.ir, an.ir], "vec2")), x, span);
    }),
  );
  for (const [name, fn] of [
    ["rotX", "rotX"],
    ["rotY", "rotY"],
    ["rotZ", "rotZ"],
  ] as const) {
    addV(
      name,
      bi(name, 2, (ctx, [a, x], span) => {
        const an = asNum(a, span);
        return warpValue(ctx, (c, p) => vecV(3, call(c, fn, [p.ir, an.ir], "vec3")), x, span);
      }),
    );
  }
  addV(
    "scale",
    bi("scale", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      return warpValue(
        ctx,
        (c, p) => {
          const pt = c.arena.typeOf(p.ir);
          return vecV(pt === "vec3" ? 3 : 2, binIR(c, "/", p.ir, kn.ir, pt));
        },
        x,
        span,
        kn.ir, // dist スケール補正
      );
    }),
  );
  addV(
    "repeat",
    bi("repeat", 2, (ctx, [v, x], span) => {
      const cellv = asVec(ctx, v, span);
      return warpValue(
        ctx,
        (c, p) => {
          const half = binIR(c, "*", cellv.ir, c.arena.node({ k: "const", v: 0.5, t: "f32" }), vecType(cellv.n));
          const shifted = binIR(c, "+", p.ir, half, vecType(cellv.n));
          const m = call(c, cellv.n === 3 ? "fmodv3" : "fmodv2", [shifted, cellv.ir], vecType(cellv.n) as "vec2" | "vec3");
          return vecV(cellv.n, binIR(c, "-", m, half, vecType(cellv.n)));
        },
        x,
        span,
      );
    }),
  );
  addV(
    "mirror",
    bi("mirror", 1, (ctx, [x], span) =>
      warpValue(
        ctx,
        (c, p) => {
          const pt = c.arena.typeOf(p.ir);
          return vecV(pt === "vec3" ? 3 : 2, call(c, "abs", [p.ir], pt as "vec2" | "vec3"));
        },
        x,
        span,
      ),
    ),
  );
  addV(
    "twist",
    bi("twist", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      return warpValue(ctx, (c, p) => vecV(3, call(c, "twistY", [p.ir, kn.ir], "vec3")), x, span);
    }),
  );
  addV(
    "distort",
    bi("distort", 2, (ctx, [f, x], span) => {
      const sh = toShape(ctx, x, span);
      const df = toField(ctx, f, span);
      return liftDist(
        sh,
        (c, p, s) => {
          const d = sh.dist(c, p, s);
          const o = asNum(df.fn(c, p, s), s);
          return num(binIR(c, "+", d.ir, o.ir, "f32"));
        },
        // 任意の場で dist をずらすので、sprite/strip2D/strip3D の「座標非依存」前提を保証できない
        { sprite: undefined, strip2D: undefined, strip3D: undefined },
      );
    }),
  );

  // ---- 形状合成 ----
  addV(
    "cut",
    bi("cut", 2, (ctx, [tool, base], span) => {
      const a = toShape(ctx, base, span);
      const b = toShape(ctx, tool, span);
      // spriteBatches/stripBatches/strip3Batches(集約後)は shapeUnion と同じ理由で
      // 無条件で継承する(max による CSG は「実体のある側」の dist=+∞ をそのまま
      // 素通しするので安全)。sprite/strip2D/strip3D は2項combinatorで意味が壊れる
      // ため明示的に落とす
      const spriteBatches = [...(a.spriteBatches ?? []), ...(b.spriteBatches ?? [])];
      const stripBatches = [...(a.stripBatches ?? []), ...(b.stripBatches ?? [])];
      const strip3Batches = [...(a.strip3Batches ?? []), ...(b.strip3Batches ?? [])];
      return {
        v: "shape",
        dim: a.dim === 0 ? b.dim : a.dim,
        dist: (c, p, s) => {
          const nb = c.arena.node({ k: "un", op: "neg", a: b.dist(c, p, s).ir, t: "f32" });
          return num(call(c, "max", [a.dist(c, p, s).ir, nb], "f32"));
        },
        colour: a.colour,
        sprite: undefined,
        strip2D: undefined,
        strip3D: undefined,
        spriteBatches: spriteBatches.length > 0 ? spriteBatches : undefined,
        stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
        strip3Batches: strip3Batches.length > 0 ? strip3Batches : undefined,
      } as VShape;
    }),
  );
  addV(
    "inter",
    bi("inter", 2, (ctx, [x, y], span) => {
      const a = toShape(ctx, x, span);
      const b = toShape(ctx, y, span);
      const spriteBatches = [...(a.spriteBatches ?? []), ...(b.spriteBatches ?? [])];
      const stripBatches = [...(a.stripBatches ?? []), ...(b.stripBatches ?? [])];
      const strip3Batches = [...(a.strip3Batches ?? []), ...(b.strip3Batches ?? [])];
      return {
        v: "shape",
        dim: a.dim === 0 ? b.dim : a.dim,
        dist: (c, p, s) => num(call(c, "max", [a.dist(c, p, s).ir, b.dist(c, p, s).ir], "f32")),
        colour: a.colour,
        sprite: undefined,
        strip2D: undefined,
        strip3D: undefined,
        spriteBatches: spriteBatches.length > 0 ? spriteBatches : undefined,
        stripBatches: stripBatches.length > 0 ? stripBatches : undefined,
        strip3Batches: strip3Batches.length > 0 ? strip3Batches : undefined,
      } as VShape;
    }),
  );
  addV(
    "morph",
    bi("morph", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      if (x.v === "pat") {
        return { ...x, morph: kn.ir };
      }
      // morph k a b: 2図形の補間
      return bi("morph'", 1, (c, [y], s) => mixValue(c, x, y, kn, s));
    }),
  );
  addV(
    "blendAll",
    bi("blendAll", 2, (ctx, [k, xs], span) => {
      const kn = asNum(k, span);
      // `range n |> map f` (n > 64) の後なら、JS 側で N 個展開する代わりに
      // WGSL の for ループ1個に畳み込む(ADR-0017。scatter/grid の大 N ループ
      // 化(ADR-0014)と同じ思想。展開版と数学的に同じ結果になることは
      // smin(+∞, x, k) = x の恒等式から従う: 初期値 +∞ から fold すれば
      // 「items[0] から始めて items[1..] を fold する」展開版と一致する)
      if (xs.v === "list" && xs.symbolicLoop && xs.symbolicLoop.count > BLEND_UNROLL_LIMIT) {
        return blendAllLoop(ctx, kn, xs.symbolicLoop, span);
      }
      const items = xs.v === "list" ? xs.items.map((i) => toShape(ctx, i, span)) : null;
      if (!items || items.length === 0) fail("blendAll にはリストが必要です", span);
      let acc = items[0];
      for (let i = 1; i < items.length; i++) {
        const a = acc;
        const b = items[i];
        acc = {
          v: "shape",
          dim: a.dim === 0 ? b.dim : a.dim,
          dist: (c, p, s) => num(call(c, "smin", [a.dist(c, p, s).ir, b.dist(c, p, s).ir, kn.ir], "f32")),
          colour: (c, p, s) => {
            const h = call(c, "sminH", [a.dist(c, p, s).ir, b.dist(c, p, s).ir, kn.ir], "f32");
            return vecV(4, call(c, "mix", [b.colour(c, p, s).ir, a.colour(c, p, s).ir, h], "vec4"));
          },
        };
      }
      return acc;
    }),
  );
  addV(
    "outline",
    bi("outline", 2, (ctx, [w, x], span) => {
      const wn = asNum(w, span);
      const sh = toShape(ctx, x, span);
      return outlineShape(ctx, sh, wn, span);
    }),
  );
}
