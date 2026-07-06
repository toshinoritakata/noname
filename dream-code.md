# 夢のコード集 — creative coding 言語設計スケッチ

実装より先に「この言語で書きたい作品」を書き、必要なプリミティブと合成子を逆算する。

前提となる意味論:

> 作品 = `(空間座標, 時間) → 色` の純粋関数。言語はその関数を合成する代数。
> 状態は「前フレーム参照(feedback)」と「シミュレーション(simulate)」の2段階でのみ導入する。

改訂 2026-07-04: 先行研究調査(prior-art.md)を反映。
Shape を `{dist, colour}` レコードに変更(Curv 継承、図形と色の結婚問題を解決)、
`<>` クロスフェード宣言と `etime`(評価ローカル時計)を導入(Punctual 継承)。

シンタックスは仮。`|>` はパイプ、`\p -> ...` はラムダ、`--` はコメント。

---

## 1. 脈打つ円 — 最小のプログラム

```
out (circle (0.3 + 0.1 * sin time) |> fill white) <> 0.5s
```

**逆算されること**
- `time` はグローバルに流れる環境値。宣言不要
- 引数に `sin time` を渡すだけでアニメーションになる = すべての値が暗黙にシグナル(時間の関数)
- `out` が唯一の出力点。1行で動くこと(ライブコーディングの最初の一手の速さ)
- `<> 0.5s` : **再評価時の遷移宣言**(Punctual 由来)。コードを書き換えて評価すると、
  旧プログラムと新プログラムの出力を 0.5 秒クロスフェードする。省略時は即時切替。
  純粋関数だから新旧を同時評価してブレンドできる — このパラダイムの見せ場

---

## 2. グリッドパターン — 反復と個体差

```
pat = grid [8, 8] \i ->
        box 0.3
        |> rot (time * 0.2 + hash i * tau)
        |> fill (hsv (hash i * 0.2 + 0.6) 0.6 1)

out pat
```

**逆算されること**
- 反復はただの `repeat`(全セル同一)では足りない。**セル索引を受け取る高階形式** `grid dims \i -> shape` が必要
- `hash` : 決定的な擬似乱数。シード付きで純粋(ライブ書き換え時に再現される)
- 彩色はラムダの内側で完結する。これが成立するのは **Shape が距離と色を両方持つレコード
  だから**(Curv 継承、→ 総括参照)。`fill` は Shape の colour フィールドを差し替える操作で、
  彩色済みの Shape 同士もそのまま `grid` や `<+>` で合成できる

---

## 3. レイマーチ風景 — 3D・カメラ・ポスト処理

```
height p = fbm (p * 0.4) * 2.0

scene = heightfield height
      |> shade (sun [0.5, 1.0, 0.3])
      |> fog 0.05 skyblue

cam = orbit 8 (time * 0.05)

out (render cam scene
     |> chromatic 0.004
     |> grain 0.03
     |> vignette 0.4)
```

**逆算されること**
- 3D シーン(SDF)→ `render cam` → 2D 画像、というパイプラインの段差が言語に現れる。
  `render` の出力は例1の `fill` の出力と同じ型(2D の色場)なので、ポスト処理は 2D 用合成子がそのまま使える
- カメラは値。`orbit` のようなプリセットと、自前の位置/注視点指定の両方が要る
- `fbm` / `noise` は空間場のプリミティブとして一級市民

---

## 4. メタボール — コレクションと滑らか合成

```
balls = range 6
      |> map \i ->
           sphere 0.4
           |> move [ sin (time + i * 2.1) * 1.5
                   , cos (time * 1.3 + i) * 1.0
                   , sin (time * 0.7 + i * 4.0) ]
      |> blendAll 0.7          -- smooth union で畳み込み

out (render (orbit 5 0) (balls |> shade (sun [1,1,1])))
```

**逆算されること**
- `map` / `range` などのコレクション操作。ただしこれは GPU 上ではループ展開かループそのものにコンパイルされる → 要素数は静的に決まると楽(動的だと難度が上がる)
- 二項の smooth union `<+>` と、その畳み込み `blendAll k` の両方が欲しい

---

## 5. トレイル — feedback 第1段階

```
dot = circle 0.05
    |> move [sin time, cos (time * 1.7)]
    |> fill white

out (dot <over> (prev |> fade 0.97 |> zoom 1.002))
```

**逆算されること**
- `prev` : 前フレームの出力画像を 2D 色場として参照する。状態導入の最小形
- `<over>` : 画像のレイヤ合成演算子(アルファ合成)。左辺が Shape なら自動で Image に
  持ち上げる(図形の外側は透明)ので、`dot <over> prev...` がそのまま書ける
- `fade` / `zoom` を `prev` に噛ませるだけでトレイル・無限ズームの定番表現が出る。
  **feedback は「画像→画像の後処理パイプに前フレームを流し込むだけ」で成立する** — この軽さが大事

---

## 6. リアクション・ディフュージョン — simulate 第2段階

```
rd = simulate (noise2 |> scale 4) \s ->
       let a   = s.x
           b   = s.y
           lap = laplacian s
       in [ a + (0.21 * lap.x - a*b*b + 0.055 * (1 - a)) * dt
          , b + (0.11 * lap.y + a*b*b - 0.062 * b)       * dt ]

out (rd.y |> ramp [black, teal, white])
```

**逆算されること**
- `prev`(自分の出力の参照)では書けない表現がある。**任意チャネルの場を、初期値+更新則で進化させる `simulate`** が第2段階の状態
- `laplacian` = 近傍サンプリング。純粋関数の世界に「場を少しずらして評価する」操作が必要(実装上はテクスチャの隣接フェッチ)
- `dt` はランタイム供給。更新則も純粋関数なので、ライブ書き換え時は**場の中身を保ったまま更新則だけ差し替え**られる — これがこの言語のライブ性の見せ場
- GPU 実装はピンポンバッファに素直に対応する

---

## 7. オーディオリアクティブ — 外部シグナル

```
bass = audio.low  |> lag 0.15      -- lag: 平滑化(急峻な値を滑らかに追従)
high = audio.high |> lag 0.05

blob = sphere (0.8 + bass * 0.6)
     |> distort (fbm3 * high * 0.4)
     |> shade (sun [1, 2, 1])

out (render (orbit 4 (time * 0.1)) blob
     |> bloom (0.3 + bass))
```

**逆算されること**
- `audio.low / mid / high / fft[i]` : 外部入力もただのシグナル(時間の関数)として同じ型系に乗る。マウス・MIDI・OSC も同様に `mouse.x`, `midi.cc 1` で入るべき
- `lag` : 生の入力は跳ねるので、シグナル用の平滑化・包絡合成子(`lag`, `smooth`, `trigger`)は標準装備が必須

---

## 8. 時間パターン — Tidal 的リズムと SDF モーフ

```
shape = cycle 2s [circle 0.4, box 0.35, tri 0.45] |> morph 0.3

out (shape
     |> rot (time * 0.3)
     |> outline 0.01
     |> fill coral
     <over> bg midnight)       -- bg : Color -> Image(全面一色の背景)
```

**逆算されること**
- `cycle dur [...]` : 値の列を時間で巡回するパターン。`every`, `stagger` など Tidal 系合成子の入口
- **`morph` が SDF パラダイムのご褒美**: 距離場は線形補間するだけで形状が滑らかにモーフする。
  「図形の列を時間パターンで切り替え、境界をモーフでつなぐ」が3語で書ける。
  Shape が `{dist, colour}` レコードなので、`morph` は**距離と色の同時補間**として定義できる
  (彩色済みの図形同士も滑らかにモーフする)
- `2s` : 時間リテラル。BPM 同期(`1beat`)も欲しくなるはず

---

## 9. ドメインワープ — 空間を歪める高階操作

```
ink = stripes 12 |> rot 0.7

out (ink
     |> warp (\p -> p + curl (p * 2 + time * 0.1) * 0.3)
     |> warp (\p -> p + curl (p * 5) * 0.08)
     |> ramp [ivory, indigo])
```

**逆算されること**
- `warp f` = 「場 g を f との合成 g∘f に変える」。**空間そのものを値として編集する**のがこのパラダイムの核で、`move`/`rot`/`repeat` も実は全部 `warp` の特殊形
- `curl`(カールノイズ)などベクトル場プリミティブ
- 多段 `warp` の重ね掛けが定番イディオムになる予感 → パイプで自然に書けている

---

## 10. ステートレス・パーティクル — 軌道を閉形式で書く

```
sparks = scatter 3000 \i ->
           let born = hash i * 8
               age  = wrap (time - born) 8          -- 0..8 を巡回
               dir  = onSphere (hash2 i)             -- シードから射出方向
               pos  = dir * age * 0.4 + gravity age
           in point 0.015
              |> move pos
              |> glow (1 - age / 8)

out (render (orbit 6 (time * 0.02)) sparks
     <over> (prev |> fade 0.9))
```

**逆算されること**
- パーティクルに状態は要らない: **軌道が (シード, 経過時間) の閉形式で書けるなら純粋関数のまま数千個出せる**(GPU インスタンシングに直結)
- `scatter n \i -> shape` は例2の `grid` と同族 — 「n 個の個体を索引付きで生成する高階形式」として統一できそう
- 正直な限界: 衝突・相互作用・力場積分が要るパーティクルは閉形式では書けない → その時は例6の `simulate`(位置場をバッファで進化)に引っ越す。**「閉形式で書ける美しさ」と「simulate の万能さ」の2層構造**は言語の思想として明示すべき

---

## 11. 外来シェーダの取り込み — FFI

```
-- 式レベル: 型注釈付き WGSL ブロック。外から見れば普通の Field
myFbm = wgsl (Field Float) """
  fn f(p: vec2f, t: f32) -> f32 {
    // 手書きの最適化済みノイズ
  }
"""

rock = sphere 1
     |> distort (myFbm |> scale 3)     -- ネイティブの場と完全に同格
     |> twist 0.2                       -- 合成子も全部効く

-- 画像レベル: Shadertoy 互換インポート。型は Image
sky = shadertoy """
  // Shadertoy からコピペしたコード(iTime, iResolution 参照)
"""

out (render (orbit 5 0) rock <over> (sky |> zoom 1.5))
```

**逆算されること**
- **この言語の FFI は境界コストゼロ**: 全体が WGSL に落ちるので、外来スニペットは
  生成シェーダへの継ぎ足しにすぎない。マーシャリング不要、インライン化で呼び出しコストも消える
- **型注釈が翻訳規約を決める**: `Field Float` = `(vec2f, f32) -> f32`、
  `Point -> Point` = ワープ関数、`Shape` = dist/colour の関数ペア。
  型ごとに機械的な対応があるので、外来値にも `warp`/`twist`/`blendAll` が全部効く
  (座標加工は関数の外側で起きるため、中身が手書きでも成立する)
- 二段構え: `wgsl` ブロックが一級市民、`glsl`/`shadertoy` ブロックは naga の
  GLSL フロントエンド経由の互換層。`iTime`/`iResolution`/`iMouse` はシムで供給
  → **Shadertoy の作品群がコピペで素材になる**(採用障壁を下げる一手)
- 代償: 型注釈の正しさは信用ベース(ただしシグネチャ不一致はシェーダコンパイル時に
  必ず検出される)。Lipschitz 規律は検査不能 → 外来ブロックの責任範囲と明記する
- ホットスワップとの相性は問題なし: 外来ブロックも一緒に再コンパイルされるだけで、
  `<>` クロスフェードもそのまま効く

---

## 12. 跳ねるパーティクル — SDF 衝突つき物理

```
world = sphere 1 <+> plane.y (-1)      -- 描画用のシーンが…

parts = simulate initPV \s ->
          let vel' = s.vel + gravity * dt
              pos' = s.pos + vel' * dt
          in if dist world pos' < 0.02
             then { pos: s.pos, vel: reflect vel' (grad world pos') * 0.8 }
             else { pos: pos', vel: vel' }

out (render cam (world |> shade sunlight
     <+> scatter 4096 \i -> point 0.01 |> move (parts i).pos))
```

**逆算されること**
- **SDF シーンがそのまま衝突ジオメトリになる**(このパラダイムのご褒美その2)。
  `dist world p` で貫通判定、`grad world p` で反射法線がタダで手に入る。
  ポリゴンエンジンなら衝突メッシュを別に用意する話が、表現の統一で消滅する
- 描画用の `world` と物理用の `world` が**同じ値** — コードを書き換えれば絵と物理が同時に変わる
- `simulate` の状態はレコード(`{pos, vel}`)も持てる必要がある(実体は複数チャネルのテクスチャ)
- `reflect` / `grad` / `gravity` が物理系の標準語彙に入る
- ライブとの相性: シミュレーションを走らせたまま重力や反発係数を書き換えられる
  (状態保持スワップ+uniform 昇格の合わせ技)
- **正直な境界**: これは gather 型(近傍と自分を読んで自分を書く)の物理。
  scatter・ソート・アトミックが要る手法(大規模 SPH、拘束ソルバつき剛体)は
  現設計の範囲外(→ ADR-0003 の3段の切り分け)

---

## 13. 六角柱の床 — 敷き詰めパターンと FFI の組み合わせ(実装確認済み)

他の12本と違い、これは「書きたいコードから逆算した設計スケッチ」ではなく、
**実装後にこの言語で実際に書いて動かした**確認例(2026-07-05)。「FFI が本当に
境界コストゼロで、ネイティブの合成子と対等に混ざるか」を検証する目的で書いた。

```
hexHeight = wgsl (Field Float) """
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
    let d = max(d0, max(d1, d2)) - apo;   // 常に <= 0(セル内なので)、境界でちょうど 0

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

out (render (camera [0, 1.3, 2.0] [0, 0, 0]) floor |> vignette 0.3)
```

**確認されたこと**
- **六角形プリミティブが無くても表現できる**。言語には `circle`/`box`/`sphere` はあっても
  `hexagon` は無い。`heightfield`(既存の高さ場→3D SDF 変換)と `wgsl` FFI(例11)を
  組み合わせるだけで、任意の敷き詰めパターンをカバーできる ——
  「プリミティブを増やす」のではなく「FFI で任意の場を作り、ネイティブの合成子
  (`heightfield`/`shade`/`fog`/`render`/`vignette`)にそのまま繋ぐ」という設計の勝ち筋
- **FFI 境界の内と外がシームレスに混ざる**ことを実地で確認: 六角格子の最近傍セル
  判定という「合成子の組み合わせでは書きにくい」部分だけを FFI に閉じ込め、
  カメラ・シェーディング・フォグ・ポスト処理は全部ネイティブのまま
  (ADR-0011 で謳っていた「境界コストゼロ」が絵に出た)
- **診断の実地手順が確立した**: FFI の数式が壊れているとき、レイマーチ・カメラ・
  照明を全部すっ飛ばして `out (hexHeight |> ramp [black, white])` と書けば、
  高さ場そのものを 2D グレースケール画像として直接見られる。
  実装時、六角形 SDF の写し間違いと `smoothstep` の遷移方向の取り違えという
  2つのバグをこの方法で素早く特定できた —— **FFI ブロックは中身をコンパイラが
  検査できない代わりに、`|> ramp [...]` で即座に可視化できることがデバッグの生命線**
  になる、という設計上の教訓

---

# 総括 — 12本から逆算された言語像

## 型の骨格(全部が関数に潰れる)

```
Field a = Point -> a            -- 空間場(noise は Field Float, curl は Field Vec)
Shape  = { dist   : Field Dist  -- SDF。2D/3D は Point の次元差だけ
         , colour : Field Color }   -- 距離と色は最初から同居(Curv 継承)
Image  = Point2 -> Color        -- 色場。flatten / render の出力、prev の型
Signal a = Time -> a            -- 時間シグナル。ただし time は暗黙に流れるので
                                --  ユーザーは Signal をほぼ意識しない
```

- 時間はすべての場の**暗黙の第4座標**(Curv の dist(x,y,z,t) と同型)。時間変換
  (`slow`, `loop`, `rewind`)は空間変換と同じ「座標の再マップ」として実装できる
- `fill : Color -> Shape -> Shape` — colour フィールドの差し替え。Shape は彩色後も Shape
  なので、合成(`<+>`/`grid`/`morph`)がどの段階でも効く
- `render : Cam -> Shape3 -> Image`、2D は `flatten : Shape2 -> Image`(背景と合成して画像化)
- `warp : (Point -> Point) -> Field a -> Field a` — dist と colour に一様に効く

**合成子はすべて関数合成の別名**であり、だから全体が WGSL に落ちる。
GPU コンパイルは Curv の SubCurv 方式(部分評価 → インライン展開 → 静的サブセット →
シェーダ生成)が実証済みの先例。我々は最初から静的型+推論なので、この経路はさらに素直になる。

## 合成子の族(= 標準ライブラリの章立て)

| 族 | 例 | 出どころ |
|---|---|---|
| 形状プリミティブ | `circle box sphere tri plane heightfield point line bezier` | 1,3,4,10 |
| 空間操作(warp 族) | `move rot scale repeat grid mirror twist distort warp` | 2,7,9 |
| 形状合成 | `<+> blendAll cut inter morph outline` | 4,8 |
| 彩色・光 | `fill hsv ramp shade sun glow fog` | 1,3,6,10 |
| 画像合成・ポスト | `<over> fade zoom bloom chromatic grain vignette` | 3,5,7 |
| 場プリミティブ | `noise fbm curl stripes hash` | 2,3,9 |
| 時間 | `cycle every lag smooth wrap slow loop 2s 1beat` | 7,8,10 |
| 時計 | `time`(グローバル)/ `etime`(評価時点起点、Punctual 継承) | 1,10 |
| ライブ遷移 | `<> dur`(再評価時クロスフェード、Punctual 継承) | 1 |
| 個体生成(高階) | `grid scatter range/map` | 2,4,10 |
| 状態(2段) | `prev` / `simulate laplacian dt` | 5,6,12 |
| 物理 | `dist grad reflect gravity`(SDF 衝突) | 12 |
| 外来コード | `wgsl (型) """..."""` / `glsl` / `shadertoy` | 11 |
| 入出力 | `out render orbit audio.* mouse midi` | 3,7 |

## 書いてみて得られた発見

1. **SDF モーフ(例8)と多段 warp(例9)が「この言語でしか気持ちよく書けない」候補筆頭。** パラダイムの看板にできる
2. **状態の2層構造が確定した。** `prev`(画像フィードバック、超軽量)と `simulate`(任意場の進化、万能)。ライブ書き換え時は「場の中身を保持して規則だけ差し替え」が共通の意味論になる
3. **個体差付き反復(`grid`/`scatter`)は高階関数が必須。** つまりラムダは初日から言語に要る。ただし GPU に落とすため、クロージャは「コンパイル時に展開できる純粋関数」に制限してよい
4. **要素数・グリッド数は静的でよい**(ライブコーディングではコードを書き換えれば済む)。これで GPU コンパイルが大幅に単純化する
5. **「全体が WGSL に落ちる」設計は FFI をほぼ無料にする**(例11)。型注釈付き外来ブロックは生成シェーダへの継ぎ足しで済み、Shadertoy 互換層まで視野に入る。エコシステムを持たない新言語が既存資産を吸える、戦略的に重要な性質
6. **SDF シーンがそのまま衝突ジオメトリになる**(例12)。`dist`/`grad` が描画にも物理にも同じ値として効き、衝突メッシュという概念が消滅する。SDF 統一の第2のご褒美(第1はモーフ)

## 解決済みの設計課題(先行研究調査による)

- **図形と色の結婚問題(例2)** → Curv 方式で解決。Shape = `{dist, colour}` レコードにし、
  `fill` は colour の差し替え、`morph` は両フィールドの同時補間。個体生成ラムダの中で
  彩色まで済ませても、その後の形状合成が全部生きる
- **マルチチャネル意味論** → Punctual の組合せ展開(`[1,2]+[10,20]` が4チャネルに膨らむ)は
  採らない。バリエーション生成は明示的な `grid`/`scatter`/`map` に限定する
- **ホットスワップの遷移** → `<> dur` で宣言(Punctual 先例)。純粋関数なので新旧プログラムの
  同時評価+ブレンドで実装できる

## 未解決の設計課題

- **`out` の暗黙化**: 最後の式を自動で `out` するか。ライブ性重視なら暗黙が良さそう
- **座標系の規約**: 中心原点・短辺 = 2.0(-1..1)を仮置き(Punctual も -1..1 中心原点)。
  `px` 単位も欲しいか
- **エラー時の挙動**: パース/型エラー時は直前の正常なプログラムを維持して映像を止めない(TidalCycles 方式)を言語仕様として明記する
- **型注釈の要否**: 上の型系は推論で全部隠せるはず。エラーメッセージの質だけが勝負
- **Lipschitz 規律の担保**: Curv は「SDF は近似でよいが Lipschitz 定数 ≤ 1」を要求する。
  `warp` や `distort`、外来ブロック(例11)はこれを破り得る(レイマーチの突き抜けの原因)。
  型で守るか、ランタイムで歩幅を縮めて許すか、アートなので「壊れても絵になる」と割り切るか
- **`<>` と `etime` の相互作用**: クロスフェード中、新プログラムの `etime` はいつから
  進むか(評価時点起点が素直だが、フェード完了起点の方が「登場」を書きやすい場面もある)
- **bbox の要否**: Curv の Shape は bbox を持つ(レンダ最適化・エクスポート用)。
  ライブ用途では無限に広がる場が多く、必須ではなさそう。当面持たない
