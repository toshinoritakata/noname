// 入力(ADR-0012: スカラー uniform とエンティティ表)。元 stdlib.ts 1666-1742行。

import { asNum, fail, inputNum, num, staticNum, vecV, worldToUv } from "../ops.ts";
import { bi, binIR, rec } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";
import type { VField } from "../value.ts";

export function installInputs(add: AddFn, addV: AddVFn): void {
  add("audio", (ctx) =>
    rec([
      ["low", inputNum(ctx, "audio.lo")],
      ["lo", inputNum(ctx, "audio.lo")],
      ["mid", inputNum(ctx, "audio.mid")],
      ["high", inputNum(ctx, "audio.hi")],
      ["hi", inputNum(ctx, "audio.hi")],
      ["level", inputNum(ctx, "audio.level")],
      [
        "fft",
        bi("fft", 1, (c, [i], s) => {
          const idx = asNum(i, s);
          const texel = c.arena.node({ k: "fetch", tex: "fft", i: idx.ir, t: "vec4" });
          return num(c.arena.node({ k: "swiz", a: texel, sel: "x", t: "f32" }));
        }),
      ],
    ]),
  );
  add("fft", () =>
    bi("fft", 1, (c, [i], s) => {
      const idx = asNum(i, s);
      const texel = c.arena.node({ k: "fetch", tex: "fft", i: idx.ir, t: "vec4" });
      return num(c.arena.node({ k: "swiz", a: texel, sel: "x", t: "f32" }));
    }),
  );
  add("entropy", (ctx) => inputNum(ctx, "entropy"));
  add("mouse", (ctx) =>
    rec([
      ["x", inputNum(ctx, "mouse.x")],
      ["y", inputNum(ctx, "mouse.y")],
      [
        "pos",
        vecV(
          2,
          ctx.arena.node({
            k: "vec",
            parts: [ctx.arena.node({ k: "input", name: "mouse.x", t: "f32" }), ctx.arena.node({ k: "input", name: "mouse.y", t: "f32" })],
            t: "vec2",
          }),
        ),
      ],
      ["down", inputNum(ctx, "mouse.down")],
    ]),
  );
  add("midi", () =>
    rec([
      [
        "cc",
        bi("cc", 1, (c, [n], s) => {
          const idx = Math.round(staticNum(n, "MIDI CC 番号", s));
          return inputNum(c, `midi.cc${idx}`);
        }),
      ],
    ]),
  );
  add("osc", () =>
    rec([
      [
        "f",
        bi("f", 1, (c, [n], s) => {
          const idx = Math.round(staticNum(n, "OSC スロット番号", s));
          if (idx < 0 || idx > 31) fail(`osc.f の番号は 0〜31 です(${idx})。ADR-0029: 中継ヘルパーは32スロット固定のバンクとして OSC アドレス末尾の数字を割り当てる`, s);
          return inputNum(c, `osc.f${idx}`);
        }),
      ],
    ]),
  );
  // webcam(ADR-0030): prev/simulate と同じ「2Dテクスチャを worldToUv でサンプルする
  // Field」パターン。3D用の `camera eye target` コンストラクタと名前が衝突しないよう
  // `webcam` にした
  add("webcam", (ctx) => {
    return {
      v: "field",
      dim: 2,
      fn: (c, p) => vecV(4, c.arena.node({ k: "sample", tex: "cam", p: worldToUv(c, p.ir), t: "vec4" })),
    } as VField;
  });
  add("tuio", () =>
    rec([
      [
        "cursor",
        bi("cursor", 1, (c, [i], s) => {
          const idx = asNum(i, s);
          const two = c.arena.node({ k: "const", v: 2, t: "f32" });
          const base = binIR(c, "*", idx.ir, two, "f32");
          const one = c.arena.node({ k: "const", v: 1, t: "f32" });
          const t0 = c.arena.node({ k: "fetch", tex: "ent:tuio", i: base, t: "vec4" });
          const t1 = c.arena.node({ k: "fetch", tex: "ent:tuio", i: binIR(c, "+", base, one, "f32"), t: "vec4" });
          return rec([
            ["pos", vecV(2, c.arena.node({ k: "swiz", a: t0, sel: "xy", t: "vec2" }))],
            ["angle", num(c.arena.node({ k: "swiz", a: t0, sel: "z", t: "f32" }))],
            ["alive", num(c.arena.node({ k: "swiz", a: t0, sel: "w", t: "f32" }))],
            ["vel", vecV(2, c.arena.node({ k: "swiz", a: t1, sel: "xy", t: "vec2" }))],
            ["age", num(c.arena.node({ k: "swiz", a: t1, sel: "z", t: "f32" }))],
          ]);
        }),
      ],
    ]),
  );
}
