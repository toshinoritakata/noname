// dream-code.md の12例(エディタのサンプル集)。
// 原文の意図を保ちつつ、未定義だった補助(initPV / cam / sunlight)を補い、
// パーティクル simulate に要素数を明示するなど最小限の適合を施している。

export interface Example {
  name: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    name: "1. 脈打つ円",
    source: `out (circle (0.3 + 0.1 * sin time) |> fill white) <> 0.5s`,
  },
  {
    name: "2. グリッドパターン",
    source: `pat = grid [8, 8] \\i ->
        box 0.3
        |> rot (time * 0.2 + hash i * tau)
        |> fill (hsv (hash i * 0.2 + 0.6) 0.6 1)

out pat`,
  },
  {
    name: "3. レイマーチ風景",
    source: `height p = fbm (p * 0.4) * 2.0

scene = heightfield height
      |> shade (sun [0.5, 1.0, 0.3])
      |> fog 0.05 skyblue

cam = orbit 8 (time * 0.05)

out (render cam scene
     |> chromatic 0.004
     |> grain 0.03
     |> vignette 0.4)`,
  },
  {
    name: "4. メタボール",
    source: `balls = range 6
      |> map \\i ->
           sphere 0.4
           |> move [ sin (time + i * 2.1) * 1.5
                   , cos (time * 1.3 + i) * 1.0
                   , sin (time * 0.7 + i * 4.0) ]
      |> blendAll 0.7

out (render (orbit 5 0) (balls |> shade (sun [1,1,1])))`,
  },
  {
    name: "5. トレイル",
    source: `dot = circle 0.05
    |> move [sin time, cos (time * 1.7)]
    |> fill white

out (dot <over> (prev |> fade 0.97 |> zoom 1.002))`,
  },
  {
    name: "6. リアクション・ディフュージョン",
    source: `rd = simulate (noise2 |> scale 4) \\s ->
       let a   = s.x
           b   = s.y
           lap = laplacian s
       in [ a + (0.21 * lap.x - a*b*b + 0.055 * (1 - a)) * dt
          , b + (0.11 * lap.y + a*b*b - 0.062 * b)       * dt ]

out (rd.y |> ramp [black, teal, white])`,
  },
  {
    name: "7. オーディオリアクティブ",
    source: `bass = audio.low  |> lag 0.15
high = audio.high |> lag 0.05

blob = sphere (0.8 + bass * 0.6)
     |> distort (fbm3 * high * 0.4)
     |> shade (sun [1, 2, 1])

out (render (orbit 4 (time * 0.1)) blob
     |> bloom (0.3 + bass))`,
  },
  {
    name: "8. 時間パターン",
    source: `shape = cycle 2s [circle 0.4, box 0.35, tri 0.45] |> morph 0.3

out (shape
     |> rot (time * 0.3)
     |> outline 0.01
     |> fill coral
     <over> bg midnight)`,
  },
  {
    name: "9. ドメインワープ",
    source: `ink = stripes 12 |> rot 0.7

out (ink
     |> warp (\\p -> p + curl (p * 2 + time * 0.1) * 0.3)
     |> warp (\\p -> p + curl (p * 5) * 0.08)
     |> ramp [ivory, indigo])`,
  },
  {
    name: "10. ステートレス・パーティクル",
    source: `sparks = scatter 300 \\i ->
           let born = hash i * 8
               age  = wrap (time - born) 8
               dir  = onSphere (hash2 i)
               pos  = dir * age * 0.4 + gravity * age * age * 0.05
           in point 0.015
              |> move pos
              |> glow (1 - age / 8)

out (render (orbit 6 (time * 0.02)) sparks
     <over> (prev |> fade 0.9))`,
  },
  {
    name: "11. 外来シェーダ (FFI)",
    source: `myFbm = wgsl (Field Float) """
  fn f(p: vec2f, t: f32) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var q = p;
    for (var i = 0; i < 4; i++) {
      v += a * sin(q.x * 3.1 + t) * sin(q.y * 2.7 - t * 0.7);
      q = q * 2.1;
      a *= 0.5;
    }
    return v;
  }
"""

rock = sphere 1
     |> distort (myFbm |> scale 3)
     |> twist 0.2
     |> shade (sun [1, 1, 0.5])

out (render (orbit 3 (time * 0.1)) rock)`,
  },
  {
    name: "12. 跳ねるパーティクル",
    source: `world = sphere 1 <+> plane.y (-1)

initPV i = { pos: onSphere (hash2 i) * 2.0 + [0, 2, 0]
           , vel: onSphere (hash2 (i + 99)) * 0.5 }

parts = simulate 1024 initPV \\s ->
          let vel = s.vel + gravity * dt
              pos = s.pos + vel * dt
          in if dist world pos < 0.02
             then { pos: s.pos, vel: reflect vel (grad world pos) * 0.8 }
             else { pos: pos, vel: vel }

out (render (orbit 6 (time * 0.1))
     (world |> shade sunlight
      <+> scatter 256 \\i -> point 0.04 |> move ((parts i).pos) |> glow 0.8))`,
  },
  {
    name: "13. 六角柱の床 (FFI)",
    source: `hexHeight = wgsl (Field Float) """
  fn f(p: vec2f, t: f32) -> f32 {
    // 正六角格子の最近傍セル中心を axial 座標 → 立方体座標の丸め込みで求める
    // (redblobgames の cube-round アルゴリズム)
    let r: f32 = 0.22;
    let q = (0.5773503 * p.x - 0.3333333 * p.y) / r;
    let s = (0.6666667 * p.y) / r;
    let cx = q;
    let cz = s;
    let cy = -cx - cz;
    var rx = round(cx);
    var ry = round(cy);
    var rz = round(cz);
    let dx = abs(rx - cx);
    let dy = abs(ry - cy);
    let dz = abs(rz - cz);
    if (dx > dy && dx > dz) {
      rx = -ry - rz;
    } else if (dy > dz) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }
    let centerX = r * 1.7320508 * (rx + rz * 0.5);
    let centerY = r * 1.5 * rz;

    // セル中心からの局所座標に、3方向のスラブ交差で六角形 SDF を立てる
    let qx = p.x - centerX;
    let qy = p.y - centerY;
    let apo = r * 0.8660254;
    let d0 = abs(qx);
    let d1 = abs(qx * 0.5 + qy * 0.8660254);
    let d2 = abs(-qx * 0.5 + qy * 0.8660254);
    let d = max(d0, max(d1, d2)) - apo;

    // 境界(グラウトライン)だけ凹ませ、タイル中央は平ら
    let margin: f32 = 0.03;
    let top: f32 = 0.09;
    let tt = clamp((d + margin) / margin, 0.0, 1.0);
    let sm = tt * tt * (3.0 - 2.0 * tt);
    return top * (1.0 - sm);
  }
"""

floor = heightfield hexHeight
      |> shade (sun [0.4, 1.0, 0.5])
      |> fog 0.08 skyblue

out (render (camera [0, 1.3, 2.0] [0, 0, 0]) floor |> vignette 0.3)`,
  },
  {
    name: "14. 弦の模様 (line/bezier)",
    source: `strands = scatter 200 \\i ->
  let a0 = hash i * 6.283185
      a1 = hash (i + 500) * 6.283185
      r0 = 0.3 + hash (i + 1000) * 0.6
      r1 = 0.3 + hash (i + 1500) * 0.6
      p0 = [cos a0, sin a0] * r0
      p1 = [cos a1, sin a1] * r1
      mid = (p0 + p1) * 0.5 + [cos (time * 0.3 + i), sin (time * 0.3 + i)] * 0.15
  in bezier p0 mid p1
     |> outline 0.0035
     |> fill (hsv (hash (i + 2000)) 0.6 1)

out strands`,
  },
  {
    name: "15. グロウ (bloom)",
    source: `balls = range 5
  |> map \\i ->
       sphere 0.22
       |> move [ cos (i * 1.256 + time * 0.6) * 1.2
               , sin (i * 1.256 + time * 0.6) * 1.2
               , 0 ]
       |> fill (hsv (i * 0.2) 0.75 1.0)
       |> glow 0.8
  |> blendAll 0.3

out (render (orbit 4 0) (balls |> shade (sun [1,1,1]))
     |> bloom 1.2)`,
  },
  {
    name: "16. TVノイズ (entropy)",
    source: `seed = entropy * 10000

pat = grid [40, 24] \\i ->
        box 0.45
        |> fill (hsv 0 0 (hash (i + seed)))

out pat`,
  },
  {
    name: "17. OSCフェーダー (osc.f)",
    source: `-- bridge/(ADR-0029)を起動し、TouchOSC等から /1/fader0 等を送ると
-- 半径・色相・グロウが操作できる(未接続時は osc.f が全て0なので
-- 時間だけで動く見た目になる)
r = 0.25 + 0.1 * sin time + osc.f 0 * 0.3
hue = 0.55 + osc.f 1 * 0.4

out (circle r
     |> fill (hsv hue 0.7 1)
     |> glow (0.3 + osc.f 2 * 1.2))`,
  },
  {
    name: "18. Webカメラ万華鏡 (webcam)",
    source: `-- カメラ許可が必要(ADR-0030)。実カメラの代わりに Chrome の
-- --use-fake-device-for-media-stream でも確認できる
out (webcam
     |> mirror
     |> zoom 1.3
     |> chromatic 0.04
     |> vignette 0.35)`,
  },
];
