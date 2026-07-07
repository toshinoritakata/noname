// WGSL 生成(implementation.md 4章・6章)。
// StagedProgram のパス群(Simulate / Raymarch / Image)をパスごとのシェーダに落とす。
// - uniform 表: header(res/px)+ 入力スロット + 昇格リテラル(ADR-0008)
// - パス単位の構造ハッシュで差分再コンパイル(3.4)
// - 生成行 → IR ノード → ソース span の対応表(6.3)

import type { Span } from "./diag.ts";
import {
  buildVec4Roots,
  fnv1a,
  padOffset,
  vecLen,
  vecType,
  type IRArena,
  type IRNode,
  type IRType,
  type NodeId,
} from "./ir.ts";
import type { StagedProgram } from "./stage.ts";

export interface CompiledPass {
  kind:
    | "sim-init"
    | "sim-update"
    | "data"
    | "raymarch"
    | "sprite"
    | "strip"
    | "strip3d"
    | "image"
    | "bloom-extract"
    | "bloom-down"
    | "bloom-up";
  code: string;
  /** MRT のターゲット数 */
  targets: number;
  /** group(0) binding 2.. に並ぶテクスチャキー */
  textures: string[];
  simName?: string;
  rmId?: number;
  /** data パス: 出力テクスチャのキー接頭辞(`${dataKey}:${t}`)と要素数 */
  dataKey?: string;
  dataCount?: number;
  /** raymarch パス: ループ重量級は半解像度で描く */
  halfRes?: boolean;
  /** sprite パス: 描画先の raymarch id とインスタンス数(implementation.md 追加、ADR-0014) */
  spriteRmId?: number;
  spriteCount?: number;
  /** strip パス: インスタンス数と頂点数(implementation.md 追加、ADR-0016)。最終画像に直接描く */
  stripCount?: number;
  stripVertexCount?: number;
  /** strip3d パス: 描画先の raymarch id・インスタンス数・頂点数(ADR-0036)。
   * sprite と同じく深度テストなしでレイマーチ結果に重ね描きする */
  strip3RmId?: number;
  strip3Count?: number;
  strip3VertexCount?: number;
  /** bloom-*: 対応する BloomPassSpec の id、出力テクスチャキー、解像度の分母(ADR-0019) */
  bloomId?: number;
  bloomOutKey?: string;
  bloomResDivisor?: number;
  hash: string;
  /** 生成 WGSL の行番号(1-based)→ 元コードの span */
  lineSpans: (Span | null)[];
}

export interface SimRuntimeSpec {
  name: string;
  sig: string;
  kind: "grid" | "array";
  width: number;
  height: number;
  texCount: number;
}

export interface UniformLayout {
  /** 入力スロット名(time / etime / audio.lo / lag:... など)。slots 配列の先頭から詰める */
  inputs: string[];
  /** リテラルの開始 float オフセット(inputs の直後) */
  literalBase: number;
  literalCount: number;
  /** slots の vec4 数 */
  slotCount: number;
}

export interface CompiledProgram {
  passes: CompiledPass[];
  uniformLayout: UniformLayout;
  literals: { value: number; span: Span }[];
  fade: { value: number; unit: "s" | "beat" } | null;
  sims: SimRuntimeSpec[];
  usesPrev: boolean;
  derivedInputs: { name: string; source: string; kind: "lag"; k: number }[];
  /** `text`(ADR-0032)がラスタライズを要求する文字列。key ごとに重複なし */
  textTextures: { key: string; text: string }[];
  programHash: string;
}

// ---- WGSL ライブラリ(使われた関数だけ含める) ------------------------------------

const LIB: Record<string, { deps?: string[]; src: string }> = {
  fmod: { src: `fn fmod(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }` },
  fmodv2: { src: `fn fmodv2(a: vec2f, b: vec2f) -> vec2f { return a - b * floor(a / b); }` },
  fmodv3: { src: `fn fmodv3(a: vec3f, b: vec3f) -> vec3f { return a - b * floor(a / b); }` },
  hash11: {
    src: `fn hash11(n: f32) -> f32 {
  var x = fract(n * 0.1031 + 0.113);
  x *= x + 33.33; x *= x + x;
  return fract(x);
}`,
  },
  hash21: {
    src: `fn hash21(n: f32) -> vec2f {
  var p3 = fract(vec3f(n * 0.1031, n * 0.1030, n * 0.0973) + 0.19);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}`,
  },
  hash22: {
    src: `fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}`,
  },
  hash12: {
    src: `fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`,
  },
  hash13: {
    src: `fn hash13(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}`,
  },
  noise2d: {
    deps: ["hash12"],
    src: `fn noise2d(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x),
             mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}`,
  },
  noise3d: {
    deps: ["hash13"],
    src: `fn noise3d(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3f(1.0, 0.0, 0.0)), u.x),
        mix(hash13(i + vec3f(0.0, 1.0, 0.0)), hash13(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash13(i + vec3f(0.0, 0.0, 1.0)), hash13(i + vec3f(1.0, 0.0, 1.0)), u.x),
        mix(hash13(i + vec3f(0.0, 1.0, 1.0)), hash13(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}`,
  },
  noise2v: {
    deps: ["noise2d", "noise3d"],
    src: `fn noise2v(p: vec2f) -> vec2f {
  return vec2f(noise2d(p), noise2d(p + vec2f(17.13, 9.57)));
}`,
  },
  fbm2: {
    deps: ["noise2d"],
    src: `fn fbm2(p: vec2f) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 5; i++) {
    v += a * noise2d(q); q = q * 2.03 + vec2f(11.3, 7.9); a *= 0.5;
  }
  return v;
}`,
  },
  fbm3: {
    deps: ["noise3d"],
    src: `fn fbm3(p: vec3f) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 5; i++) {
    v += a * noise3d(q); q = q * 2.03 + vec3f(11.3, 7.9, 5.1); a *= 0.5;
  }
  return v;
}`,
  },
  curl2: {
    deps: ["noise2d"],
    src: `fn curl2(p: vec2f) -> vec2f {
  let e = 0.01;
  let dx = noise2d(p + vec2f(e, 0.0)) - noise2d(p - vec2f(e, 0.0));
  let dy = noise2d(p + vec2f(0.0, e)) - noise2d(p - vec2f(0.0, e));
  return vec2f(dy, -dx) / (2.0 * e);
}`,
  },
  onSphere: {
    src: `fn onSphere(u: vec2f) -> vec3f {
  let z = u.x * 2.0 - 1.0;
  let a = u.y * 6.28318530718;
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(a), r * sin(a), z);
}`,
  },
  rot2: {
    src: `fn rot2(p: vec2f, a: f32) -> vec2f {
  let c = cos(a); let s = sin(a);
  return vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
}`,
  },
  rotX: {
    src: `fn rotX(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(p.x, c * p.y + s * p.z, -s * p.y + c * p.z);
}`,
  },
  rotY: {
    src: `fn rotY(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}`,
  },
  rotZ: {
    src: `fn rotZ(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(c * p.x + s * p.y, -s * p.x + c * p.y, p.z);
}`,
  },
  twistY: {
    src: `fn twistY(p: vec3f, k: f32) -> vec3f {
  let a = p.y * k;
  let c = cos(a); let s = sin(a);
  return vec3f(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}`,
  },
  sdBox2: {
    src: `fn sdBox2(p: vec2f, b: vec2f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}`,
  },
  sdBox3: {
    src: `fn sdBox3(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}`,
  },
  sdTri: {
    src: `fn sdTri(pin: vec2f, r: f32) -> f32 {
  let k = sqrt(3.0);
  var p = vec2f(abs(pin.x) - r, -pin.y + r / k);
  if (p.x + k * p.y > 0.0) { p = vec2f(p.x - k * p.y, -k * p.x - p.y) / 2.0; }
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}`,
  },
  sdSegment2: {
    src: `fn sdSegment2(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}`,
  },
  sdSegment3: {
    src: `fn sdSegment3(p: vec3f, a: vec3f, b: vec3f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}`,
  },
  // 2次ベジエの厳密距離(iq の解析解: 三次方程式を陽に解く)。
  // 数値検証済み(乱数200曲線での境界誤差 < 1e-9)。b=A-2B+C の退化(直線状の
  // 制御点)は 1e-9 の epsilon ガードで NaN を防ぐ(implementation.md の
  // 「壊れても絵になる」方針)
  sdBezier2: {
    src: `fn sdBezier2(pos: vec2f, A: vec2f, B: vec2f, C: vec2f) -> f32 {
  let a = B - A;
  let b = A - 2.0 * B + C;
  let c = a * 2.0;
  let d = A - pos;
  let kk = 1.0 / max(dot(b, b), 1e-9);
  let kx = kk * dot(a, b);
  let ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  let kz = kk * dot(d, a);
  var res = 0.0;
  let p = ky - kx * kx;
  let p3 = p * p * p;
  let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  var h = q * q + 4.0 * p3;
  if (h >= 0.0) {
    h = sqrt(h);
    let x = (vec2f(h, -h) - q) * 0.5;
    let uv = sign(x) * pow(abs(x), vec2f(1.0 / 3.0));
    let t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    let qq = d + (c + b * t) * t;
    res = dot(qq, qq);
  } else {
    let z = sqrt(-p);
    let v = acos(clamp(q / (p * z * 2.0), -1.0, 1.0)) / 3.0;
    let m = cos(v);
    let n = sin(v) * 1.732050808;
    let t = clamp(vec3f(m + m, -n - m, n - m) * z - kx, vec3f(0.0), vec3f(1.0));
    let qx = d + (c + b * t.x) * t.x;
    let qy = d + (c + b * t.y) * t.y;
    let qz = d + (c + b * t.z) * t.z;
    res = min(dot(qx, qx), min(dot(qy, qy), dot(qz, qz)));
  }
  return sqrt(res);
}`,
  },
  // 3D の2次ベジエは3制御点が張る平面に投影し、平面内厳密距離+平面外距離を
  // ピタゴラス合成する(平面曲線への3D距離として厳密)。3点が縮退(ほぼ一直線)
  // していると法線が定まらないため、その場合は sdSegment3(A→C)にフォールバックする
  sdBezier3: {
    deps: ["sdBezier2", "sdSegment3"],
    src: `fn sdBezier3(pos: vec3f, A: vec3f, B: vec3f, C: vec3f) -> f32 {
  var n = cross(B - A, C - A);
  let nlen = length(n);
  if (nlen < 1e-6) {
    return sdSegment3(pos, A, C);
  }
  n = n / nlen;
  var u = B - A;
  u = u - n * dot(u, n);
  let ulen = length(u);
  if (ulen < 1e-6) {
    return sdSegment3(pos, A, C);
  }
  u = u / ulen;
  let v = cross(n, u);
  let relB = B - A;
  let relC = C - A;
  let a2 = vec2f(0.0, 0.0);
  let b2 = vec2f(dot(relB, u), dot(relB, v));
  let c2 = vec2f(dot(relC, u), dot(relC, v));
  let rel = pos - A;
  let p2 = vec2f(dot(rel, u), dot(rel, v));
  let perp = dot(rel, n);
  let d2 = sdBezier2(p2, a2, b2, c2);
  return length(vec2f(d2, perp));
}`,
  },
  smin: {
    src: `fn smin(a: f32, b: f32, k: f32) -> f32 {
  let kk = max(k, 1e-4);
  let h = clamp(0.5 + 0.5 * (b - a) / kk, 0.0, 1.0);
  return mix(b, a, h) - kk * h * (1.0 - h);
}`,
  },
  sminH: {
    src: `fn sminH(a: f32, b: f32, k: f32) -> f32 {
  return clamp(0.5 + 0.5 * (b - a) / max(k, 1e-4), 0.0, 1.0);
}`,
  },
  hsv2rgb: {
    src: `fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(vec3f(c.x, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}`,
  },
  overBlend: {
    src: `fn overBlend(top: vec4f, bot: vec4f) -> vec4f {
  let a = top.w + bot.w * (1.0 - top.w);
  let rgb = top.rgb * top.w + bot.rgb * bot.w * (1.0 - top.w);
  return vec4f(rgb / max(a, 1e-5), a);
}`,
  },
  shadeLambert: {
    src: `fn shadeLambert(base: vec4f, n: vec3f, rd: vec3f, l: vec3f) -> vec4f {
  let ndl = max(dot(n, l), 0.0);
  let diff = base.rgb * (0.18 + 0.82 * ndl);
  let spec = pow(max(dot(reflect(rd, n), l), 0.0), 24.0) * 0.35;
  return vec4f(diff + vec3f(spec), base.w);
}`,
  },
  fogMix: {
    src: `fn fogMix(base: vec4f, fogc: vec4f, k: f32, d: f32) -> vec4f {
  let f = 1.0 - exp(-k * d);
  return vec4f(mix(base.rgb, fogc.rgb, f), base.w);
}`,
  },
  brightPass: {
    src: `fn brightPass(c: vec4f) -> vec4f {
  return vec4f(max(c.rgb - vec3f(0.55), vec3f(0.0)), 0.0);
}`,
  },
  tonemapReinhard: {
    // 輝度ベースのReinhardトーンマッピング(ADR-0020)。HDR(1.0超え)の最終合成
    // 結果を表示用の0..1へ丸める。チャネルごとではなく輝度で1本のスケールを
    // かけるので、明るい部分でも色相・彩度が保たれる
    src: `fn tonemapReinhard(c: vec3f) -> vec3f {
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return c / (1.0 + l);
}`,
  },
  grainNoise: {
    deps: ["hash12"],
    src: `fn grainNoise(p: vec2f, t: f32) -> f32 {
  return hash12(p * 913.7 + vec2f(t * 61.3, t * 12.9)) - 0.5;
}`,
  },
  vignetteFn: {
    src: `fn vignetteFn(c: vec4f, p: vec2f, k: f32) -> vec4f {
  let v = 1.0 - k * smoothstep(0.55, 1.6, length(p));
  return vec4f(c.rgb * v, c.w);
}`,
  },
  worldToUv: {
    src: `fn worldToUv(p: vec2f) -> vec2f {
  let res = UH.xy;
  let aspect = res.x / max(res.y, 1.0);
  var s: vec2f;
  if (aspect >= 1.0) { s = vec2f(aspect, -1.0); } else { s = vec2f(1.0, -1.0 / aspect); }
  return (p / s + 1.0) * 0.5;
}`,
  },
  uvToWorld: {
    src: `fn uvToWorld(uv: vec2f) -> vec2f {
  let res = UH.xy;
  let aspect = res.x / max(res.y, 1.0);
  var s: vec2f;
  if (aspect >= 1.0) { s = vec2f(aspect, -1.0); } else { s = vec2f(1.0, -1.0 / aspect); }
  return (uv * 2.0 - 1.0) * s;
}`,
  },
  gridUv: {
    src: `fn gridUv(p: vec2f) -> vec2f {
  return (vec2f(p.x, -p.y) + 1.0) * 0.5;
}`,
  },
  gridWorld: {
    src: `fn gridWorld(uv: vec2f) -> vec2f {
  let q = uv * 2.0 - 1.0;
  return vec2f(q.x, -q.y);
}`,
  },
  // ワールド座標 → クリップ空間(uvToWorld の逆変換)。line/bezier の instanced
  // strip パス(ADR-0016)の頂点シェーダで、ジオメトリを直接クリップ空間に置くのに使う
  worldToClip: {
    src: `fn worldToClip(p: vec2f) -> vec2f {
  let res = UH.xy;
  let aspect = res.x / max(res.y, 1.0);
  var s: vec2f;
  if (aspect >= 1.0) { s = vec2f(aspect, -1.0); } else { s = vec2f(1.0, -1.0 / aspect); }
  return vec2f(p.x / s.x, -p.y / s.y);
}`,
  },
};

/** WGSL 組み込みとしてそのまま出せる関数名 */
const WGSL_BUILTIN = new Set([
  "sin",
  "cos",
  "tan",
  "abs",
  "floor",
  "ceil",
  "fract",
  "sqrt",
  "pow",
  "exp",
  "log",
  "sign",
  "min",
  "max",
  "clamp",
  "mix",
  "step",
  "smoothstep",
  "length",
  "normalize",
  "dot",
  "cross",
  "reflect",
  "atan2",
]);

function tyName(t: IRType): string {
  switch (t) {
    case "f32":
      return "f32";
    case "bool":
      return "bool";
    case "vec2":
      return "vec2f";
    case "vec3":
      return "vec3f";
    case "vec4":
      return "vec4f";
  }
}

// ---- DAG エミッタ ---------------------------------------------------------------

interface EmitScope {
  lines: string[];
  names: Map<NodeId, string>;
  indent: string;
  loopId: number | null;
  parent: EmitScope | null;
}

class Codegen {
  arena: IRArena;
  layout: UniformLayout;
  inputIndex: Map<string, number>;
  usedLib = new Set<string>();
  usedTex: string[] = [];
  texIndex = new Map<string, number>();
  /** ループ変数依存の判定メモ: `${id}:${loopId}` */
  private depMemo = new Map<string, boolean>();
  lineSpans: (Span | null)[] = [];

  constructor(arena: IRArena, layout: UniformLayout, inputIndex: Map<string, number>) {
    this.arena = arena;
    this.layout = layout;
    this.inputIndex = inputIndex;
  }

  lib(name: string): void {
    if (this.usedLib.has(name)) return;
    this.usedLib.add(name);
    const deps = LIB[name]?.deps ?? [];
    for (const d of deps) this.lib(d);
  }

  texture(key: string): string {
    let idx = this.texIndex.get(key);
    if (idx === undefined) {
      idx = this.usedTex.length;
      this.usedTex.push(key);
      this.texIndex.set(key, idx);
    }
    return `tex${idx}`;
  }

  slotExpr(floatIdx: number): string {
    const v = Math.floor(floatIdx / 4);
    const c = "xyzw"[floatIdx % 4];
    return `US[${v}].${c}`;
  }

  dependsOnLoop(id: NodeId, loopId: number): boolean {
    const key = `${id}:${loopId}`;
    const hit = this.depMemo.get(key);
    if (hit !== undefined) return hit;
    const n = this.arena.get(id);
    let dep = false;
    const ch = childrenOf(n);
    if (n.k === "loopi" || n.k === "loopacc") dep = n.id === loopId;
    else if (n.k === "loop") {
      // 内側ループのノード: init/body が外のループ変数に依存するかだけ見る
      dep = this.dependsOnLoop(n.init, loopId) || this.dependsOnLoop(n.body, loopId);
    } else {
      for (const c of ch) {
        if (this.dependsOnLoop(c, loopId)) {
          dep = true;
          break;
        }
      }
    }
    this.depMemo.set(key, dep);
    return dep;
  }

  /** ノードを適切なスコープに emit して変数名を返す */
  emit(id: NodeId, scope: EmitScope): string {
    // 既に出ているか(自スコープ→祖先の順)
    for (let s: EmitScope | null = scope; s; s = s.parent) {
      const n = s.names.get(id);
      if (n !== undefined) return n;
    }
    // ループ変数に依存しないノードは親スコープへ
    if (scope.loopId !== null && scope.parent && !this.dependsOnLoop(id, scope.loopId)) {
      return this.emit(id, scope.parent);
    }
    const n = this.arena.get(id);
    const name = `n${id}`;
    const expr = this.exprOf(n, id, scope);
    if (n.k === "loopi" || n.k === "loopacc") {
      // 予約名(ループ側で定義済み)
      scope.names.set(id, expr);
      return expr;
    }
    scope.lines.push(`${scope.indent}let ${name}: ${tyName(n.t)} = ${expr};`);
    scope.names.set(id, name);
    return name;
  }

  private exprOf(n: IRNode, id: NodeId, scope: EmitScope): string {
    switch (n.k) {
      case "coord":
        return "P";
      case "input": {
        const idx = this.inputIndex.get(n.name);
        if (idx === undefined) return "0.0";
        return this.slotExpr(idx);
      }
      case "uniform":
        return this.slotExpr(this.layout.literalBase + n.idx);
      case "const":
        return n.t === "bool" ? String(n.v !== 0) : fmtF(n.v);
      case "bin": {
        const a = this.emit(n.a, scope);
        const b = this.emit(n.b, scope);
        if (n.op === "%") {
          // floor-mod(パターン巡回が負の時間でも正しく回るように)
          if (n.t === "f32") {
            this.lib("fmod");
            return `fmod(${a}, ${b})`;
          }
          return `(${a} - ${b} * floor(${a} / ${b}))`;
        }
        return `(${a} ${n.op} ${b})`;
      }
      case "un":
        return n.op === "neg" ? `(-${this.emit(n.a, scope)})` : `(!${this.emit(n.a, scope)})`;
      case "call": {
        const args = n.args.map((a) => this.emit(a, scope));
        if (!WGSL_BUILTIN.has(n.fn)) this.lib(n.fn);
        const fname = n.fn === "atan2" ? "atan2" : n.fn;
        return `${fname}(${args.join(", ")})`;
      }
      case "vec": {
        const parts = n.parts.map((p) => this.emit(p, scope));
        return `${tyName(n.t)}(${parts.join(", ")})`;
      }
      case "swiz":
        return `${this.emit(n.a, scope)}.${n.sel}`;
      case "select": {
        const c = this.emit(n.c, scope);
        const a = this.emit(n.a, scope);
        const b = this.emit(n.b, scope);
        return `select(${b}, ${a}, ${c})`;
      }
      case "sample": {
        const t = this.texture(n.tex);
        const p = this.emit(n.p, scope);
        return `textureSampleLevel(${t}, samp, ${p}, 0.0)`;
      }
      case "fetch": {
        const t = this.texture(n.tex);
        const i = this.emit(n.i, scope);
        return `textureLoad(${t}, vec2i(i32(${i}), 0), 0)`;
      }
      case "rmctx":
        switch (n.which) {
          case "normal":
            return "N";
          case "raydir":
            return "RD";
          case "raydist":
            return "RT";
          case "hitpos":
            return "P";
        }
        break;
      case "loop": {
        // ループはブロックとして展開する。
        // 注意: ループ非依存のノードは本体の中から「親スコープへ巻き上げ」られる
        // (emit() 冒頭のホイスト判定)。この巻き上げは this.emit(n.body, inner) の
        // 実行中に scope.lines へ直接 push されるため、"var acc = ..." / "for (...) {"
        // を先に scope.lines へ積んでしまうと、巻き上げられた行が for ブロックの
        // 内側に紛れ込み、ループの外から参照できない変数になってしまう
        // (WGSL のブロックスコープ違反)。必ず本体を emit し終えてから
        // "var acc"/"for(" を積むこと
        const accName = `acc${n.id}`;
        const iName = `fi${n.id}`;
        const init = this.emit(n.init, scope);
        const inner: EmitScope = {
          lines: [],
          names: new Map(),
          indent: scope.indent + "  ",
          loopId: n.id,
          parent: scope,
        };
        // ループ変数を予約
        inner.lines.push(`${inner.indent}let ${iName}: f32 = f32(li${n.id});`);
        const loopiId = this.arena.node({ k: "loopi", id: n.id, t: "f32" });
        const loopaccId = this.arena.node({ k: "loopacc", id: n.id, t: n.t });
        inner.names.set(loopiId, iName);
        inner.names.set(loopaccId, accName);
        const body = this.emit(n.body, inner);
        inner.lines.push(`${inner.indent}${accName} = ${body};`);
        // ここまでで巻き上げられた行は既に scope.lines に積まれている。
        // ここから "var acc = init;" / "for (...) {" / 本体 / "}" を正しい順で積む
        scope.lines.push(`${scope.indent}var ${accName}: ${tyName(n.t)} = ${init};`);
        scope.lines.push(
          `${scope.indent}for (var li${n.id}: u32 = 0u; li${n.id} < ${n.count}u; li${n.id}++) {`,
        );
        scope.lines.push(...inner.lines);
        scope.lines.push(`${scope.indent}}`);
        return accName;
      }
      case "loopi":
        return `fi${n.id}`;
      case "loopacc":
        return `acc${n.id}`;
      case "ffi": {
        const args = n.args.map((a) => this.emit(a, scope));
        return `${n.name}(${args.join(", ")})`;
      }
    }
    return "0.0";
  }
}

/**
 * ノードの子(NodeId 参照)を rw() で置き換えた「新しいノードの形」を返す
 * (まだ arena.node() でインターンしていない)。子を持たないノード種は n を
 * そのまま返す。
 *
 * childrenOf / rewriteDag / transformLoops はすべてここを経由する。以前は
 * 3箇所に同じ switch(n.k) を独立に書いており、IRNode に新しい種類を追加した
 * ときに更新漏れが起きやすかった(実際にループ生成のバグの遠因にもなった)。
 * 一箇所に統一することで、新しいノード種を足すときの更新箇所を1つに絞る。
 */
function rebuildChildren(n: IRNode, rw: (id: NodeId) => NodeId): IRNode {
  switch (n.k) {
    case "bin":
      return { ...n, a: rw(n.a), b: rw(n.b) };
    case "un":
    case "swiz":
      return { ...n, a: rw(n.a) };
    case "call":
      return { ...n, args: n.args.map(rw) };
    case "vec":
      return { ...n, parts: n.parts.map(rw) };
    case "select":
      return { ...n, c: rw(n.c), a: rw(n.a), b: rw(n.b) };
    case "sample":
      return { ...n, p: rw(n.p) };
    case "fetch":
      return { ...n, i: rw(n.i) };
    case "loop":
      return { ...n, init: rw(n.init), body: rw(n.body) };
    case "ffi":
      return { ...n, args: n.args.map(rw) };
    default:
      return n;
  }
}

function childrenOf(n: IRNode): NodeId[] {
  const ids: NodeId[] = [];
  rebuildChildren(n, (id) => {
    ids.push(id);
    return id;
  });
  return ids;
}

function fmtF(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "1e9" : "-1e9";
  const s = String(v);
  return /[.e]/.test(s) ? s : s + ".0";
}

// ---- ループ不変式の巻き上げ(パーティクル系の最重要最適化) ------------------------------
//
// レイマーチの map() はピクセルあたり数十回呼ばれ、その中の粒子ループ本体で
// 「座標 p に依存しない計算」(粒子位置 = i と time の閉形式)を毎回やり直すと
// コストが N × march段数 倍になる。そこで、ループ本体のうち
// 「ループ索引には依存するが座標には依存しない」極大部分式をフレームに1回の
// DataPass(1D テクスチャ)へ巻き上げ、ループ本体は fetch に置き換える。

interface DataPassIR {
  loopId: number;
  count: number;
  texCount: number;
  roots: NodeId[]; // texCount 本の vec4 ルート(coord.x = 索引)
}

/** DAG の書き換え(replace に載っている id はそのノードへ差し替え) */
function rewriteDag(arena: IRArena, root: NodeId, replace: Map<NodeId, NodeId>): NodeId {
  const memo = new Map<NodeId, NodeId>();
  const rw = (id: NodeId): NodeId => {
    const rep = replace.get(id);
    if (rep !== undefined) return rep;
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const n = arena.get(id);
    const rebuilt = rebuildChildren(n, rw);
    const res = rebuilt === n ? id : arena.node(rebuilt);
    memo.set(id, res);
    return res;
  };
  return rw(root);
}

/** root 中のすべての loop ノードに巻き上げを適用した新しい root を返す */
function transformLoops(arena: IRArena, root: NodeId, out: DataPassIR[]): NodeId {
  const memo = new Map<NodeId, NodeId>();
  const rw = (id: NodeId): NodeId => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const n = arena.get(id);
    let res: NodeId;
    if (n.k === "loop") {
      const init = rw(n.init);
      const body0 = rw(n.body);
      const body = hoistLoopBody(arena, n.id, n.count, body0, out);
      res = arena.node({ ...n, init, body });
    } else {
      const rebuilt = rebuildChildren(n, rw);
      res = rebuilt === n ? id : arena.node(rebuilt);
    }
    memo.set(id, res);
    return res;
  };
  return rw(root);
}

function hoistLoopBody(
  arena: IRArena,
  loopId: number,
  count: number,
  body: NodeId,
  out: DataPassIR[],
): NodeId {
  // 依存解析: 座標(coord/rmctx)・自ループ索引・acc・他ループ変数・演算量
  const coordDep = new Map<NodeId, boolean>();
  const accDep = new Map<NodeId, boolean>();
  const selfI = new Map<NodeId, boolean>();
  const otherVar = new Map<NodeId, boolean>();
  const ops = new Map<NodeId, number>();
  const analyze = (id: NodeId): void => {
    if (coordDep.has(id)) return;
    const n = arena.get(id);
    let cd = false;
    let ad = false;
    let si = false;
    let ov = false;
    let op = 0;
    if (n.k === "coord" || n.k === "rmctx") cd = true;
    else if (n.k === "loopi") {
      if (n.id === loopId) si = true;
      else ov = true;
    } else if (n.k === "loopacc") {
      if (n.id === loopId) ad = true;
      else ov = true;
    } else {
      for (const c of childrenOf(n)) {
        analyze(c);
        cd = cd || coordDep.get(c)!;
        ad = ad || accDep.get(c)!;
        si = si || selfI.get(c)!;
        ov = ov || otherVar.get(c)!;
        op += ops.get(c)!;
      }
      if (n.k === "call" || n.k === "bin" || n.k === "select" || n.k === "ffi" || n.k === "sample" || n.k === "fetch") op += 1;
      if (n.k === "loop") ov = true; // 入れ子ループ跨ぎの巻き上げはしない
    }
    coordDep.set(id, cd);
    accDep.set(id, ad);
    selfI.set(id, si);
    otherVar.set(id, ov);
    ops.set(id, op);
  };
  analyze(body);

  // 極大な巻き上げ候補の収集(演算量 3 以上のものだけ。fetch 1回と等価以下なら据え置き)
  const cands: NodeId[] = [];
  const seen = new Set<NodeId>();
  const visit = (id: NodeId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = arena.get(id);
    const q =
      selfI.get(id)! && !coordDep.get(id)! && !accDep.get(id)! && !otherVar.get(id)! && n.t !== "bool";
    if (q && (ops.get(id) ?? 0) >= 3) {
      if (!cands.includes(id)) cands.push(id);
      return;
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(body);
  if (cands.length === 0) return body;
  cands.sort((a, b) => ops.get(b)! - ops.get(a)!);

  // チャネル割り当て(最大 4 ターゲット = 16 float、vec4 境界を跨がない。ir.ts の
  // padOffset/buildVec4Roots は simulate の状態パッキングと共通。ADR-0017 リファクタ)
  const chosen: { id: NodeId; offset: number; len: number }[] = [];
  let offset = 0;
  for (const id of cands) {
    const len = vecLen(arena.typeOf(id));
    const o = padOffset(offset, len);
    if (o + len > 16) continue;
    chosen.push({ id, offset: o, len });
    offset = o + len;
  }
  if (chosen.length === 0) return body;
  const texCount = Math.ceil(offset / 4);

  // DataPass のルート: loopi を索引(coord.x)に置換して評価
  const coord2 = arena.node({ k: "coord", t: "vec2" });
  const idxNode = arena.node({ k: "swiz", a: coord2, sel: "x", t: "f32" });
  const loopiNode = arena.node({ k: "loopi", id: loopId, t: "f32" });
  const substMap = new Map<NodeId, NodeId>([[loopiNode, idxNode]]);
  const comps: (NodeId | null)[] = new Array(texCount * 4).fill(null);
  for (const c of chosen) {
    const sid = rewriteDag(arena, c.id, substMap);
    if (c.len === 1) comps[c.offset] = sid;
    else {
      for (let k = 0; k < c.len; k++) {
        comps[c.offset + k] = arena.node({ k: "swiz", a: sid, sel: "xyzw"[k], t: "f32" });
      }
    }
  }
  const roots = buildVec4Roots(arena, comps, texCount);
  out.push({ loopId, count, texCount, roots });

  // ループ本体の置換: 候補 → fetch(data テクスチャ, loopi)
  const repl = new Map<NodeId, NodeId>();
  for (const c of chosen) {
    const t = Math.floor(c.offset / 4);
    const inner = c.offset % 4;
    const f = arena.node({ k: "fetch", tex: `data:${loopId}:${t}`, i: loopiNode, t: "vec4" });
    const sel = "xyzw".slice(inner, inner + c.len);
    repl.set(
      c.id,
      c.len === 1
        ? arena.node({ k: "swiz", a: f, sel, t: "f32" })
        : arena.node({ k: "swiz", a: f, sel, t: vecType(c.len) as "vec2" | "vec3" | "vec4" }),
    );
  }
  return rewriteDag(arena, body, repl);
}

/** root 中のループ総反復数(半解像度・march 段数の判定に使う) */
function loopWorkOf(arena: IRArena, root: NodeId): number {
  const seen = new Set<NodeId>();
  let work = 0;
  const go = (id: NodeId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = arena.get(id);
    if (n.k === "loop") work += n.count;
    for (const c of childrenOf(n)) go(c);
  };
  go(root);
  return work;
}

// ---- 入力スロットの収集 -----------------------------------------------------------

function collectInputs(arena: IRArena, roots: NodeId[]): string[] {
  const seen = new Set<NodeId>();
  const names = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = arena.get(id);
    if (n.k === "input") names.add(n.name);
    stack.push(...childrenOf(n));
  }
  return [...names].sort();
}

// ---- パス生成 --------------------------------------------------------------------

const FULLSCREEN_VS = `
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
`;

function uniformDecl(slotCount: number): string {
  const n = Math.max(1, slotCount);
  return `struct Uniforms {
  header: vec4f,
  slots: array<vec4f, ${n}>,
}
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var samp: sampler;
`;
}

function textureDecls(texKeys: string[]): string {
  return texKeys.map((_, i) => `@group(0) @binding(${i + 2}) var tex${i}: texture_2d<f32>;`).join("\n");
}

function assemble(
  cg: Codegen,
  bodyFns: string,
  fsBody: string,
  targets: number,
  ffiSrcs: string[],
  customVertex?: string,
): string {
  // ライブラリ内の UH./US[ は uniform 構造体の別名(置換で解決)
  const libSrc = [...cg.usedLib].map((n) => LIB[n].src).join("\n");
  const outStruct =
    targets === 1
      ? ""
      : `struct FsOut {\n${Array.from({ length: targets }, (_, i) => `  @location(${i}) c${i}: vec4f,`).join("\n")}\n}\n`;
  return [
    uniformDecl(cg.layout.slotCount),
    textureDecls(cg.usedTex),
    libSrc.replaceAll("UH.", "U.header."),
    ffiSrcs.join("\n"),
    bodyFns,
    customVertex ?? FULLSCREEN_VS,
    outStruct,
    fsBody,
  ]
    .join("\n")
    .replaceAll("US[", "U.slots[");
}

export function generateWGSL(staged: StagedProgram): CompiledProgram {
  const arena = staged.arena;

  // ---- ループ不変式の巻き上げ ----
  // 座標に依存しない粒子位置などをフレームに1回の DataPass へ(パーティクル系の要)。
  // dist と colour は同じループ id を含むので、書き換えは全ルートに一括で適用する
  const dataPasses: DataPassIR[] = [];
  const hoisted = new Set<number>();
  const hoist = (root: NodeId): NodeId => {
    const before = dataPasses.length;
    const r = transformLoops(arena, root, dataPasses);
    // 同じループが複数ルートから巻き上げられたら1つに統合
    for (let i = dataPasses.length - 1; i >= before; i--) {
      if (hoisted.has(dataPasses[i].loopId)) dataPasses.splice(i, 1);
      else hoisted.add(dataPasses[i].loopId);
    }
    return r;
  };
  const imageRoot = hoist(staged.imageRoot);
  const raymarches = staged.raymarches.map((r) => ({
    ...r,
    dist: hoist(r.dist),
    colour: hoist(r.colour),
  }));
  const blooms = staged.blooms.map((b) => ({ ...b, extract: hoist(b.extract) }));

  // 全パスのルートを集めて入力スロットを決める(プログラム内で共通のレイアウト)
  const allRoots: NodeId[] = [imageRoot];
  for (const s of staged.sims) allRoots.push(...s.initRoots, ...s.updateRoots);
  for (const r of raymarches) allRoots.push(r.dist, r.colour, r.eye, r.target, r.fov);
  for (const d of dataPasses) allRoots.push(...d.roots);
  for (const sb of staged.stripBatches) allRoots.push(sb.p0IR, sb.p1IR, sb.p2IR, sb.widthIR, sb.colourIR);
  for (const r of raymarches) {
    for (const sb of r.strip3Batches ?? []) allRoots.push(sb.p0IR, sb.p1IR, sb.p2IR, sb.widthIR, sb.colourIR);
  }
  for (const b of blooms) allRoots.push(b.extract);
  const inputs = collectInputs(arena, allRoots);
  const literalCount = arena.uniforms.length;
  const literalBase = inputs.length;
  const slotCount = Math.max(1, Math.ceil((inputs.length + literalCount) / 4));
  const layout: UniformLayout = { inputs, literalBase, literalCount, slotCount };
  const inputIndex = new Map(inputs.map((n, i) => [n, i]));

  const ffiSrcs = staged.ffiFns.map((f) => f.src);
  const passes: CompiledPass[] = [];

  // ---- Simulate パス(init と update の2種) ----
  for (const sim of staged.sims) {
    for (const phase of ["init", "update"] as const) {
      const roots = phase === "init" ? sim.initRoots : sim.updateRoots;
      const cg = new Codegen(arena, layout, inputIndex);
      const scope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
      // 座標: グリッドはワールド座標、配列はインデックス
      const coordId = arena.node({ k: "coord", t: "vec2" });
      scope.names.set(coordId, "P");
      const outs = roots.map((r) => cg.emit(r, scope));
      const targets = sim.handle.texCount;
      const coordSetup =
        sim.handle.kind === "grid"
          ? `  let uv = pos.xy / vec2f(${sim.handle.width}.0, ${sim.handle.height}.0);\n  let P = gridWorld(uv);`
          : `  let P = vec2f(floor(pos.x), 0.0);`;
      if (sim.handle.kind === "grid") cg.lib("gridWorld");
      const retExpr =
        targets === 1
          ? `return ${outs[0]};`
          : `var o: FsOut;\n${outs.map((o, i) => `  o.c${i} = ${o};`).join("\n")}\n  return o;`;
      const fs = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> ${targets === 1 ? "@location(0) vec4f" : "FsOut"} {
${coordSetup}
${scope.lines.join("\n")}
  ${retExpr}
}`;
      const code = assemble(cg, "", fs, targets, ffiSrcs);
      passes.push({
        kind: phase === "init" ? "sim-init" : "sim-update",
        code,
        targets,
        textures: cg.usedTex,
        simName: sim.handle.name,
        hash: fnv1a(sim.handle.sig + ":" + phase + ":" + arena.structuralHash(roots) + ":" + inputs.join(",")),
        lineSpans: [],
      });
    }
  }

  // ---- Data パス(巻き上げたループ不変式。フレームに1回、N テクセル) ----
  for (const dp of dataPasses) {
    const cg = new Codegen(arena, layout, inputIndex);
    const scope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
    const coordId = arena.node({ k: "coord", t: "vec2" });
    scope.names.set(coordId, "P");
    const outs = dp.roots.map((r) => cg.emit(r, scope));
    const retExpr =
      dp.texCount === 1
        ? `return ${outs[0]};`
        : `var o: FsOut;\n${outs.map((o, i) => `  o.c${i} = ${o};`).join("\n")}\n  return o;`;
    const fs = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> ${dp.texCount === 1 ? "@location(0) vec4f" : "FsOut"} {
  let P = vec2f(floor(pos.x), 0.0);
${scope.lines.join("\n")}
  ${retExpr}
}`;
    const code = assemble(cg, "", fs, dp.texCount, ffiSrcs);
    passes.push({
      kind: "data",
      code,
      targets: dp.texCount,
      textures: cg.usedTex,
      dataKey: `data:${dp.loopId}`,
      dataCount: dp.count,
      hash: fnv1a("data:" + arena.structuralHash(dp.roots) + ":" + inputs.join(",")),
      lineSpans: [],
    });
  }

  // ---- Raymarch パス ----
  for (const rm of raymarches) {
    const cg = new Codegen(arena, layout, inputIndex);
    // dist 関数
    const distScope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
    const coord3 = arena.node({ k: "coord", t: "vec3" });
    distScope.names.set(coord3, "P");
    const distOut = cg.emit(rm.dist, distScope);
    const mapFn = `fn rmMap(P: vec3f) -> f32 {\n${distScope.lines.join("\n")}\n  return ${distOut};\n}`;
    // colour 関数(rmctx: N/RD/RT)
    const colScope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
    colScope.names.set(coord3, "P");
    const colOut = cg.emit(rm.colour, colScope);
    const colFn = `fn rmCol(P: vec3f, N: vec3f, RD: vec3f, RT: f32) -> vec4f {\n${colScope.lines.join("\n")}\n  return ${colOut};\n}`;
    // カメラ式
    const camScope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
    const eye = cg.emit(rm.eye, camScope);
    const target = cg.emit(rm.target, camScope);
    const fov = cg.emit(rm.fov, camScope);

    const bodyFns = `${mapFn}
${colFn}
fn rmNormal(p: vec3f) -> vec3f {
  let e = vec2f(1.0, -1.0) * 0.0015;
  return normalize(
    e.xyy * rmMap(p + e.xyy) + e.yyx * rmMap(p + e.yyx) +
    e.yxy * rmMap(p + e.yxy) + e.xxx * rmMap(p + e.xxx));
}`;
    // ループ重量級(粒子など)は march 段数を減らし、半解像度で描く。
    // fetch 化済みでも N 回ループ × 96 段は重い — 「壊れても絵になる」方向に倒す
    const work = loopWorkOf(arena, rm.dist);
    const heavy = work >= 128;
    const steps = heavy ? 48 : 96;
    const fs = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = U.header.xy${heavy ? " * 0.5" : ""};
  let ndc = vec2f((pos.x / res.x) * 2.0 - 1.0, 1.0 - (pos.y / res.y) * 2.0);
  let aspect = res.x / max(res.y, 1.0);
${camScope.lines.join("\n")}
  let ro = ${eye};
  let ta = ${target};
  let fw = normalize(ta - ro);
  let ri = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(ri, fw);
  let th = tan(${fov} * 0.5);
  let rd = normalize(fw + ri * ndc.x * th * aspect + up * ndc.y * th);
  var t = 0.0;
  var hit = false;
  for (var i = 0; i < ${steps}; i++) {
    let d = rmMap(ro + rd * t);
    if (d < max(0.001, 0.0015 * t)) { hit = true; break; }
    t += d * 0.8; // Lipschitz 安全係数(implementation.md 4.1)
    if (t > 60.0) { break; }
  }
  if (!hit) { return vec4f(0.0); }
  let hp = ro + rd * t;
  let n = rmNormal(hp);
  return rmCol(hp, n, rd, t);
}`;
    const code = assemble(cg, bodyFns, fs, 1, ffiSrcs);
    passes.push({
      kind: "raymarch",
      code,
      targets: 1,
      textures: cg.usedTex,
      rmId: rm.id,
      halfRes: heavy,
      hash: fnv1a("rm:" + arena.structuralHash([rm.dist, rm.colour, rm.eye, rm.target, rm.fov]) + ":" + inputs.join(",")),
      lineSpans: [],
    });

    // ---- Sprite パス(scatter の instanced 描画。ADR-0014) ----
    // CSG ループの代わりに「フレームに1回、N テクセルの位置/色データパス」+
    // 「N インスタンスのビルボード描画」で粒子を出す。dist は既に定数 +∞ に
    // すり替え済みなので、レイマーチの合成には一切参加しない
    for (const batch of rm.spriteBatches ?? []) {
      const dataKey = `sprite:${batch.loopId}`;
      {
        const cg2 = new Codegen(arena, layout, inputIndex);
        const scope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
        const coord2 = arena.node({ k: "coord", t: "vec2" });
        scope.names.set(coord2, "P");
        // loopi(batch.loopId) をこのデータパスの索引(P.x)に置換してから emit する
        const idxNode = arena.node({ k: "swiz", a: coord2, sel: "x", t: "f32" });
        const loopiNode = arena.node({ k: "loopi", id: batch.loopId, t: "f32" });
        const substMap = new Map<NodeId, NodeId>([[loopiNode, idxNode]]);
        const posRoot = rewriteDag(arena, batch.centerRadiusIR, substMap);
        const colRoot = rewriteDag(arena, batch.colourIR, substMap);
        const posOut = cg2.emit(posRoot, scope);
        const colOut = cg2.emit(colRoot, scope);
        const fs2 = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> FsOut {
  let P = vec2f(floor(pos.x), 0.0);
${scope.lines.join("\n")}
  var o: FsOut;
  o.c0 = ${posOut};
  o.c1 = ${colOut};
  return o;
}`;
        const code2 = assemble(cg2, "", fs2, 2, ffiSrcs);
        passes.push({
          kind: "data",
          code: code2,
          targets: 2,
          textures: cg2.usedTex,
          dataKey,
          dataCount: batch.count,
          hash: fnv1a("sprite-data:" + arena.structuralHash([batch.centerRadiusIR, batch.colourIR]) + ":" + inputs.join(",")),
          lineSpans: [],
        });
      }
      {
        const cg3 = new Codegen(arena, layout, inputIndex);
        const posTex = cg3.texture(`${dataKey}:0`);
        const colTex = cg3.texture(`${dataKey}:1`);
        const camScope3: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
        const eye3 = cg3.emit(rm.eye, camScope3);
        const target3 = cg3.emit(rm.target, camScope3);
        const fov3 = cg3.emit(rm.fov, camScope3);
        const vs = `struct SpriteVOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec4f,
}
@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpriteVOut {
  let pr = textureLoad(${posTex}, vec2i(i32(ii), 0), 0);
  let col = textureLoad(${colTex}, vec2i(i32(ii), 0), 0);
  let center = pr.xyz;
  let radius = pr.w;
${camScope3.lines.join("\n")}
  let ro = ${eye3};
  let ta = ${target3};
  let fw = normalize(ta - ro);
  let ri = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(ri, fw);
  let th = tan(${fov3} * 0.5);
  let res = U.header.xy;
  let aspect = res.x / max(res.y, 1.0);
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let corner = corners[vi];
  let worldPos = center + ri * corner.x * radius + up * corner.y * radius;
  let rel = worldPos - ro;
  let vfwd = dot(rel, fw);
  let vright = dot(rel, ri);
  let vup = dot(rel, up);
  var out: SpriteVOut;
  if (vfwd <= 0.001) {
    out.pos = vec4f(2.0, 2.0, 2.0, 1.0); // カメラ背後は画角外に押し出す(depth test なしの簡易カリング)
  } else {
    let ndc = vec2f(vright / (vfwd * th * aspect), vup / (vfwd * th));
    out.pos = vec4f(ndc, 0.5, 1.0);
  }
  out.uv = corner;
  out.col = col;
  return out;
}`;
        const fs3 = `@fragment
fn fs_main(in: SpriteVOut) -> @location(0) vec4f {
  let d = length(in.uv);
  if (d > 1.0) { discard; }
  let a = smoothstep(1.0, 0.55, d) * in.col.w;
  // alpha も加算する: image パス側で最終的に rgb*a するため(implementation.md の
  // 出力規約=rgb は非乗算、a=0 で不可視)、alpha 側も蓄積しないと粒子が見えなくなる
  return vec4f(in.col.rgb * a, a);
}`;
        const code3 = assemble(cg3, "", fs3, 1, ffiSrcs, vs);
        passes.push({
          kind: "sprite",
          code: code3,
          targets: 1,
          textures: cg3.usedTex,
          spriteRmId: rm.id,
          spriteCount: batch.count,
          hash: fnv1a("sprite:" + batch.loopId + ":" + arena.structuralHash([rm.eye, rm.target, rm.fov]) + ":" + inputs.join(",")),
          lineSpans: [],
        });
      }
    }

    // ---- Strip3D パス(3D line/bezier の instanced 描画。ADR-0036) ----
    // sprite(ADR-0014)と同じく、march 不要・深度テストなし・レイマーチ結果に
    // 重ね描き。カメラ向きのリボン(進行方向と視線方向の外積で幅方向を決める)を
    // 1ベジエ STRIP3D_SEGMENTS 個の直線に分割して近似する(2D strip と同じ手法)
    const STRIP3D_SEGMENTS = 16;
    for (const batch of rm.strip3Batches ?? []) {
      const dataKey = `strip3:${batch.loopId}`;
      {
        // データパス: tex0=vec4(p0,width), tex1=vec4(p1,0), tex2=vec4(p2,0), tex3=colour
        const cg2 = new Codegen(arena, layout, inputIndex);
        const scope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
        const coord2 = arena.node({ k: "coord", t: "vec2" });
        scope.names.set(coord2, "P");
        const idxNode = arena.node({ k: "swiz", a: coord2, sel: "x", t: "f32" });
        const loopiNode = arena.node({ k: "loopi", id: batch.loopId, t: "f32" });
        const substMap = new Map<NodeId, NodeId>([[loopiNode, idxNode]]);
        const p0 = rewriteDag(arena, batch.p0IR, substMap);
        const p1 = rewriteDag(arena, batch.p1IR, substMap);
        const p2 = rewriteDag(arena, batch.p2IR, substMap);
        const width = rewriteDag(arena, batch.widthIR, substMap);
        const colour = rewriteDag(arena, batch.colourIR, substMap);
        const zero = arena.node({ k: "const", v: 0, t: "f32" });
        const tex0 = arena.node({ k: "vec", parts: [p0, width], t: "vec4" });
        const tex1 = arena.node({ k: "vec", parts: [p1, zero], t: "vec4" });
        const tex2 = arena.node({ k: "vec", parts: [p2, zero], t: "vec4" });
        const out0 = cg2.emit(tex0, scope);
        const out1 = cg2.emit(tex1, scope);
        const out2 = cg2.emit(tex2, scope);
        const out3 = cg2.emit(colour, scope);
        const fs2 = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> FsOut {
  let P = vec2f(floor(pos.x), 0.0);
${scope.lines.join("\n")}
  var o: FsOut;
  o.c0 = ${out0};
  o.c1 = ${out1};
  o.c2 = ${out2};
  o.c3 = ${out3};
  return o;
}`;
        const code2 = assemble(cg2, "", fs2, 4, ffiSrcs);
        passes.push({
          kind: "data",
          code: code2,
          targets: 4,
          textures: cg2.usedTex,
          dataKey,
          dataCount: batch.count,
          hash: fnv1a(
            "strip3-data:" + arena.structuralHash([batch.p0IR, batch.p1IR, batch.p2IR, batch.widthIR, batch.colourIR]) + ":" + inputs.join(","),
          ),
          lineSpans: [],
        });
      }
      {
        const cg3 = new Codegen(arena, layout, inputIndex);
        const tex0 = cg3.texture(`${dataKey}:0`);
        const tex1 = cg3.texture(`${dataKey}:1`);
        const tex2 = cg3.texture(`${dataKey}:2`);
        const tex3 = cg3.texture(`${dataKey}:3`);
        const camScope4: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
        const eye4 = cg3.emit(rm.eye, camScope4);
        const target4 = cg3.emit(rm.target, camScope4);
        const fov4 = cg3.emit(rm.fov, camScope4);
        const segs = STRIP3D_SEGMENTS;
        const vs = `struct Strip3VOut {
  @builtin(position) pos: vec4f,
  @location(0) cross_: f32,
  @location(1) col: vec4f,
}
@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Strip3VOut {
  let t0 = textureLoad(${tex0}, vec2i(i32(ii), 0), 0);
  let t1 = textureLoad(${tex1}, vec2i(i32(ii), 0), 0);
  let t2 = textureLoad(${tex2}, vec2i(i32(ii), 0), 0);
  let col = textureLoad(${tex3}, vec2i(i32(ii), 0), 0);
  let p0 = t0.xyz;
  let width = t0.w;
  let p1 = t1.xyz;
  let p2 = t2.xyz;
  let seg = i32(vi) / 2;
  let side = f32(i32(vi) % 2) * 2.0 - 1.0; // -1 or 1
  let t = f32(seg) / f32(${segs});
  let u = 1.0 - t;
  // 2次ベジエの点と接線(line は p1=中点の退化ベジエ)
  let point = u * u * p0 + 2.0 * u * t * p1 + t * t * p2;
  var tangent = 2.0 * u * (p1 - p0) + 2.0 * t * (p2 - p1);
  if (dot(tangent, tangent) < 1e-12) { tangent = p2 - p0; }
  tangent = normalize(tangent);
${camScope4.lines.join("\n")}
  let ro = ${eye4};
  let ta = ${target4};
  let fw = normalize(ta - ro);
  let ri = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(ri, fw);
  let th = tan(${fov4} * 0.5);
  let res = U.header.xy;
  let aspect = res.x / max(res.y, 1.0);
  // カメラ向きのリボン: 幅方向 = 接線 × 視線方向(退化(接線とほぼ平行な視線)は
  // カメラの right ベクトルにフォールバックする)
  let viewDir = normalize(point - ro);
  var right = cross(tangent, viewDir);
  if (dot(right, right) < 1e-12) { right = ri; }
  right = normalize(right);
  let halfw = max(width, 0.0005);
  let worldPos = point + right * side * halfw;
  let rel = worldPos - ro;
  let vfwd = dot(rel, fw);
  let vright = dot(rel, ri);
  let vup = dot(rel, up);
  var out: Strip3VOut;
  if (vfwd <= 0.001) {
    out.pos = vec4f(2.0, 2.0, 2.0, 1.0); // カメラ背後は画角外に押し出す(depth test なしの簡易カリング、sprite と同じ)
  } else {
    let ndc = vec2f(vright / (vfwd * th * aspect), vup / (vfwd * th));
    out.pos = vec4f(ndc, 0.5, 1.0);
  }
  out.cross_ = side;
  out.col = col;
  return out;
}`;
        const fs3 = `@fragment
fn fs_main(in: Strip3VOut) -> @location(0) vec4f {
  let cov = smoothstep(1.0, 0.7, abs(in.cross_)) * in.col.w;
  return vec4f(in.col.rgb * cov, cov);
}`;
        const code3 = assemble(cg3, "", fs3, 1, ffiSrcs, vs);
        passes.push({
          kind: "strip3d",
          code: code3,
          targets: 1,
          textures: cg3.usedTex,
          strip3RmId: rm.id,
          strip3Count: batch.count,
          strip3VertexCount: 2 * (segs + 1),
          hash: fnv1a("strip3:" + batch.loopId + ":" + segs + ":" + arena.structuralHash([rm.eye, rm.target, rm.fov]) + ":" + inputs.join(",")),
          lineSpans: [],
        });
      }
    }
  }

  // ---- Bloom パス連鎖(ダウンサンプル+ブラー、ADR-0019・ADR-0020・ADR-0025) ----
  // 各 bloom() 呼び出しにつき native(フル解像度、ユーザーの式に依存) →
  // e(1/2、native からの固定ボックスフィルタ)→ down1..downN(1/4, 1/8, ...、
  // 同じ固定ボックスフィルタで段階的に縮小) → upN-1..up0(小さい方を
  // bilinearアップサンプル+同解像度のスキップ接続を加算しながら段階的に
  // 拡大、up0=FINALを image パスがサンプルする)という連鎖にする。
  // native → e の1段を追加したのは ADR-0025: 以前は e をユーザーの式から
  // 直接「半解像度」で評価していたため、シーン側のアンチエイリアス
  // (smoothstep の px)が前提とするネイティブ解像度と、実際のサンプリング
  // 密度がずれ、規則的な繰り返し構造(例: grid の上の小さな box)がモアレを
  // 起こしていた。ユーザーの式はネイティブ解像度で一度だけ評価し、そこから
  // 先は全て検証済みのボックスフィルタでのダウンサンプルに統一する
  // 段数(bloom() 呼び出しごとの b.levels)を増やすほど実効ブラー半径が
  // 広がる。以前は全呼び出し共通の固定6段だったが、シーンのスケールに対して
  // 段数が合わないと(例: 密なグリッドの上に大きな固定半径)、bloomの一番粗い
  // ミップの解像度がシーンの繰り返し構造と一致してモアレ状に見える問題があった。
  // `bloom k x` の `k`(静的に決まる場合)から適応的に決める(ADR-0024。
  // k が大きい=強く光らせたいほど段数を増やす)。段数を増やしても各段は解像度が
  // 下がっていくので計算コストの増分は小さい。ダウンサンプル/アップサンプル
  // 自体はユーザーコードに依存しない固定 shader なので Codegen の IR emit を
  // 経由しない
  for (const b of blooms) {
    const BLOOM_LEVELS = b.levels;
    const nativeKey = `bloom:${b.id}:n`;
    const eKey = `bloom:${b.id}:e`;
    const downKey = (i: number) => `bloom:${b.id}:d${i}`;
    const upKey = (i: number) => (i === 0 ? `bloom:${b.id}:u0` : `bloom:${b.id}:u${i}`);

    // native: フル解像度、ユーザーの式(brightPass 済み)を評価。
    // 以前はここを直接「半解像度」で評価していたが、シーン側のアンチエイリアス
    // (smoothstep の px)はネイティブ解像度を前提に設計されている。半解像度の
    // 規則的な格子で直接点サンプリングすると、格子状に並んだ小さなハイライト
    // (例: grid の上の小さな box)がその格子と干渉してモアレになる問題が
    // あった。ここをネイティブ解像度で評価すれば、この後は below の
    // downsample()(実績のある2x2ボックスフィルタ)だけで畳み込めるので、
    // 新たなエイリアシングを持ち込まずに済む
    {
      const cg = new Codegen(arena, layout, inputIndex);
      cg.lib("uvToWorld");
      const scope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
      const coordId = arena.node({ k: "coord", t: "vec2" });
      scope.names.set(coordId, "P");
      const out = cg.emit(b.extract, scope);
      const fs = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = max(vec2f(1.0), U.header.xy);
  let P = uvToWorld(pos.xy / res);
${scope.lines.join("\n")}
  return ${out};
}`;
      const code = assemble(cg, "", fs, 1, ffiSrcs);
      passes.push({
        kind: "bloom-extract",
        code,
        targets: 1,
        textures: cg.usedTex,
        bloomId: b.id,
        bloomOutKey: nativeKey,
        bloomResDivisor: 1,
        hash: fnv1a("bloom-n:" + b.id + ":" + arena.structuralHash([b.extract]) + ":" + inputs.join(",")),
        lineSpans: [],
      });
    }

    // downsample: 固定のボックスフィルタ(4タップ)。src は自分の2倍の解像度
    const downsample = (srcKey: string, dstKey: string, dstDivisor: number): void => {
      const cg = new Codegen(arena, layout, inputIndex);
      cg.usedTex = [srcKey];
      const fs = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = max(vec2f(1.0), floor(U.header.xy / ${dstDivisor}.0));
  let uv = pos.xy / res;
  // dst の1テクセルは src の2x2テクセルに対応する。src の隣接テクセル中心へ
  // 届くにはdstテクセル幅の1/4ぶんだけずらせばよい(1/2ずらすと隣のブロックの
  // テクセルに飛んでしまい、非対称な滲みの原因になっていた)
  let texel = 0.25 / res;
  let c0 = textureSampleLevel(tex0, samp, uv + vec2f(-texel.x, -texel.y), 0.0);
  let c1 = textureSampleLevel(tex0, samp, uv + vec2f( texel.x, -texel.y), 0.0);
  let c2 = textureSampleLevel(tex0, samp, uv + vec2f(-texel.x,  texel.y), 0.0);
  let c3 = textureSampleLevel(tex0, samp, uv + vec2f( texel.x,  texel.y), 0.0);
  return (c0 + c1 + c2 + c3) * 0.25;
}`;
      const code = assemble(cg, "", fs, 1, []);
      passes.push({
        kind: "bloom-down",
        code,
        targets: 1,
        textures: cg.usedTex,
        bloomId: b.id,
        bloomOutKey: dstKey,
        bloomResDivisor: dstDivisor,
        hash: fnv1a("bloom-d:" + b.id + ":" + srcKey + ":" + dstKey),
        lineSpans: [],
      });
    };
    // ダウンサンプル連鎖: native(1/1) → e(1/2) → d1(1/4) → d2(1/8) → ... → dN(1/2^(N+1))
    downsample(nativeKey, eKey, 2);
    for (let i = 1; i <= BLOOM_LEVELS; i++) {
      const srcKey = i === 1 ? eKey : downKey(i - 1);
      downsample(srcKey, downKey(i), 2 ** (i + 1));
    }

    // upsample+add: 小さい方(tex0)を9タップのテントフィルタでアップサンプルし、
    // 同解像度のスキップ接続(tex1)を加算する。単純な1タップ(bilinearのみ)だと
    // 箱型ダウンサンプルの非等方性がそのまま残り、グローの形が丸ではなく
    // 角ばった/歪んだ形に見える問題があった(実機で確認)。Call of Duty の
    // "next-gen post processing" 講演で示された標準的な3x3テント(重み
    // 1-2-1/2-4-2/1-2-1)に倣い、等方的な(丸い)にじみになるようにする
    const upsample = (smallKey: string, skipKey: string, dstKey: string, dstDivisor: number): void => {
      const cg = new Codegen(arena, layout, inputIndex);
      cg.usedTex = [smallKey, skipKey];
      const fs = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = max(vec2f(1.0), floor(U.header.xy / ${dstDivisor}.0));
  let uv = pos.xy / res;
  let o = 2.0 / res;
  let s00 = textureSampleLevel(tex0, samp, uv, 0.0);
  let s10 = textureSampleLevel(tex0, samp, uv + vec2f(o.x, 0.0), 0.0);
  let sn10 = textureSampleLevel(tex0, samp, uv + vec2f(-o.x, 0.0), 0.0);
  let s01 = textureSampleLevel(tex0, samp, uv + vec2f(0.0, o.y), 0.0);
  let s0n1 = textureSampleLevel(tex0, samp, uv + vec2f(0.0, -o.y), 0.0);
  let s11 = textureSampleLevel(tex0, samp, uv + vec2f(o.x, o.y), 0.0);
  let s1n1 = textureSampleLevel(tex0, samp, uv + vec2f(o.x, -o.y), 0.0);
  let sn11 = textureSampleLevel(tex0, samp, uv + vec2f(-o.x, o.y), 0.0);
  let sn1n1 = textureSampleLevel(tex0, samp, uv + vec2f(-o.x, -o.y), 0.0);
  let up = (s00 * 4.0 + (s10 + sn10 + s01 + s0n1) * 2.0 + (s11 + s1n1 + sn11 + sn1n1)) / 16.0;
  let skip = textureSampleLevel(tex1, samp, uv, 0.0);
  return up + skip;
}`;
      const code = assemble(cg, "", fs, 1, []);
      passes.push({
        kind: "bloom-up",
        code,
        targets: 1,
        textures: cg.usedTex,
        bloomId: b.id,
        bloomOutKey: dstKey,
        bloomResDivisor: dstDivisor,
        hash: fnv1a("bloom-u:" + b.id + ":" + smallKey + ":" + skipKey + ":" + dstKey),
        lineSpans: [],
      });
    };
    // アップサンプル連鎖: dN とその1つ上のスキップ接続から始めて、e とのスキップ接続で
    // 終わる(u0 = FINAL、image パスがサンプルする)
    for (let i = BLOOM_LEVELS - 1; i >= 0; i--) {
      const smallKey = i === BLOOM_LEVELS - 1 ? downKey(BLOOM_LEVELS) : upKey(i + 1);
      const skipKey = i === 0 ? eKey : downKey(i);
      upsample(smallKey, skipKey, upKey(i), 2 ** (i + 1));
    }
  }

  // ---- Image パス(最終 2D) ----
  {
    const cg = new Codegen(arena, layout, inputIndex);
    cg.lib("uvToWorld");
    cg.lib("tonemapReinhard");
    const scope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
    const coordId = arena.node({ k: "coord", t: "vec2" });
    scope.names.set(coordId, "P");
    const out = cg.emit(imageRoot, scope);
    const fs = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = U.header.xy;
  let P = uvToWorld(pos.xy / res);
${scope.lines.join("\n")}
  let c = ${out};
  let mapped = tonemapReinhard(c.rgb);
  return vec4f(mapped * c.a, c.a);
}`;
    const code = assemble(cg, "", fs, 1, ffiSrcs);
    passes.push({
      kind: "image",
      code,
      targets: 1,
      textures: cg.usedTex,
      hash: fnv1a("img:" + arena.structuralHash([imageRoot]) + ":" + inputs.join(",")),
      lineSpans: [],
    });
  }

  // ---- Strip パス(line/bezier の instanced 描画。ADR-0016) ----
  // march 不要: パスに沿って幅方向へ押し出した三角形ストリップを直接ラスタライズし、
  // 最終画像(colorTex)に上描きする。1ベジエを SEGMENTS 個の直線に分割して近似する
  const STRIP_SEGMENTS = 16;
  for (const batch of staged.stripBatches) {
    const dataKey = `strip:${batch.loopId}`;
    {
      // データパス: tex0=vec4(p0,p2), tex1=vec4(p1,width), tex2=colour
      const cg2 = new Codegen(arena, layout, inputIndex);
      const scope: EmitScope = { lines: [], names: new Map(), indent: "  ", loopId: null, parent: null };
      const coord2 = arena.node({ k: "coord", t: "vec2" });
      scope.names.set(coord2, "P");
      const idxNode = arena.node({ k: "swiz", a: coord2, sel: "x", t: "f32" });
      const loopiNode = arena.node({ k: "loopi", id: batch.loopId, t: "f32" });
      const substMap = new Map<NodeId, NodeId>([[loopiNode, idxNode]]);
      const p0 = rewriteDag(arena, batch.p0IR, substMap);
      const p1 = rewriteDag(arena, batch.p1IR, substMap);
      const p2 = rewriteDag(arena, batch.p2IR, substMap);
      const width = rewriteDag(arena, batch.widthIR, substMap);
      const colour = rewriteDag(arena, batch.colourIR, substMap);
      const tex0 = arena.node({ k: "vec", parts: [p0, p2], t: "vec4" });
      const tex1 = arena.node({ k: "vec", parts: [p1, width, arena.node({ k: "const", v: 0, t: "f32" })], t: "vec4" });
      const out0 = cg2.emit(tex0, scope);
      const out1 = cg2.emit(tex1, scope);
      const out2 = cg2.emit(colour, scope);
      const fs2 = `@fragment
fn fs_main(@builtin(position) pos: vec4f) -> FsOut {
  let P = vec2f(floor(pos.x), 0.0);
${scope.lines.join("\n")}
  var o: FsOut;
  o.c0 = ${out0};
  o.c1 = ${out1};
  o.c2 = ${out2};
  return o;
}`;
      const code2 = assemble(cg2, "", fs2, 3, ffiSrcs);
      passes.push({
        kind: "data",
        code: code2,
        targets: 3,
        textures: cg2.usedTex,
        dataKey,
        dataCount: batch.count,
        hash: fnv1a("strip-data:" + arena.structuralHash([batch.p0IR, batch.p1IR, batch.p2IR, batch.widthIR, batch.colourIR]) + ":" + inputs.join(",")),
        lineSpans: [],
      });
    }
    {
      const cg3 = new Codegen(arena, layout, inputIndex);
      cg3.lib("worldToClip");
      const tex0 = cg3.texture(`${dataKey}:0`);
      const tex1 = cg3.texture(`${dataKey}:1`);
      const tex2 = cg3.texture(`${dataKey}:2`);
      const segs = STRIP_SEGMENTS;
      const vs = `struct StripVOut {
  @builtin(position) pos: vec4f,
  @location(0) cross_: f32,
  @location(1) col: vec4f,
}
@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> StripVOut {
  let pp = textureLoad(${tex0}, vec2i(i32(ii), 0), 0);
  let pw = textureLoad(${tex1}, vec2i(i32(ii), 0), 0);
  let col = textureLoad(${tex2}, vec2i(i32(ii), 0), 0);
  let p0 = pp.xy;
  let p2 = pp.zw;
  let p1 = pw.xy;
  let width = pw.z;
  let seg = i32(vi) / 2;
  let side = f32(i32(vi) % 2) * 2.0 - 1.0; // -1 or 1
  let t = f32(seg) / f32(${segs});
  let u = 1.0 - t;
  // 2次ベジエの点と接線(line は p1=中点の退化ベジエ)
  let point = u * u * p0 + 2.0 * u * t * p1 + t * t * p2;
  var tangent = 2.0 * u * (p1 - p0) + 2.0 * t * (p2 - p1);
  if (dot(tangent, tangent) < 1e-12) { tangent = p2 - p0; }
  tangent = normalize(tangent);
  let normal = vec2f(-tangent.y, tangent.x);
  let halfw = max(width, 0.0005);
  let worldPos = point + normal * side * halfw;
  var out: StripVOut;
  out.pos = vec4f(worldToClip(worldPos), 0.0, 1.0);
  out.cross_ = side;
  out.col = col;
  return out;
}`;
      const fs3 = `@fragment
fn fs_main(in: StripVOut) -> @location(0) vec4f {
  let cov = smoothstep(1.0, 0.7, abs(in.cross_)) * in.col.w;
  return vec4f(in.col.rgb * cov, cov);
}`;
      const code3 = assemble(cg3, "", fs3, 1, ffiSrcs, vs);
      passes.push({
        kind: "strip",
        code: code3,
        targets: 1,
        textures: cg3.usedTex,
        stripCount: batch.count,
        stripVertexCount: 2 * (segs + 1),
        hash: fnv1a("strip:" + batch.loopId + ":" + segs + ":" + inputs.join(",")),
        lineSpans: [],
      });
    }
  }

  // パイプラインの誤共有を防ぐため、uniform スロット数とテクスチャ構成もハッシュに含める
  // (シェーダ本文の array<vec4f, N> とバインディング数がキャッシュキーに効く)
  for (const p of passes) {
    p.hash = fnv1a(`${p.hash}:${slotCount}:${p.textures.join(",")}`);
  }
  const programHash = fnv1a(passes.map((p) => p.hash).join("|") + "|prev:" + staged.usesPrev);

  return {
    passes,
    uniformLayout: layout,
    literals: arena.uniforms.map((u) => ({ value: u.value, span: u.span })),
    fade: staged.fade,
    sims: staged.sims.map((s) => ({
      name: s.handle.name,
      sig: s.handle.sig,
      kind: s.handle.kind,
      width: s.handle.width,
      height: s.handle.height,
      texCount: s.handle.texCount,
    })),
    usesPrev: staged.usesPrev,
    derivedInputs: staged.derivedInputs,
    textTextures: dedupeTextTextures(staged.textTextures),
    programHash,
  };
}

/** key(文字列内容のハッシュ)で重複を除く。同じ文字列を複数箇所で使っても1つだけ */
function dedupeTextTextures(specs: { key: string; text: string }[]): { key: string; text: string }[] {
  const seen = new Map<string, { key: string; text: string }>();
  for (const s of specs) if (!seen.has(s.key)) seen.set(s.key, s);
  return [...seen.values()];
}
