// simulate 機構(元 stdlib.ts 164-337行)と、状態セクションの登録
// (元1515行付近: prev/simulate/laplacian/sample)。

import type { Span } from "../diag.ts";
import { buildVec4Roots, padOffset, vecType, type IRType, type NodeId } from "../ir.ts";
import {
  asVec,
  constVec,
  describe,
  extractChannel,
  fail,
  fetchStateAt,
  num,
  sampleStateAt,
  simToField,
  simUv,
  toField,
  vecV,
  worldToUv,
} from "../ops.ts";
import type { Ctx, SimHandle, StateChannel, Value, VField, VVec } from "../value.ts";
import { texKeyPrev, texKeySim } from "../tex-keys.ts";
import { bi, binIR } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";

function packChannels(ctx: Ctx, probe: Value, span: Span): { channels: StateChannel[]; total: number } {
  const channels: StateChannel[] = [];
  let offset = 0;
  const push = (path: string[], len: 1 | 2 | 3 | 4): void => {
    offset = padOffset(offset, len); // vec4 境界を跨がないようにパディング(ir.ts)
    channels.push({ path, len, offset });
    offset += len;
  };
  const leafLen = (v: Value): 1 | 2 | 3 | 4 => {
    if (v.v === "num" || v.v === "bool" || v.v === "dur") return 1;
    if (v.v === "vec") return v.n;
    if (v.v === "list" && v.items.length >= 2 && v.items.length <= 4) return v.items.length as 2 | 3 | 4;
    if (v.v === "field") {
      fail("simulate の状態に場は入れられません(数・ベクトル・レコードのみ)", span);
    }
    fail(`simulate の状態にできない値です: ${describe(v)}`, span);
  };
  if (probe.v === "rec") {
    for (const [k, v] of probe.fields) push([k], leafLen(v));
  } else {
    push([], leafLen(probe));
  }
  return { channels, total: offset };
}

/** Value(数/ベクトル/リスト/レコード)をチャネルレイアウトに従って vec4 ルート列に詰める */
function packRoots(ctx: Ctx, v: Value, channels: StateChannel[], texCount: number, span: Span): NodeId[] {
  const comps: (NodeId | null)[] = new Array(texCount * 4).fill(null);
  const setChannel = (ch: StateChannel, val: Value): void => {
    let ir: NodeId;
    let len: number;
    if (val.v === "num" || val.v === "dur" || val.v === "bool") {
      ir = val.ir;
      len = 1;
    } else if (val.v === "vec") {
      ir = val.ir;
      len = val.n;
    } else if (val.v === "list") {
      const vv = asVec(ctx, val, span);
      ir = vv.ir;
      len = vv.n;
    } else {
      fail(`状態の \`${ch.path.join(".") || "値"}\` が数/ベクトルになりません(${describe(val)})`, span);
    }
    if (len !== ch.len) {
      fail(`状態の \`${ch.path.join(".") || "値"}\` の要素数が初期値と合いません(${ch.len} 対 ${len})`, span);
    }
    if (len === 1) {
      comps[ch.offset] = ir;
    } else {
      for (let i = 0; i < len; i++) {
        comps[ch.offset + i] = ctx.arena.node({ k: "swiz", a: ir, sel: "xyzw"[i], t: "f32" });
      }
    }
  };
  if (channels.length === 1 && channels[0].path.length === 0) {
    setChannel(channels[0], v);
  } else {
    if (v.v !== "rec") {
      fail(`状態はレコード({${channels.map((c) => c.path[0]).join(", ")}})が必要ですが、${describe(v)} が返されました`, span);
    }
    for (const ch of channels) {
      const f = v.fields.get(ch.path[0]);
      if (!f) fail(`状態のフィールド \`${ch.path[0]}\` が更新則の返り値にありません`, span);
      setChannel(ch, f);
    }
  }
  return buildVec4Roots(ctx.arena, comps, texCount);
}

/** 更新則の返り値(場やレコードの場)を座標で解決して具体値にする */
function resolveAtCoord(ctx: Ctx, v: Value, p: VVec, span: Span): Value {
  switch (v.v) {
    case "field":
      return resolveAtCoord(ctx, v.fn(ctx, p, span), p, span);
    case "sim":
      return resolveAtCoord(ctx, simToField(ctx, v.handle), p, span);
    case "rec": {
      const fields = new Map<string, Value>();
      for (const [k, x] of v.fields) fields.set(k, resolveAtCoord(ctx, x, p, span));
      return { v: "rec", fields };
    }
    case "list":
      return { v: "list", items: v.items.map((x) => resolveAtCoord(ctx, x, p, span)) };
    default:
      return v;
  }
}

/** グリッド状態をチャネルごとの場(state マーカー付き)として見せる */
function stateValueFor(ctx: Ctx, handle: SimHandle): Value {
  const chField = (offset: number, len: number, path: string[]): VField => ({
    v: "field",
    dim: handle.kind === "grid" ? 2 : 1,
    fn: (c, p) => {
      const texels =
        handle.kind === "grid"
          ? sampleStateAt(c, handle, simUv(c, handle, p.ir))
          : fetchStateAt(c, handle, c.arena.node({ k: "swiz", a: p.ir, sel: "x", t: "f32" }));
      return extractChannel(c, texels, offset, len);
    },
    state: { handle, offset, len },
  });
  if (handle.channels.length === 1 && handle.channels[0].path.length === 0) {
    const ch = handle.channels[0];
    return chField(ch.offset, ch.len, ch.path);
  }
  const fields = new Map<string, Value>();
  for (const ch of handle.channels) fields.set(ch.path[0], chField(ch.offset, ch.len, ch.path));
  return { v: "rec", fields };
}

function makeSimulate(ctx: Ctx, count: number | null, init: Value, update: Value, span: Span): Value {
  const name = ctx.bindingName;
  if (!name) {
    fail("simulate は名前に束縛してください(例: rd = simulate ...)。名前が状態の同一性になります", span);
  }
  const coord = ctx.arena.node({ k: "coord", t: "vec2" });
  const coordV = vecV(2, coord);

  // 初期値の評価とレイアウト決定
  let kind: "grid" | "array";
  let width: number;
  let height: number;
  let initVal: Value;
  if (init.v === "clo" || init.v === "bi") {
    if (count === null) {
      // 関数を初期値にするなら 1D 配列。要素数が必要
      fail("パーティクル状態には要素数が必要です(例: simulate 4096 init 更新則)", span);
    }
    kind = "array";
    width = count;
    height = 1;
    const ix = num(ctx.arena.node({ k: "swiz", a: coord, sel: "x", t: "f32" }));
    initVal = resolveAtCoord(ctx, ctx.apply(ctx, init, ix, span), coordV, span);
  } else {
    kind = "grid";
    width = count ?? 256;
    height = count ?? 256;
    const f = toField(ctx, init, span);
    initVal = resolveAtCoord(ctx, f.fn(ctx, coordV, span), coordV, span);
  }

  const { channels, total } = packChannels(ctx, initVal, span);
  const texCount = Math.ceil(
    channels.reduce((m, c) => Math.max(m, c.offset + c.len), 0) / 4,
  );
  const sig = `${kind}:${width}x${height}:` + channels.map((c) => `${c.path.join(".")}#${c.len}@${c.offset}`).join(",");
  const handle: SimHandle = {
    name,
    kind,
    width,
    height,
    channels,
    totalFloats: total,
    texCount,
    sig,
    texKey: (i: number) => texKeySim(name, i),
  };

  const initRoots = packRoots(ctx, initVal, channels, texCount, span);

  // 更新則: 状態場を渡して評価し、同じ座標で解決
  const sVal = stateValueFor(ctx, handle);
  const updated = ctx.apply(ctx, update, sVal, span);
  const updateVal = resolveAtCoord(ctx, updated, coordV, span);
  const updateRoots = packRoots(ctx, updateVal, channels, texCount, span);

  ctx.sims.push({ kind: "sim", handle, initRoots, updateRoots, span });
  return { v: "sim", handle };
}

/** laplacian: 状態場(またはそのレコード)に 5 点ステンシル */
function laplacianValue(ctx: Ctx, s: Value, span: Span): Value {
  if (s.v === "rec") {
    const fields = new Map<string, Value>();
    for (const [k, v] of s.fields) fields.set(k, laplacianValue(ctx, v, span));
    return { v: "rec", fields };
  }
  if (s.v === "sim") return laplacianValue(ctx, simToField(ctx, s.handle), span);
  if (s.v !== "field" || !s.state) {
    fail("laplacian は simulate の状態(またはそのフィールド)にだけ使えます", span);
  }
  const st = s.state;
  if (st.handle.kind !== "grid") fail("laplacian はグリッド状態専用です", span);
  return {
    v: "field",
    dim: 2,
    fn: (c, p) => {
      const w = st.handle.width;
      const h = st.handle.height;
      const uv = simUv(c, st.handle, p.ir);
      const read = (dx: number, dy: number): NodeId => {
        const off = constVec(c, [dx / w, dy / h]);
        const uvo = binIR(c, "+", uv, off.ir, "vec2");
        const texels = sampleStateAt(c, st.handle, uvo);
        const v = extractChannel(c, texels, st.offset, st.len);
        return v.v === "num" ? v.ir : (v as VVec).ir;
      };
      const t: IRType = st.len === 1 ? "f32" : vecType(st.len);
      const sum = binIR(c, "+", binIR(c, "+", read(1, 0), read(-1, 0), t), binIR(c, "+", read(0, 1), read(0, -1), t), t);
      const four = c.arena.node({ k: "const", v: 4, t: "f32" });
      const centre = read(0, 0);
      const lap = binIR(c, "-", sum, binIR(c, "*", centre, four, t), t);
      return st.len === 1 ? num(lap) : vecV(st.len as 2 | 3 | 4, lap);
    },
    state: st,
  } as VField;
}

function applySample(ctx: Ctx, f: VField, pV: Value, span: Span): Value {
  if (pV.v === "field") {
    const pf = pV;
    return { v: "field", dim: pf.dim, fn: (c, p, s) => f.fn(c, asVec(c, pf.fn(c, p, s), s), s) } as VField;
  }
  return f.fn(ctx, asVec(ctx, pV, span), span);
}

export function installSimulate(add: AddFn, addV: AddVFn): void {
  // ---- 状態(ADR-0003) ----
  add("prev", (ctx) => {
    ctx.usesPrev = true;
    return {
      v: "field",
      dim: 2,
      fn: (c, p) => vecV(4, c.arena.node({ k: "sample", tex: texKeyPrev, p: worldToUv(c, p.ir), t: "vec4" })),
    } as VField;
  });
  addV(
    "simulate",
    bi("simulate", 2, (ctx, [a, b], span) => {
      if ((a.v === "num" || a.v === "dur") && a.sval !== undefined) {
        // simulate N init update(パーティクル用)
        const count = Math.round(a.sval);
        return bi("simulate'", 1, (c, [upd], s) => makeSimulate(c, count, b, upd, s));
      }
      return makeSimulate(ctx, null, a, b, span);
    }),
  );
  addV(
    "laplacian",
    bi("laplacian", 1, (ctx, [s], span) => laplacianValue(ctx, s, span)),
  );
  addV(
    "sample",
    bi("sample", 2, (ctx, [s, pV], span) => {
      const f = s.v === "sim" ? simToField(ctx, s.handle) : s.v === "field" ? s : null;
      if (!f) fail(`sample には simulate の場が必要ですが、${describe(s)} が渡されました`, span);
      return applySample(ctx, f, pV, span);
    }),
  );
}
