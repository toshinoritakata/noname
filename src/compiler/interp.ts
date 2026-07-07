// CPU 側 IR インタプリタ(implementation.md 8章)。
// SDF 性質テスト(境界 ≈ 0 / Lipschitz)・golden 期待値の生成・
// エディタ上の「この座標の値は?」インスペクタの3役を兼ねる。
// ライブラリ関数は wgsl.ts の WGSL 実装と同じアルゴリズム。

import type { IRArena, NodeId } from "./ir.ts";

export type Num = number | number[];

export interface InterpEnv {
  /** coord ノードの値(vec2 or vec3) */
  coord: number[];
  /** input ノード(time / dt など)。無ければ 0 */
  inputs?: Record<string, number>;
  /** uniform 表(リテラル値)。無ければ arena の値を使う */
  literals?: number[];
  /** テクスチャサンプル(tex キー, uv/index)→ vec4。無ければ [0,0,0,0] */
  sample?: (tex: string, p: number[]) => number[];
}

export function interpret(arena: IRArena, root: NodeId, env: InterpEnv): Num {
  const memo = new Map<NodeId, Num>();
  const loopVars = new Map<number, { i: number; acc: Num }>();

  const evalNode = (id: NodeId): Num => {
    // ループ変数依存ノードは memo できないので、ループ実行中は memo を使わない
    if (loopVars.size === 0) {
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
    }
    const n = arena.get(id);
    let out: Num;
    switch (n.k) {
      case "coord":
        out = env.coord;
        break;
      case "input":
        out = env.inputs?.[n.name] ?? 0;
        break;
      case "uniform":
        out = env.literals?.[n.idx] ?? arena.uniforms[n.idx]?.value ?? 0;
        break;
      case "const":
        out = n.v;
        break;
      case "bin": {
        const a = evalNode(n.a);
        const b = evalNode(n.b);
        out = zip(a, b, (x, y) => binop(n.op, x, y));
        break;
      }
      case "un": {
        const a = evalNode(n.a);
        out = mapN(a, (x) => (n.op === "neg" ? -x : x === 0 ? 1 : 0));
        break;
      }
      case "call":
        out = callFn(n.fn, n.args.map(evalNode));
        break;
      case "vec": {
        const parts = n.parts.map(evalNode);
        const flat: number[] = [];
        for (const p of parts) {
          if (Array.isArray(p)) flat.push(...p);
          else flat.push(p);
        }
        out = flat;
        break;
      }
      case "swiz": {
        const a = evalNode(n.a);
        const arr = Array.isArray(a) ? a : [a];
        const idx = { x: 0, y: 1, z: 2, w: 3 } as const;
        const picked = [...n.sel].map((c) => arr[idx[c as "x"]] ?? 0);
        out = picked.length === 1 ? picked[0] : picked;
        break;
      }
      case "select": {
        const c = evalNode(n.c);
        out = (Array.isArray(c) ? c[0] : c) !== 0 ? evalNode(n.a) : evalNode(n.b);
        break;
      }
      case "sample":
        out = env.sample?.(n.tex, asArr(evalNode(n.p))) ?? [0, 0, 0, 0];
        break;
      case "fetch":
        out = env.sample?.(n.tex, [asNum(evalNode(n.i)), 0]) ?? [0, 0, 0, 0];
        break;
      case "rmctx":
        out = n.t === "f32" ? 0 : [0, 0, 0];
        break;
      case "loop": {
        let acc = evalNode(n.init);
        for (let i = 0; i < n.count; i++) {
          loopVars.set(n.id, { i, acc });
          acc = evalNode(n.body);
        }
        loopVars.delete(n.id);
        out = acc;
        break;
      }
      case "loopi": {
        const lv = loopVars.get(n.id);
        out = lv ? lv.i : 0;
        break;
      }
      case "loopacc": {
        const lv = loopVars.get(n.id);
        out = lv ? lv.acc : 0;
        break;
      }
      case "ffi":
        // 不透明ノードは CPU では評価できない(テストでは 0)
        out = n.t === "f32" ? 0 : [0, 0, 0, 0];
        break;
    }
    if (loopVars.size === 0) memo.set(id, out);
    return out;
  };

  return evalNode(root);
}

function asArr(v: Num): number[] {
  return Array.isArray(v) ? v : [v];
}
function asNum(v: Num): number {
  return Array.isArray(v) ? v[0] : v;
}

function zip(a: Num, b: Num, f: (x: number, y: number) => number): Num {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => f(x, b[i] ?? 0));
  if (Array.isArray(a)) return a.map((x) => f(x, b as number));
  if (Array.isArray(b)) return b.map((y) => f(a, y));
  return f(a, b);
}
function mapN(a: Num, f: (x: number) => number): Num {
  return Array.isArray(a) ? a.map(f) : f(a);
}

function binop(op: string, x: number, y: number): number {
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? 0 : x / y;
    case "%":
      return y === 0 ? 0 : x - y * Math.floor(x / y);
    case "<":
      return x < y ? 1 : 0;
    case ">":
      return x > y ? 1 : 0;
    case "<=":
      return x <= y ? 1 : 0;
    case ">=":
      return x >= y ? 1 : 0;
    case "==":
      return x === y ? 1 : 0;
    case "!=":
      return x !== y ? 1 : 0;
    case "&&":
      return x !== 0 && y !== 0 ? 1 : 0;
    case "||":
      return x !== 0 || y !== 0 ? 1 : 0;
    default:
      return 0;
  }
}

// ---- ライブラリ関数(wgsl.ts の LIB と同一アルゴリズム) ---------------------------

function fract(x: number): number {
  return x - Math.floor(x);
}
function clampN(x: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, x));
}
function mixN(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function len(v: number[]): number {
  return Math.hypot(...v);
}

// wgsl.ts の hashMix と同一アルゴリズム(MurmurHash3 の fmix32)。ビット列を
// そのまま混ぜるので、10進小数演算で入力が大きいと衝突が急増する旧実装の
// 欠陥が起きない(wgsl.ts 側のコメント参照)
const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
function bitcastF32ToU32(x: number): number {
  f32buf[0] = x;
  return u32buf[0];
}
function hashMix(seed: number): number {
  let v = seed >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  v = Math.imul(v, 0x7feb352d) >>> 0;
  v = (v ^ (v >>> 15)) >>> 0;
  v = Math.imul(v, 0x846ca68b) >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  return v;
}
function hash12(p: number[]): number {
  const hx = hashMix(bitcastF32ToU32(Math.fround(p[0])));
  const hy = hashMix((bitcastF32ToU32(Math.fround(p[1])) ^ 0x9e3779b9) >>> 0);
  return hashMix((hx ^ hy) >>> 0) * (1 / 4294967296);
}

function hash11(n: number): number {
  return hashMix(bitcastF32ToU32(Math.fround(n))) * (1 / 4294967296);
}

function hash21JS(n: number): number[] {
  const h0 = hashMix(bitcastF32ToU32(Math.fround(n)));
  const h1 = hashMix((h0 ^ 0x68bc21eb) >>> 0);
  return [h0 * (1 / 4294967296), h1 * (1 / 4294967296)];
}

function noise2d(p: number[]): number {
  const i = [Math.floor(p[0]), Math.floor(p[1])];
  const f = [fract(p[0]), fract(p[1])];
  const u = f.map((x) => x * x * (3 - 2 * x));
  const h = (ox: number, oy: number): number => hash12([i[0] + ox, i[1] + oy]);
  return mixN(mixN(h(0, 0), h(1, 0), u[0]), mixN(h(0, 1), h(1, 1), u[0]), u[1]);
}

function callFn(fn: string, args: Num[]): Num {
  const a = args[0];
  const b = args[1];
  const c = args[2];
  switch (fn) {
    case "sin":
      return mapN(a, Math.sin);
    case "cos":
      return mapN(a, Math.cos);
    case "tan":
      return mapN(a, Math.tan);
    case "abs":
      return mapN(a, Math.abs);
    case "floor":
      return mapN(a, Math.floor);
    case "ceil":
      return mapN(a, Math.ceil);
    case "fract":
      return mapN(a, fract);
    case "sqrt":
      return mapN(a, Math.sqrt);
    case "exp":
      return mapN(a, Math.exp);
    case "log":
      return mapN(a, Math.log);
    case "sign":
      return mapN(a, Math.sign);
    case "pow":
      return zip(a, b, Math.pow);
    case "atan2":
      return zip(a, b, Math.atan2);
    case "min":
      return zip(a, b, Math.min);
    case "max":
      return zip(a, b, Math.max);
    case "clamp":
      return zip(zip(a, b, Math.max), c, Math.min);
    case "mix": {
      const t = c;
      return zip(a, b, (x, y) => mixN(x, y, Array.isArray(t) ? t[0] : t));
    }
    case "step":
      return zip(a, b, (edge, x) => (x < edge ? 0 : 1));
    case "smoothstep": {
      const e0 = asNum2(a);
      const e1 = asNum2(b);
      return mapN(c, (x) => {
        const t = clampN((x - e0) / (e1 - e0 || 1e-9), 0, 1);
        return t * t * (3 - 2 * t);
      });
    }
    case "length":
      return len(asArrN(a));
    case "normalize": {
      const v = asArrN(a);
      const l = len(v) || 1e-9;
      return v.map((x) => x / l);
    }
    case "dot": {
      const va = asArrN(a);
      const vb = asArrN(b);
      return va.reduce((s, x, i) => s + x * (vb[i] ?? 0), 0);
    }
    case "cross": {
      const [x1, y1, z1] = asArrN(a);
      const [x2, y2, z2] = asArrN(b);
      return [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2];
    }
    case "reflect": {
      const v = asArrN(a);
      const n = asArrN(b);
      const d = v.reduce((s, x, i) => s + x * (n[i] ?? 0), 0);
      return v.map((x, i) => x - 2 * d * (n[i] ?? 0));
    }
    case "fmod":
      return zip(a, b, (x, y) => (y === 0 ? 0 : x - y * Math.floor(x / y)));
    case "fmodv2":
    case "fmodv3":
      return zip(a, b, (x, y) => (y === 0 ? 0 : x - y * Math.floor(x / y)));
    case "hash11":
      return hash11(asNum2(a));
    case "hash21":
      return hash21JS(asNum2(a));
    case "hash12":
      return hash12(asArrN(a));
    case "noise2d":
      return noise2d(asArrN(a));
    case "noise2v": {
      const p = asArrN(a);
      return [noise2d(p), noise2d([p[0] + 17.13, p[1] + 9.57])];
    }
    case "fbm2": {
      let v = 0;
      let amp = 0.5;
      let q = asArrN(a);
      for (let i = 0; i < 5; i++) {
        v += amp * noise2d(q);
        q = [q[0] * 2.03 + 11.3, q[1] * 2.03 + 7.9];
        amp *= 0.5;
      }
      return v;
    }
    case "rot2": {
      const p = asArrN(a);
      const ang = asNum2(b);
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      return [cs * p[0] + sn * p[1], -sn * p[0] + cs * p[1]];
    }
    case "sdBox2": {
      const p = asArrN(a);
      const bx = asArrN(b);
      const q = [Math.abs(p[0]) - bx[0], Math.abs(p[1]) - bx[1]];
      const outer = len(q.map((x) => Math.max(x, 0)));
      return outer + Math.min(Math.max(q[0], q[1]), 0);
    }
    case "sdBox3": {
      const p = asArrN(a);
      const bx = asArrN(b);
      const q = p.map((x, i) => Math.abs(x) - bx[i]);
      const outer = len(q.map((x) => Math.max(x, 0)));
      return outer + Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0);
    }
    case "sdTri": {
      const pin = asArrN(a);
      const r = asNum2(b);
      const k = Math.sqrt(3);
      let px = Math.abs(pin[0]) - r;
      let py = -pin[1] + r / k;
      if (px + k * py > 0) {
        const nx = (px - k * py) / 2;
        const ny = (-k * px - py) / 2;
        px = nx;
        py = ny;
      }
      px -= clampN(px, -2 * r, 0);
      return -len([px, py]) * Math.sign(py || 1);
    }
    case "smin": {
      const x = asNum2(a);
      const y = asNum2(b);
      const k = Math.max(asNum2(c), 1e-4);
      const h = clampN(0.5 + (0.5 * (y - x)) / k, 0, 1);
      return mixN(y, x, h) - k * h * (1 - h);
    }
    case "sminH": {
      const x = asNum2(a);
      const y = asNum2(b);
      const k = Math.max(asNum2(c), 1e-4);
      return clampN(0.5 + (0.5 * (y - x)) / k, 0, 1);
    }
    case "hsv2rgb": {
      const [h, s, v] = asArrN(a);
      const kf = (n: number): number => fract(h + n) * 6;
      const comp = (n: number): number => v * mixN(1, clampN(Math.abs(kf(n) - 3) - 1, 0, 1), s);
      return [comp(0), comp(2 / 3), comp(1 / 3)];
    }
    case "overBlend": {
      const top = asArrN(a);
      const bot = asArrN(b);
      const alpha = top[3] + bot[3] * (1 - top[3]);
      const rgb = [0, 1, 2].map((i) => top[i] * top[3] + bot[i] * bot[3] * (1 - top[3]));
      return [...rgb.map((x) => x / Math.max(alpha, 1e-5)), alpha];
    }
    case "worldToUv": {
      const p = asArrN(a);
      return [(p[0] + 1) / 2, (1 - p[1]) / 2]; // 正方形想定(テスト用)
    }
    case "gridUv": {
      const p = asArrN(a);
      return [(p[0] + 1) / 2, (-p[1] + 1) / 2];
    }
    default:
      // 未実装のライブラリ関数は 0(性質テストの対象外)
      return Array.isArray(a) ? asArrN(a).map(() => 0) : 0;
  }
}

function asArrN(v: Num): number[] {
  return Array.isArray(v) ? v : [v];
}
function asNum2(v: Num): number {
  return Array.isArray(v) ? v[0] : v;
}

