// 彩色・光(元 stdlib.ts 1187-1342行)+ 色定数(元781行)。

import type { Span } from "../diag.ts";
import type { NodeId } from "../ir.ts";
import { asColor, asNum, asVec, call, constVec, describe, fail, toField, toShape, vecV } from "../ops.ts";
import type { Ctx, VField, VShape, VVec } from "../value.ts";
import { bi, binIR, lifted } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";

export function installColor(add: AddFn, addV: AddVFn): void {
  // ---- 色 ----
  const colors: Record<string, number[]> = {
    white: [1, 1, 1, 1],
    black: [0, 0, 0, 1],
    red: [0.95, 0.2, 0.16, 1],
    green: [0.2, 0.85, 0.35, 1],
    blue: [0.2, 0.4, 0.95, 1],
    coral: [1, 0.5, 0.4, 1],
    midnight: [0.05, 0.05, 0.14, 1],
    teal: [0.1, 0.55, 0.55, 1],
    ivory: [1, 1, 0.94, 1],
    indigo: [0.29, 0.11, 0.51, 1],
    skyblue: [0.53, 0.8, 0.92, 1],
    orange: [1, 0.6, 0.15, 1],
    magenta: [0.9, 0.2, 0.7, 1],
    gray: [0.5, 0.5, 0.5, 1],
  };
  for (const [name, rgba] of Object.entries(colors)) {
    add(name, (ctx) => constVec(ctx, rgba));
  }

  // ---- 彩色・光 ----
  addV(
    "fill",
    bi("fill", 2, (ctx, [colV, x], span) => {
      const sh = toShape(ctx, x, span);
      if (colV.v === "field") {
        const cf = colV;
        // 場は座標依存なのでスプライト/ストリップ伝播できない(安全にフォールバック)
        return {
          ...sh,
          colour: (c, p, s) => asColor(c, cf.fn(c, p, s), s),
          sprite: undefined,
          strip2D: undefined,
          strip3D: undefined,
        } as VShape;
      }
      const col = asColor(ctx, colV, span);
      const result = { ...sh, colour: () => col } as VShape;
      if (sh.sprite) result.sprite = { ...sh.sprite, colour: col };
      if (sh.strip2D) result.strip2D = { ...sh.strip2D, colour: col };
      if (sh.strip3D) result.strip3D = { ...sh.strip3D, colour: col };
      return result;
    }),
  );
  addV(
    "hsv",
    lifted("hsv", 3, (ctx, args, span) => {
      const [h, s, v] = args.map((a) => asNum(a, span).ir);
      const hv = ctx.arena.node({ k: "vec", parts: [h, s, v], t: "vec3" });
      const rgb = call(ctx, "hsv2rgb", [hv], "vec3");
      const one = ctx.arena.node({ k: "const", v: 1, t: "f32" });
      return vecV(4, ctx.arena.node({ k: "vec", parts: [rgb, one], t: "vec4" }));
    }),
  );
  addV(
    "ramp",
    bi("ramp", 2, (ctx, [colsV, x], span) => {
      const cols = colsV.v === "list" ? colsV.items.map((c) => asColor(ctx, c, span)) : null;
      if (!cols || cols.length === 0) fail("ramp には色のリストが必要です", span);
      const f = toField(ctx, x, span);
      return {
        v: "field",
        dim: f.dim,
        fn: (c, p, s) => {
          const tv = asNum(f.fn(c, p, s), s);
          const m = cols.length;
          if (m === 1) return cols[0];
          const seg = binIR(
            c,
            "*",
            call(c, "clamp", [tv.ir, c.arena.node({ k: "const", v: 0, t: "f32" }), c.arena.node({ k: "const", v: 1, t: "f32" })], "f32"),
            c.arena.node({ k: "const", v: m - 1, t: "f32" }),
            "f32",
          );
          let acc = cols[0].ir;
          for (let i = 1; i < m; i++) {
            const tt = call(
              c,
              "clamp",
              [
                binIR(c, "-", seg, c.arena.node({ k: "const", v: i - 1, t: "f32" }), "f32"),
                c.arena.node({ k: "const", v: 0, t: "f32" }),
                c.arena.node({ k: "const", v: 1, t: "f32" }),
              ],
              "f32",
            );
            acc = call(c, "mix", [acc, cols[i].ir, tt], "vec4");
          }
          return vecV(4, acc);
        },
      } as VField;
    }),
  );
  addV(
    "glow",
    bi("glow", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      const sh = toShape(ctx, x, span);
      const boostOf = (c: Ctx, kIr: NodeId): NodeId =>
        binIR(c, "+", c.arena.node({ k: "const", v: 1, t: "f32" }), binIR(c, "*", kIr, c.arena.node({ k: "const", v: 2.5, t: "f32" }), "f32"), "f32");
      const result = {
        ...sh,
        colour: (c: Ctx, p: VVec, s: Span) => {
          const base = sh.colour(c, p, s);
          const rgb = c.arena.node({ k: "swiz", a: base.ir, sel: "xyz", t: "vec3" });
          const boost = boostOf(c, kn.ir);
          const brightened = binIR(c, "*", rgb, boost, "vec3");
          const a = c.arena.node({ k: "swiz", a: base.ir, sel: "w", t: "f32" });
          return vecV(4, c.arena.node({ k: "vec", parts: [brightened, a], t: "vec4" }));
        },
        strip2D: undefined, // 2Dストリップ描画は未対応(安全に SDF フォールバック)
        strip3D: undefined,
      } as VShape;
      // glow の明るさ変換は座標に依存しないので、スプライト/3Dストリップの色にも
      // 同じ式を適用して伝播する(sprite と同じ instanced・深度テストなしの描画のため)
      if (sh.sprite) {
        const boost = boostOf(ctx, kn.ir);
        const rgb = binIR(ctx, "*", ctx.arena.node({ k: "swiz", a: sh.sprite.colour.ir, sel: "xyz", t: "vec3" }), boost, "vec3");
        const a = ctx.arena.node({ k: "swiz", a: sh.sprite.colour.ir, sel: "w", t: "f32" });
        result.sprite = { ...sh.sprite, colour: vecV(4, ctx.arena.node({ k: "vec", parts: [rgb, a], t: "vec4" })) };
      }
      if (sh.strip3D) {
        const boost = boostOf(ctx, kn.ir);
        const rgb = binIR(ctx, "*", ctx.arena.node({ k: "swiz", a: sh.strip3D.colour.ir, sel: "xyz", t: "vec3" }), boost, "vec3");
        const a = ctx.arena.node({ k: "swiz", a: sh.strip3D.colour.ir, sel: "w", t: "f32" });
        result.strip3D = { ...sh.strip3D, colour: vecV(4, ctx.arena.node({ k: "vec", parts: [rgb, a], t: "vec4" })) };
      }
      return result;
    }),
  );
  addV(
    "bg",
    bi("bg", 1, (ctx, [colV], span) => {
      const col = asColor(ctx, colV, span);
      return { v: "field", dim: 2, fn: () => col } as VField;
    }),
  );
  addV(
    "sun",
    bi("sun", 1, (ctx, [v], span) => {
      const d = asVec(ctx, v, span, 3);
      return { v: "light", kind: "sun", dir: vecV(3, call(ctx, "normalize", [d.ir], "vec3")) };
    }),
  );
  add("sunlight", (ctx) => ({
    v: "light",
    kind: "sun",
    dir: vecV(3, call(ctx, "normalize", [constVec(ctx, [0.6, 1.0, 0.4]).ir], "vec3")),
  }));
  addV(
    "shade",
    bi("shade", 2, (ctx, [lightV, x], span) => {
      if (lightV.v !== "light") fail(`shade にはライト(sun [x,y,z])が必要ですが、${describe(lightV)} が渡されました`, span);
      const l = lightV.dir;
      const sh = toShape(ctx, x, span);
      if (sh.dim === 2) fail("shade は3D図形用です(2Dには fill を使います)", span);
      return {
        ...sh,
        dim: 3,
        colour: (c, p, s) => {
          const base = sh.colour(c, p, s);
          const n = c.arena.node({ k: "rmctx", which: "normal", t: "vec3" });
          const rd = c.arena.node({ k: "rmctx", which: "raydir", t: "vec3" });
          return vecV(4, call(c, "shadeLambert", [base.ir, n, rd, l.ir], "vec4"));
        },
      } as VShape;
    }),
  );
  addV(
    "fog",
    bi("fog", 3, (ctx, [k, colV, x], span) => {
      const kn = asNum(k, span);
      const col = asColor(ctx, colV, span);
      const sh = toShape(ctx, x, span);
      return {
        ...sh,
        colour: (c, p, s) => {
          const base = sh.colour(c, p, s);
          const dist = c.arena.node({ k: "rmctx", which: "raydist", t: "f32" });
          const f = call(c, "fogMix", [base.ir, col.ir, kn.ir, dist], "vec4");
          return vecV(4, f);
        },
      } as VShape;
    }),
  );
}
