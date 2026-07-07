// 物理(元 stdlib.ts 1548-1578行)+ 3D レンダリング(元1610-1665行)。

import type { Span } from "../diag.ts";
import type { NodeId } from "../ir.ts";
import { vecType } from "../ir.ts";
import { asNum, asVec, call, constF, constVec, describe, fail, toShape, vecV, worldToUv } from "../ops.ts";
import type { Ctx, Value, VField, VVec } from "../value.ts";
import { bi, binIR } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";

/** 点(または点の場)を受けて値(または場)を返す物理系関数のリフト */
function liftPoint(
  ctx: Ctx,
  pV: Value,
  span: Span,
  f: (c: Ctx, p: VVec, s: Span) => Value,
): Value {
  if (pV.v === "field") {
    const pf = pV;
    return { v: "field", dim: pf.dim, fn: (c, p, s) => f(c, asVec(c, pf.fn(c, p, s), s), s) } as VField;
  }
  if (pV.v === "vec" || pV.v === "list") {
    return f(ctx, asVec(ctx, pV, span), span);
  }
  fail(`座標(または座標の場)が必要ですが、${describe(pV)} が渡されました`, span);
}

export function installPhysics3D(add: AddFn, addV: AddVFn): void {
  // ---- 物理 ----
  addV(
    "dist",
    bi("dist", 2, (ctx, [shV, pV], span) => {
      const sh = toShape(ctx, shV, span);
      return liftPoint(ctx, pV, span, (c, p, s) => sh.dist(c, p, s));
    }),
  );
  addV(
    "grad",
    bi("grad", 2, (ctx, [shV, pV], span) => {
      const sh = toShape(ctx, shV, span);
      return liftPoint(ctx, pV, span, (c, p, s) => {
        const n = c.arena.typeOf(p.ir) === "vec3" ? 3 : 2;
        const eps = c.arena.node({ k: "const", v: 1e-3, t: "f32" });
        const parts: NodeId[] = [];
        for (let i = 0; i < n; i++) {
          const dir = [0, 0, 0].map((_, j) => (j === i ? 1 : 0)).slice(0, n);
          const off = constVec(c, dir.map((d) => d));
          const scaled = binIR(c, "*", off.ir, eps, vecType(n));
          const pp = vecV(n as 2 | 3, binIR(c, "+", p.ir, scaled, vecType(n)));
          const pm = vecV(n as 2 | 3, binIR(c, "-", p.ir, scaled, vecType(n)));
          const dd = binIR(c, "-", sh.dist(c, pp, s).ir, sh.dist(c, pm, s).ir, "f32");
          parts.push(binIR(c, "/", dd, binIR(c, "*", eps, c.arena.node({ k: "const", v: 2, t: "f32" }), "f32"), "f32"));
        }
        const v = c.arena.node({ k: "vec", parts, t: vecType(n) as "vec2" | "vec3" });
        return vecV(n as 2 | 3, call(c, "normalize", [v], vecType(n) as "vec2" | "vec3"));
      });
    }),
  );

  // ---- 3D レンダリング ----
  addV(
    "orbit",
    bi("orbit", 2, (ctx, [rV, aV], span) => {
      const r = asNum(rV, span);
      const a = asNum(aV, span);
      const x = binIR(ctx, "*", r.ir, call(ctx, "cos", [a.ir], "f32"), "f32");
      const z = binIR(ctx, "*", r.ir, call(ctx, "sin", [a.ir], "f32"), "f32");
      const y = binIR(ctx, "*", r.ir, ctx.arena.node({ k: "const", v: 0.4, t: "f32" }), "f32");
      return {
        v: "cam",
        eye: vecV(3, ctx.arena.node({ k: "vec", parts: [x, y, z], t: "vec3" })),
        target: constVec(ctx, [0, 0, 0]),
        fov: constF(ctx, 1.1),
      };
    }),
  );
  addV(
    "camera",
    bi("camera", 2, (ctx, [eyeV, tgtV], span) => ({
      v: "cam",
      eye: asVec(ctx, eyeV, span, 3),
      target: asVec(ctx, tgtV, span, 3),
      fov: constF(ctx, 1.1),
    })),
  );
  addV(
    "render",
    bi("render", 2, (ctx, [camV, shV], span) => {
      if (camV.v !== "cam") fail(`render の第1引数はカメラですが、${describe(camV)} が渡されました`, span);
      const sh = toShape(ctx, shV, span);
      if (sh.dim === 2) fail("render は3D図形用です(2D図形はそのまま out に渡せます)", span);
      const coord3 = ctx.arena.node({ k: "coord", t: "vec3" });
      const p3 = vecV(3, coord3);
      const distRoot = sh.dist(ctx, p3, span).ir;
      const colourRoot = sh.colour(ctx, p3, span).ir;
      const id = ctx.raymarches.length;
      ctx.raymarches.push({
        kind: "raymarch",
        id,
        dist: distRoot,
        colour: colourRoot,
        eye: camV.eye.ir,
        target: camV.target.ir,
        fov: camV.fov.ir,
        span,
        spriteBatches: sh.spriteBatches,
        strip3Batches: sh.strip3Batches,
      });
      return {
        v: "field",
        dim: 2,
        fn: (c, p) => vecV(4, c.arena.node({ k: "sample", tex: `rm:${id}`, p: worldToUv(c, p.ir), t: "vec4" })),
      } as VField;
    }),
  );
}
