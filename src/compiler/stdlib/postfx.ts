// 画像合成・ポスト(元 stdlib.ts 1343-1460行)。

import { asNum, call, liftField, timeNode, toImage, vecV, worldToUv } from "../ops.ts";
import type { VVec } from "../value.ts";
import { bi, binIR } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";

export function installPostfx(add: AddFn, addV: AddVFn): void {
  addV(
    "fade",
    bi("fade", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      const img = toImage(ctx, x, span);
      return liftField(img, (c, p, s) => {
        const col = img.fn(c, p, s) as VVec;
        return vecV(4, binIR(c, "*", col.ir, kn.ir, "vec4"));
      });
    }),
  );
  addV(
    "zoom",
    bi("zoom", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      const img = toImage(ctx, x, span);
      return liftField(img, (c, p, s) => img.fn(c, vecV(2, binIR(c, "/", p.ir, kn.ir, "vec2")), s));
    }),
  );
  addV(
    "bloom",
    bi("bloom", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      // 段数(ダウンサンプルの深さ)はレンダーパス数を決めるコンパイル時定数
      // なので、k の値そのものではなく k の**静的な値が分かる場合はそれ**から
      // 適応的に決める(ADR-0024、ADR-0023 の手動指定版を撤回)。k が大きい
      // ほど「強く光らせたい」意図とみなし、段数を増やして実効半径を広げる。
      // k が `audio.lo` 等の動的な入力を含む式(例: `0.3 + bass`)だと定数畳み込み
      // (ops.ts の foldConst)が効かず静的値は取れないので、その場合は中庸の
      // 既定段数にフォールバックする
      const kStatic = kn.sval ?? 1;
      const levels = Math.max(2, Math.min(8, Math.round(3 + kStatic * 3)));
      const img = toImage(ctx, x, span);
      // ダウンサンプル+ブラー多パス連鎖(ADR-0019)。以前は「フル解像度で
      // 大半径・多方向タップ」の単一パス近似だったが、(1) 角度方向のサンプル
      // 密度が粗く、大きな半径では滲みが花びら状に見えるエイリアシングが出る、
      // (2) 半径をいくら広げても image パスの自己アルファ事前乗算で glow が
      // 消える構造バグがあった(ADR-0018で応急修正)、という2つの問題があった。
      // 実際のゲームエンジンで標準的な「明るい部分を抽出→段階的にダウン
      // サンプル→ブラー→アップサンプルしながら加算」という多解像度合成に
      // 作り直す。抽出(extract)だけがユーザーのコードに依存する式で、
      // ダウンサンプル/アップサンプル自体は固定のテンプレート shader
      // (wgsl.ts の generateBloomChain)。
      const coord2 = ctx.arena.node({ k: "coord", t: "vec2" });
      const p2 = vecV(2, coord2);
      const sampled = img.fn(ctx, p2, span) as VVec;
      // shape の colour() は dist/alpha を見ずに「その図形の色」を空間全域で
      // 返す(可視・不可視の判定は別チャンネルの alpha が担う、ADR-0002)。
      // brightPass は c.rgb だけを見て c.a を無視するので、そのまま渡すと
      // 図形の外側(alpha=0の透明な領域)でも同じ色が明るいとみなされ、
      // 画面全体が図形の色でうっすら光る(ADR-0026)。alpha を rgb に
      // 事前乗算してから渡し、不可視の領域は確実に真っ黒として扱う
      const sRgb = ctx.arena.node({ k: "swiz", a: sampled.ir, sel: "xyz", t: "vec3" });
      const sAlpha = ctx.arena.node({ k: "swiz", a: sampled.ir, sel: "w", t: "f32" });
      const premultRgb = binIR(ctx, "*", sRgb, sAlpha, "vec3");
      const premultiplied = ctx.arena.node({ k: "vec", parts: [premultRgb, sAlpha], t: "vec4" });
      const extractRoot = call(ctx, "brightPass", [premultiplied], "vec4");
      const id = ctx.blooms.length;
      ctx.blooms.push({ kind: "bloom", id, extract: extractRoot, levels, span });
      return liftField(img, (c, p, s) => {
        const base = img.fn(c, p, s) as VVec;
        const glow = vecV(4, c.arena.node({ k: "sample", tex: `bloom:${id}:u0`, p: worldToUv(c, p.ir), t: "vec4" }));
        const q = binIR(c, "*", glow.ir, kn.ir, "vec4");
        const outRgb = binIR(
          c,
          "+",
          c.arena.node({ k: "swiz", a: base.ir, sel: "xyz", t: "vec3" }),
          c.arena.node({ k: "swiz", a: q, sel: "xyz", t: "vec3" }),
          "vec3",
        );
        // glow の強さ(rgb最大成分、0..1にクランプ)をアルファの下限にする
        // (image パスの最終出力が自己アルファで事前乗算するため、アルファ0の
        // 背景に glow を足しても持ち上げないと消えてしまう。ADR-0018)
        const qr = c.arena.node({ k: "swiz", a: q, sel: "x", t: "f32" });
        const qg = c.arena.node({ k: "swiz", a: q, sel: "y", t: "f32" });
        const qb = c.arena.node({ k: "swiz", a: q, sel: "z", t: "f32" });
        const qMax = call(c, "max", [call(c, "max", [qr, qg], "f32"), qb], "f32");
        const glowAlpha = call(
          c,
          "clamp",
          [qMax, c.arena.node({ k: "const", v: 0, t: "f32" }), c.arena.node({ k: "const", v: 1, t: "f32" })],
          "f32",
        );
        const baseA = c.arena.node({ k: "swiz", a: base.ir, sel: "w", t: "f32" });
        const outA = call(c, "max", [baseA, glowAlpha], "f32");
        return vecV(4, c.arena.node({ k: "vec", parts: [outRgb, outA], t: "vec4" }));
      });
    }),
  );
  addV(
    "chromatic",
    bi("chromatic", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      const img = toImage(ctx, x, span);
      return liftField(img, (c, p, s) => {
        const one = c.arena.node({ k: "const", v: 1, t: "f32" });
        const pr = binIR(c, "*", p.ir, binIR(c, "+", one, kn.ir, "f32"), "vec2");
        const pb = binIR(c, "*", p.ir, binIR(c, "-", one, kn.ir, "f32"), "vec2");
        const cr = img.fn(c, vecV(2, pr), s) as VVec;
        const cg = img.fn(c, p, s) as VVec;
        const cb = img.fn(c, vecV(2, pb), s) as VVec;
        const r = c.arena.node({ k: "swiz", a: cr.ir, sel: "x", t: "f32" });
        const g = c.arena.node({ k: "swiz", a: cg.ir, sel: "y", t: "f32" });
        const b = c.arena.node({ k: "swiz", a: cb.ir, sel: "z", t: "f32" });
        const a = c.arena.node({ k: "swiz", a: cg.ir, sel: "w", t: "f32" });
        return vecV(4, c.arena.node({ k: "vec", parts: [r, g, b, a], t: "vec4" }));
      });
    }),
  );
  addV(
    "grain",
    bi("grain", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      const img = toImage(ctx, x, span);
      return liftField(img, (c, p, s) => {
        const base = img.fn(c, p, s) as VVec;
        const t = timeNode(c);
        const n = call(c, "grainNoise", [p.ir, t], "f32");
        const g = binIR(c, "*", n, kn.ir, "f32");
        const rgb = c.arena.node({ k: "swiz", a: base.ir, sel: "xyz", t: "vec3" });
        const rgb2 = binIR(c, "+", rgb, g, "vec3");
        const a = c.arena.node({ k: "swiz", a: base.ir, sel: "w", t: "f32" });
        return vecV(4, c.arena.node({ k: "vec", parts: [rgb2, a], t: "vec4" }));
      });
    }),
  );
  addV(
    "vignette",
    bi("vignette", 2, (ctx, [k, x], span) => {
      const kn = asNum(k, span);
      const img = toImage(ctx, x, span);
      return liftField(img, (c, p, s) => {
        const base = img.fn(c, p, s) as VVec;
        return vecV(4, call(c, "vignetteFn", [base.ir, p.ir, kn.ir], "vec4"));
      });
    }),
  );
}
