// 時計・定数(元 stdlib.ts 771-779行)+ 時間族(元1461-1513行)+ timeWarp(元1789行付近)。

import type { Span } from "../diag.ts";
import type { NodeId } from "../ir.ts";
import {
  asNum,
  binValue,
  boolV,
  call,
  constF,
  constVec,
  describe,
  fail,
  inputNum,
  liftDist,
  liftField,
  num,
  selectValue,
  staticNum,
  timeNode,
  vecV,
} from "../ops.ts";
import { substTime } from "../stage.ts";
import type { Ctx, Value } from "../value.ts";
import { bi } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";
import { mathApply } from "./iteration.ts";

/** slow / loop: 値の中の time を再マップする(IR 置換) */
function timeWarp(ctx: Ctx, x: Value, remap: (c: Ctx, t: NodeId) => NodeId, span: Span): Value {
  const tOld = ctx.arena.node({ k: "input", name: "time", t: "f32" });
  const apply = (root: NodeId): NodeId => substTime(ctx, root, remap(ctx, tOld));
  switch (x.v) {
    case "num":
      return num(apply(x.ir), x.sval);
    case "vec":
      return vecV(x.n, apply(x.ir), x.sval);
    case "field": {
      const f = x;
      return liftField(f, (c, p, s) => timeWarp(c, f.fn(c, p, s), remap, s));
    }
    case "shape": {
      const sh = x;
      // dist/colour の IR 中の time 参照を差し替えるだけで、座標や個体の同一性は
      // 変えない。sprite/strip2D/strip3D(単項マーカー)は warpValue と同じ理由で明示的に
      // 落とす(中の time 依存式まで追って書き換えるのは今はやらない、安全フォールバック)
      return liftDist(
        sh,
        (c, p, s) => num(apply(sh.dist(c, p, s).ir)),
        {
          colour: (c, p, s) => vecV(4, apply(sh.colour(c, p, s).ir)),
          sprite: undefined,
          strip2D: undefined,
          strip3D: undefined,
        },
      );
    }
    default:
      fail(`slow / loop は ${describe(x)} には使えません`, span);
  }
}

export function installTime(add: AddFn, addV: AddVFn): void {
  // ---- 時計・定数 ----
  add("time", (ctx) => num(timeNode(ctx)));
  add("etime", (ctx) => inputNum(ctx, "etime"));
  add("etime'", (ctx) => inputNum(ctx, "etimeF"));
  add("dt", (ctx) => inputNum(ctx, "dt"));
  add("cps", (ctx) => inputNum(ctx, "cps"));
  add("pi", (ctx) => constF(ctx, Math.PI));
  add("tau", (ctx) => constF(ctx, Math.PI * 2));
  add("gravity", (ctx) => constVec(ctx, [0, -3.0, 0]));

  // ---- 時間族 ----
  const lagBuiltin = bi("lag", 2, (ctx, [k, x], span) => {
    const kv = staticNum(k, "lag の平滑化係数", span);
    const xn = asNum(x, span);
    const node = ctx.arena.get(xn.ir);
    if (node.k !== "input") {
      fail("lag は外部入力(audio.* / mouse.* / midi.*)にだけ使えます", span);
    }
    const name = `lag:${node.name}:${kv}`;
    if (!ctx.derivedInputs.some((d) => d.name === name)) {
      ctx.derivedInputs.push({ name, source: node.name, kind: "lag", k: kv });
    }
    return inputNum(ctx, name);
  });
  addV("lag", lagBuiltin);
  add("smooth", () => lagBuiltin);
  addV(
    "slow",
    bi("slow", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      return timeWarp(ctx, x, (c, t) => c.arena.node({ k: "bin", op: "/", a: t, b: kn.ir, t: "f32" }), span);
    }),
  );
  addV(
    "loop",
    bi("loop", 2, (ctx, [d, x], span) => {
      const dn = asNum(d, span);
      return timeWarp(ctx, x, (c, t) => call(c, "fmod", [t, dn.ir], "f32"), span);
    }),
  );
  addV(
    "cycle",
    bi("cycle", 2, (ctx, [d, xs], span) => {
      if (xs.v !== "list") fail("cycle には値のリストが必要です(例: cycle 2s [circle 0.4, box 0.3])", span);
      const dn = d.v === "dur" ? d : asNum(d, span);
      return { v: "pat", durSec: dn.ir, durSval: d.v === "dur" ? d.sval : undefined, items: xs.items, morph: null };
    }),
  );
  addV(
    "every",
    bi("every", 3, (ctx, [nV, f, x], span) => {
      const n = asNum(nV, span);
      const spb = inputNum(ctx, "spb");
      const t = num(timeNode(ctx));
      const beat = mathApply(ctx, "floor", [binValue(ctx, "/", t, spb, span)], span);
      const m = mathApply(ctx, "fmod", [beat, n], span);
      const cond = boolV(ctx.arena.node({ k: "bin", op: "<", a: asNum(m, span).ir, b: ctx.arena.node({ k: "const", v: 0.5, t: "f32" }), t: "bool" }));
      const fx = ctx.apply(ctx, f, x, span);
      return selectValue(ctx, cond, fx, x, span);
    }),
  );
}
