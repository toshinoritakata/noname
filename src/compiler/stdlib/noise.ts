// 場プリミティブ(元 stdlib.ts 829-859行): noise/fbm/curl 系。

import { asNum, asVec, call, num, vecV } from "../ops.ts";
import type { NodeId } from "../ir.ts";
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
  addV(
    "checker",
    bi("checker", 1, (ctx, [sV], span) => {
      const s = asNum(sV, span);
      return {
        v: "field",
        dim: 0,
        fn: (c, p) => {
          const is3 = c.arena.typeOf(p.ir) === "vec3";
          const cellOf = (sel: "x" | "y" | "z"): NodeId => {
            const comp = c.arena.node({ k: "swiz", a: p.ir, sel, t: "f32" });
            return call(c, "floor", [binIR(c, "/", comp, s.ir, "f32")], "f32");
          };
          let sum = binIR(c, "+", cellOf("x"), cellOf("y"), "f32");
          if (is3) sum = binIR(c, "+", sum, cellOf("z"), "f32");
          const two = c.arena.node({ k: "const", v: 2, t: "f32" });
          return num(call(c, "fmod", [sum, two], "f32"));
        },
      } as VField;
    }),
  );
  addV(
    "voronoi",
    bi("voronoi", 1, (ctx, [sV], span) => {
      const s = asNum(sV, span);
      return {
        v: "field",
        dim: 0,
        fn: (c, p) => {
          const is3 = c.arena.typeOf(p.ir) === "vec3";
          return num(call(c, is3 ? "voronoi3" : "voronoi2", [p.ir, s.ir], "f32"));
        },
      } as VField;
    }),
  );
  addV(
    "brick",
    bi("brick", 1, (ctx, [sV], span) => {
      const s = asNum(sV, span);
      return {
        v: "field",
        dim: 2,
        fn: (c, p) => {
          // レンガは2:1(幅:高さ)、1段おきに半幅ずらす定番パターン
          const x = c.arena.node({ k: "swiz", a: p.ir, sel: "x", t: "f32" });
          const y = c.arena.node({ k: "swiz", a: p.ir, sel: "y", t: "f32" });
          const half = c.arena.node({ k: "const", v: 0.5, t: "f32" });
          const two = c.arena.node({ k: "const", v: 2, t: "f32" });
          const rowH = binIR(c, "*", s.ir, half, "f32");
          const row = call(c, "floor", [binIR(c, "/", y, rowH, "f32")], "f32");
          const rowParity = call(c, "fmod", [row, two], "f32");
          const offset = binIR(c, "*", rowParity, binIR(c, "*", s.ir, half, "f32"), "f32");
          const xShifted = binIR(c, "+", x, offset, "f32");
          const xLocal = call(c, "fract", [binIR(c, "/", xShifted, s.ir, "f32")], "f32");
          const yLocal = call(c, "fract", [binIR(c, "/", y, rowH, "f32")], "f32");
          const mortar = c.arena.node({ k: "const", v: 0.06, t: "f32" });
          const inMortarX = call(c, "step", [xLocal, mortar], "f32");
          const inMortarY = call(c, "step", [yLocal, mortar], "f32");
          const one = c.arena.node({ k: "const", v: 1, t: "f32" });
          const inMortar = call(c, "min", [binIR(c, "+", inMortarX, inMortarY, "f32"), one], "f32");
          return num(binIR(c, "-", one, inMortar, "f32"));
        },
      } as VField;
    }),
  );
}
