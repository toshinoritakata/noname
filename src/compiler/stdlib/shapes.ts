// 2D/3D 形状 + warp 族 + 形状合成(元 stdlib.ts 860-1186行)。

import { asNum, asVec, call, constF, constVec, fail, mixValue, num, toField, toShape, vecV } from "../ops.ts";
import { vecType } from "../ir.ts";
import type { Dim, VShape } from "../value.ts";
import { bi, binIR, defaultColour, rec, shape, warpValue } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";
import { BLEND_UNROLL_LIMIT, blendAllLoop } from "./iteration.ts";

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
      const fn = a.n === 3 ? "sdSegment3" : "sdSegment2";
      // 距離ゼロの曲線(パス上でちょうど0)。太さは |> outline w で与える
      const sh = shape(dim, (c, p) => num(call(c, fn, [p.ir, a.ir, b.ir], "f32")));
      if (a.n === 2) {
        // ストリップ描画マーカー(ADR-0016)。line は制御点=中点の退化ベジエとして扱う
        const mid = vecV(2, binIR(ctx, "*", binIR(ctx, "+", a.ir, b.ir, "vec2"), constF(ctx, 0.5).ir, "vec2"));
        sh.strip2D = { p0: a, p1: mid, p2: b, width: constF(ctx, 0), colour: defaultColour(ctx) };
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
      const fn = a.n === 3 ? "sdBezier3" : "sdBezier2";
      // line と同じく距離ゼロの曲線。太さは |> outline w で与える
      const sh = shape(dim, (c, p) => num(call(c, fn, [p.ir, a.ir, b.ir, cc.ir], "f32")));
      if (a.n === 2) {
        sh.strip2D = { p0: a, p1: b, p2: cc, width: constF(ctx, 0), colour: defaultColour(ctx) };
      }
      return sh;
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
      return {
        v: "shape",
        dim: sh.dim,
        dist: (c, p, s) => {
          const d = sh.dist(c, p, s);
          const o = asNum(df.fn(c, p, s), s);
          return num(binIR(c, "+", d.ir, o.ir, "f32"));
        },
        colour: sh.colour,
      } as VShape;
    }),
  );

  // ---- 形状合成 ----
  addV(
    "cut",
    bi("cut", 2, (ctx, [tool, base], span) => {
      const a = toShape(ctx, base, span);
      const b = toShape(ctx, tool, span);
      return {
        v: "shape",
        dim: a.dim === 0 ? b.dim : a.dim,
        dist: (c, p, s) => {
          const nb = c.arena.node({ k: "un", op: "neg", a: b.dist(c, p, s).ir, t: "f32" });
          return num(call(c, "max", [a.dist(c, p, s).ir, nb], "f32"));
        },
        colour: a.colour,
      } as VShape;
    }),
  );
  addV(
    "inter",
    bi("inter", 2, (ctx, [x, y], span) => {
      const a = toShape(ctx, x, span);
      const b = toShape(ctx, y, span);
      return {
        v: "shape",
        dim: a.dim === 0 ? b.dim : a.dim,
        dist: (c, p, s) => num(call(c, "max", [a.dist(c, p, s).ir, b.dist(c, p, s).ir], "f32")),
        colour: a.colour,
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
      const result: VShape = {
        v: "shape",
        dim: sh.dim,
        dist: (c, p, s) => {
          const d = call(c, "abs", [sh.dist(c, p, s).ir], "f32");
          return num(binIR(c, "-", d, wn.ir, "f32"));
        },
        colour: sh.colour,
      };
      // line/bezier のストリップ描画マーカー(ADR-0016): 幅を設定して引き継ぐ
      if (sh.strip2D) result.strip2D = { ...sh.strip2D, width: wn };
      return result;
    }),
  );
}
