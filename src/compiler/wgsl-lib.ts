// WGSL 組み込み関数ライブラリ(候補2: wgsl.ts から抽出した純データ)。
// generateWGSL の Codegen.lib() が使用済みの名前だけを usedLib に集め、
// assemble() が LIB[n].src を連結する。deps は依存する他の LIB エントリ名。

export const LIB: Record<string, { deps?: string[]; src: string }> = {
  fmod: { src: `fn fmod(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }` },
  fmodv2: { src: `fn fmodv2(a: vec2f, b: vec2f) -> vec2f { return a - b * floor(a / b); }` },
  fmodv3: { src: `fn fmodv3(a: vec3f, b: vec3f) -> vec3f { return a - b * floor(a / b); }` },
  // 整数ビット列に対する MurmurHash3 の fmix32(既知の高品質アバランシュ関数)。
  // 入力を10進小数の演算(*0.1031 等)に通す旧実装は f32 の有効桁(約7桁)を
  // 超える大きさの入力(scatter の N が数万規模、time が長時間経過後など)で
  // 小数部の情報が失われ、ユニークな出力数が数千〜1万強で頭打ちになる欠陥が
  // あった(実測: N=100,000 でユニーク数12,025止まり)。IEEE754 のビット列を
  // そのまま bitcast して混ぜる本実装は、入力の大きさに関係なく異なる浮動小数点
  // 値なら異なるビット列を持つことを利用するため、この頭打ちが起きない
  hashMix: {
    src: `fn hashMix(seed: u32) -> u32 {
  var v = seed;
  v = v ^ (v >> 16u);
  v = v * 0x7feb352du;
  v = v ^ (v >> 15u);
  v = v * 0x846ca68bu;
  v = v ^ (v >> 16u);
  return v;
}`,
  },
  hash11: {
    deps: ["hashMix"],
    src: `fn hash11(n: f32) -> f32 {
  return f32(hashMix(bitcast<u32>(n))) * (1.0 / 4294967296.0);
}`,
  },
  hash21: {
    deps: ["hashMix"],
    src: `fn hash21(n: f32) -> vec2f {
  let h0 = hashMix(bitcast<u32>(n));
  let h1 = hashMix(h0 ^ 0x68bc21ebu);
  return vec2f(f32(h0), f32(h1)) * (1.0 / 4294967296.0);
}`,
  },
  hash22: {
    deps: ["hashMix"],
    src: `fn hash22(p: vec2f) -> vec2f {
  let hx = hashMix(bitcast<u32>(p.x));
  let hy = hashMix(bitcast<u32>(p.y) ^ 0x9e3779b9u);
  let h0 = hashMix(hx ^ hy);
  let h1 = hashMix(h0 ^ 0x68bc21ebu);
  return vec2f(f32(h0), f32(h1)) * (1.0 / 4294967296.0);
}`,
  },
  hash12: {
    deps: ["hashMix"],
    src: `fn hash12(p: vec2f) -> f32 {
  let hx = hashMix(bitcast<u32>(p.x));
  let hy = hashMix(bitcast<u32>(p.y) ^ 0x9e3779b9u);
  return f32(hashMix(hx ^ hy)) * (1.0 / 4294967296.0);
}`,
  },
  hash13: {
    deps: ["hashMix"],
    src: `fn hash13(p: vec3f) -> f32 {
  let hx = hashMix(bitcast<u32>(p.x));
  let hy = hashMix(bitcast<u32>(p.y) ^ 0x9e3779b9u);
  let hz = hashMix(bitcast<u32>(p.z) ^ 0x85ebca6bu);
  return f32(hashMix(hx ^ hy ^ hz)) * (1.0 / 4294967296.0);
}`,
  },
  hash33: {
    deps: ["hashMix"],
    src: `fn hash33(p: vec3f) -> vec3f {
  let hx = hashMix(bitcast<u32>(p.x));
  let hy = hashMix(bitcast<u32>(p.y) ^ 0x9e3779b9u);
  let hz = hashMix(bitcast<u32>(p.z) ^ 0x85ebca6bu);
  let h0 = hashMix(hx ^ hy ^ hz);
  let h1 = hashMix(h0 ^ 0x68bc21ebu);
  let h2 = hashMix(h1 ^ 0xb5297a4du);
  return vec3f(f32(h0), f32(h1), f32(h2)) * (1.0 / 4294967296.0);
}`,
  },
  // ボロノイ/セルラーノイズ(F1: 最近傍のジッタ格子点までの距離)。近傍 3x3(2D)/
  // 3x3x3(3D)を総当たりする定数境界ループなので、動的な N のループ機構
  // (ir.ts の loop ノード)ではなく素の WGSL for でよい
  voronoi2: {
    deps: ["hash22"],
    src: `fn voronoi2(p: vec2f, s: f32) -> f32 {
  let q = p / max(s, 1e-6);
  let i = floor(q);
  let f = fract(q);
  var minD = 8.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let g = vec2f(f32(x), f32(y));
      let o = hash22(i + g);
      let r = g + o - f;
      minD = min(minD, length(r));
    }
  }
  return clamp(minD, 0.0, 1.0);
}`,
  },
  voronoi3: {
    deps: ["hash33"],
    src: `fn voronoi3(p: vec3f, s: f32) -> f32 {
  let q = p / max(s, 1e-6);
  let i = floor(q);
  let f = fract(q);
  var minD = 8.0;
  for (var z = -1; z <= 1; z = z + 1) {
    for (var y = -1; y <= 1; y = y + 1) {
      for (var x = -1; x <= 1; x = x + 1) {
        let g = vec3f(f32(x), f32(y), f32(z));
        let o = hash33(i + g);
        let r = g + o - f;
        minD = min(minD, length(r));
      }
    }
  }
  return clamp(minD, 0.0, 1.0);
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
  // top は premultiplied(scene テクスチャの中身 = strip パスが rgb*cov, cov で出したもの)、
  // bot は straight alpha(背景場)。premultiplied-over で合成し straight alpha で返す。
  // 2Dストリップを bloom 前の scene テクスチャへ焼き込み、場からサンプルするために使う(ADR-0044)
  overPremul: {
    src: `fn overPremul(top: vec4f, bot: vec4f) -> vec4f {
  let a = top.w + bot.w * (1.0 - top.w);
  let rgb = top.rgb + bot.rgb * bot.w * (1.0 - top.w);
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
