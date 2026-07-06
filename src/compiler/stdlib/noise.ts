// 場プリミティブ(元 stdlib.ts 829-859行): noise/fbm/curl 系。

import { asNum, asVec, call, num, vecV } from "../ops.ts";
import type { VField } from "../value.ts";
import { bi, binIR, lifted } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";

/** 次元で 2D/3D 実装を切り替える場(noise / fbm / curl) */
function fieldCall(fn2: string, fn3: string, result: "f32" | "vec2"): VField {
  return {
    v: "field",
    dim: 0,
    fn: (c, p) => {
      const is3 = c.arena.typeOf(p.ir) === "vec3";
      const node = call(c, is3 ? fn3 : fn2, [p.ir], result);
      return result === "f32" ? num(node) : vecV(2, node);
    },
  };
}

function fieldCall3(fn: string, result: "f32"): VField {
  return {
    v: "field",
    dim: 0,
    fn: (c, p) => {
      // 2D 座標なら z=0 に持ち上げる(fbm3 を 2D 文脈でも使えるように)
      const is3 = c.arena.typeOf(p.ir) === "vec3";
      const p3 = is3
        ? p.ir
        : c.arena.node({ k: "vec", parts: [p.ir, c.arena.node({ k: "const", v: 0, t: "f32" })], t: "vec3" });
      return num(call(c, fn, [p3], result));
    },
  };
}

export function installNoise(add: AddFn, addV: AddVFn): void {
  add("noise", () => fieldCall("noise2d", "noise3d", "f32"));
  add("noise2", () => fieldCall("noise2v", "noise2v", "vec2"));
  add("fbm", () => fieldCall("fbm2", "fbm3", "f32"));
  add("fbm2", () => fieldCall("fbm2", "fbm2", "f32"));
  add("fbm3", () => fieldCall3("fbm3", "f32"));
  add("curl", () => fieldCall("curl2", "curl2", "vec2"));
  addV("hash", lifted("hash", 1, (ctx, [i], span) => num(call(ctx, "hash11", [asNum(i, span).ir], "f32"))));
  addV("hash2", lifted("hash2", 1, (ctx, [i], span) => vecV(2, call(ctx, "hash21", [asNum(i, span).ir], "vec2"))));
  addV(
    "onSphere",
    lifted("onSphere", 1, (ctx, [v], span) => vecV(3, call(ctx, "onSphere", [asVec(ctx, v, span, 2).ir], "vec3"))),
  );
  addV(
    "stripes",
    bi("stripes", 1, (ctx, [nV], span) => {
      const n = asNum(nV, span);
      return {
        v: "field",
        dim: 2,
        fn: (c, p) => {
          const x = c.arena.node({ k: "swiz", a: p.ir, sel: "x", t: "f32" });
          const freq = binIR(c, "*", x, binIR(c, "*", n.ir, c.arena.node({ k: "const", v: Math.PI, t: "f32" }), "f32"), "f32");
          const s = call(c, "sin", [freq], "f32");
          const half = c.arena.node({ k: "const", v: 0.5, t: "f32" });
          return num(binIR(c, "+", half, binIR(c, "*", half, s, "f32"), "f32"));
        },
      } as VField;
    }),
  );
}
