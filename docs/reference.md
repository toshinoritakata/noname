# 言語リファレンス

実装(2026-07-06 時点)にもとづく詳細リファレンス。設計の経緯・根拠は
dream-code.md / implementation.md / docs/adr/ を参照。ここでは**現在ビルドできる
構文と標準ライブラリ全体を網羅的に**記す。

---

## 1. 意味論の要点

- 作品は `(空間座標, 時間) → 色` の純粋関数(ADR-0001)。`time` はどこでも
  暗黙に参照できるグローバルなシグナル
- 図形(Shape)は `{dist, colour}` レコード(ADR-0002)。距離と色は最初から同居する
- 状態は `prev`(前フレーム画像)と `simulate`(場の進化)の2層のみ(ADR-0003)
- 数値リテラルは自動で uniform に昇格する(ADR-0008)。`0.3` を `0.35` に書き換える
  程度の編集は**再コンパイル不要**、1フレーム以内に反映される
- 型注釈は書かない。型はすべて推論される(ADR-0009)。次元(2D/3D)は使用箇所から
  単相化される

---

## 2. 構文

### 2.1 プログラムの構造

```
name = expr          -- トップレベル束縛(左辺に引数を並べると関数になる)
height p = fbm (p * 0.4) * 2.0   -- 引数つき束縛(関数)

out expr             -- 出力(明示)
out expr <> 0.5s      -- <> の後にクロスフェード時間(implementation.md 5.1)

expr                 -- 最後の裸の式は暗黙に out 扱い(明示 out がなければ)
```

- 改行が文の区切り。丸括弧 `(...)` / 角括弧 `[...]` / 波括弧 `{...}` の中では
  改行が無視される(暗黙の行結合)
- **行頭 `|>` の省略**: 前の行が式として完結していて、次の行がインデントされて
  いれば暗黙のパイプと解釈される
  ```
  out (circle 0.3)
      fill white        -- 暗黙に |> fill white
  ```
- コメントは `-- ここから行末まで`

### 2.2 リテラル

| 種類 | 例 | 備考 |
|---|---|---|
| 数値 | `0.3`, `12`, `-1` | 自動で uniform 昇格(ADR-0008)。単項マイナスは字句レベルで判別 |
| 時間 | `0.5s`, `2s`, `1beat` | `<>` のフェード時間、`cycle` の周期などに使う |
| 文字列(生) | `"""...."""` | FFI ブロック(`wgsl`/`glsl`/`shadertoy`)の中身専用。パースはしない |
| リスト | `[a, b, c]` | 2〜4要素はベクトルとしても使える(スカラー乗算などが効く) |
| レコード | `{ x: 1, y: 2 }` | フィールドアクセスは `.x` |

### 2.3 束縛・関数

```
let a = 1
    b = a + 1
in a + b

\i -> i * 2            -- ラムダ
f x y = x + y           -- 複数引数の束縛(カリー化)
```

- ラムダ本体は「ラムダが始まった行以下のインデントの行」が来るまで続く
  (例: `|> map \i -> ... |> blendAll k` の `blendAll` はラムダの**外**に適用される)
- `let` は複数束縛可(改行または `;` 区切り)。`in` の前に来る

### 2.4 条件分岐

```
if cond then a else b
```

`cond` が場(Field)なら、結果全体が自動的に場へ持ち上がる(`select` に展開される)。

### 2.5 演算子と優先順位

優先順位は**低い→高い**の順(数値が大きいほど強く結合):

| 優先度 | 演算子 | 意味 |
|---|---|---|
| 1(最弱) | `<>` | クロスフェード宣言(`out expr <> dur` の形でのみ) |
| 2 | `<over>` | 画像のアルファ合成(上に重ねる) |
| 3 | `<+>` | 図形の合成(min-union) |
| 4 | `\|>` | パイプ(`x \|> f` = `f x`) |
| 5 | `== != < > <= >=` | 比較 |
| 6 | `+ -` | 加減算 |
| 7(最強) | `* / %` | 乗除算 |

`a |> f <over> b` は `(a |> f) <over> b` と解釈される。フィールドアクセス `.x` は
関数適用よりさらに強く結合する。

### 2.6 FFI ブロック(§6 参照)

```
name = wgsl (型注釈) """
  ...WGSL コード...
"""
```

---

## 3. 型の骨格

```
Field d a = Point d -> a          -- d ∈ {2, 3}。時間は暗黙の第4引数
Shape d   = { dist: Field d Float, colour: Field d Color }
Image     = Field 2 Color
Color     = vec4
Cam, Dur(時間リテラルの型)
```

- スカラー ⇔ 場の区別はユーザーからは見えない(`Float` は必要な場所で自動的に
  定数場へ持ち上がる)
- 次元(2D/3D)は多くの合成子(`move`/`rot`/`<+>` など)で多相。実際の次元は
  引数(ベクトルの要素数)から単相化される
- 型エラーは「期待側」「実際側」両方の由来位置とドメイン語彙(例: `Field 2 Color`
  →「2Dの色場(画像)」)で表示される(ADR-0009)

### 座標系の規約

- ワールド座標は中心原点、**短辺が -1..1**(implementation.md）
- 2D の `y` は画面の上方向が正
- 3D はカメラ・ワールド共通の右手系相当(`orbit`/`camera` 参照)

---

## 4. 標準ライブラリ

### 4.1 形状プリミティブ(Shape を返す)

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `circle r` | `Float -> Shape2` | 半径 `r` の円 |
| `sphere r` | `Float -> Shape3` | 半径 `r` の球 |
| `box s` | `Vec d -> Shape d` | 軸並行な箱。`s` は半径ベクトル(2Dなら vec2, 3Dなら vec3)。スカラーも可(正方形/立方体) |
| `tri r` | `Float -> Shape2` | 正三角形(外接半径 `r`) |
| `point r` | `Float -> Shape d` | 点(円/球と同じ距離式。`scatter` でのインスタンス化検出の起点。ADR-0014) |
| `line a b` | `Vec d -> Vec d -> Shape d` | 2点間の**距離ゼロの線分**(パス上で厳密に0)。太さは `outline` で与える。2D は三角形ストリップで直接ラスタライズ(ADR-0016)、3D は SDF |
| `bezier a b c` | `Vec d -> Vec d -> Vec d -> Shape d` | 2次ベジエ曲線(距離ゼロ)。2D は厳密解析距離+strip描画、3D は3点が張る平面へ投影した厳密距離(SDF、ADR-0015) |
| `plane.x h` / `.y h` / `.z h` | `Float -> Shape3` | 軸に垂直な無限平面(`plane` はレコード) |
| `heightfield f` | `(Vec2 -> Float) -> Shape3` | 高さ場から3D SDFを作る(`f p` が p での高さ)。Lipschitz安全係数0.6を内蔵 |
| `stripes n` | `Float -> Field2 Float` | 縦縞パターン(0..1)。図形ではなく場 |

### 4.2 空間操作(warp 族。図形にも場にも効く)

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `move v x` | `Vec d -> a -> a` | 平行移動 |
| `rot a x` | `Float -> a -> a` | 2D回転 |
| `rotX a x` / `rotY a x` / `rotZ a x` | `Float -> a -> a` | 3D軸回転 |
| `scale k x` | `Float -> a -> a` | 拡大縮小(距離もスケール補正) |
| `repeat cell x` | `Vec d -> a -> a` | 空間の周期タイル化 |
| `mirror x` | `a -> a` | 各軸を絶対値化(対称化) |
| `twist k x` | `Float -> Shape3 -> Shape3` | Y軸まわりのツイスト |
| `warp f x` | `(Point d -> Point d) -> a -> a` | 任意の座標変換。`move`/`rot`/`repeat` は全部これの特殊形 |
| `distort f x` | `Field d Float -> Shape d -> Shape d` | 距離場にオフセットを加算(表面をノイズ等で乱す) |

### 4.3 形状合成

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `a <+> b` | 演算子 | min-union(2図形をそのまま合体)。大きな N の `scatter`/`grid` は自動でループ化(ADR-0014) |
| `cut tool base` | `Shape -> Shape -> Shape` | `base` から `tool` をくり抜く |
| `inter a b` | `Shape -> Shape -> Shape` | 交差 |
| `blendAll k list` | `Float -> [Shape] -> Shape` | smooth union(スムーズブレンド)で畳み込む。`range n |> map f` で N>24 のとき自動でWGSLループに変換(ADR-0017) |
| `morph k x` / `morph k a b` | `Float -> Pattern a -> Pattern a` または `Float -> a -> a -> a` | パターンに適用: 要素間の補間幅を設定。図形/値2つに直接適用: 距離と色を同時に線形補間(`morph k a b`) |
| `outline w x` | `Float -> Shape -> Shape` | 輪郭線化(`abs(dist) - w`)。`line`/`bezier` の太さ付けに使う |

### 4.4 彩色・光

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `fill c x` | `Color -> Shape -> Shape` | 色を差し替える(場でも可 — 座標に応じた着色) |
| `hsv h s v` | `Float -> Float -> Float -> Color` | HSVから色 |
| `ramp colors x` | `[Color] -> Field Float -> Field Color` | 0..1の場を色のグラデーションに変換 |
| `glow k x` | `Float -> Shape -> Shape` | 明るさをブースト(`1 + k*2.5` 倍) |
| `bg c` | `Color -> Image` | 全面単色の画像 |
| `sun dir` | `Vec3 -> Light` | 平行光源 |
| `sunlight` | `Light` | デフォルトの太陽光(既定方向) |
| `shade light x` | `Light -> Shape3 -> Shape3` | Lambert+スペキュラでシェーディング(3D専用) |
| `fog k c x` | `Float -> Color -> Shape3 -> Shape3` | 距離に応じてフォグ色へブレンド |

### 4.5 画像合成・ポスト処理(Image → Image)

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `a <over> b` | 演算子 | アルファ合成(`a` を `b` の上に重ねる) |
| `fade k x` | `Float -> Image -> Image` | 全体を `k` 倍(暗くする/トレイルのフェード) |
| `zoom k x` | `Float -> Image -> Image` | 拡大(`k>1` で拡大) |
| `bloom k x` | `Float -> Image -> Image` | 明るい部分をにじませる |
| `chromatic k x` | `Float -> Image -> Image` | 色収差 |
| `grain k x` | `Float -> Image -> Image` | フィルムグレイン(時間で変化するノイズ) |
| `vignette k x` | `Float -> Image -> Image` | 周辺減光 |

### 4.6 場プリミティブ・乱数

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `noise` | `Field d Float` | 値ノイズ(2D/3D は座標の次元で自動判別) |
| `noise2` | `Field2 Vec2` | 2チャンネルの値ノイズ |
| `fbm` | `Field d Float` | フラクタルブラウン運動(オクターブ5) |
| `fbm2` / `fbm3` | `Field2 Float` / `Field3 Float` | 次元固定版 |
| `curl` | `Field d Vec2` | カールノイズ(渦状のベクトル場) |
| `hash i` | `Float -> Float` | 決定的な擬似乱数(0..1) |
| `hash2 i` | `Float -> Vec2` | 2成分版 |
| `onSphere uv` | `Vec2 -> Vec3` | 球面上の一様分布点(`uv` は2つの乱数) |

### 4.7 時間・シグナル

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `time` | `Float` | 単調増加するグローバル時計(リセットされない) |
| `etime` | `Float` | 評価時点からの経過時間(`<>` クロスフェード開始点起点) |
| `etime'` | `Float` | フェード完了時点起点の版 |
| `dt` | `Float` | シミュレーションの固定タイムステップ |
| `cps` | `Float` | cycles per second(テンポ) |
| `lag k x` / `smooth k x` | `Float -> Float -> Float` | 外部入力(`audio.*`/`mouse.*`/`midi.*`)専用の指数平滑化 |
| `slow k x` | `Float -> a -> a` | 時間を `k` 分の1に引き伸ばす |
| `loop d x` | `Float -> a -> a` | 時間を周期 `d` で折り返す |
| `cycle dur [items]` | `Dur -> [a] -> Pattern a` | 値の列を周期 `dur` で巡回。`|> morph k` で境界を補間 |
| `every n f x` | `Float -> (a->a) -> a -> a` | `n` 拍周期の先頭ビートでだけ `f x` を返し、それ以外は `x` をそのまま通す(cps基準) |

### 4.8 状態(2層。ADR-0003)

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `prev` | `Image` | 前フレームの最終出力(フィードバック用、最軽量の状態) |
| `simulate init update` | `Field/値 -> (state -> state) -> Field` | 場を初期値+更新則で進化させる。`simulate N init update`(第一引数が数値)ならパーティクル配列 |
| `laplacian s` | `a -> a` | 隣接テクセルとの5点ステンシル(simulate の状態専用) |
| `sample s p` | `Field a -> Vec d -> a` | 任意座標で場をサンプル |

`simulate` の状態の同一性は**束縛名+型シグネチャ**で決まる(implementation.md 5.2)。
再評価時、名前とレイアウトが一致すれば中身を保持したまま更新則だけ差し替わる。

### 4.9 物理(SDFがそのまま衝突ジオメトリになる)

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `dist shape p` | `Shape d -> Vec d -> Float` | `p` での符号付き距離(貫通判定に使う) |
| `grad shape p` | `Shape d -> Vec d -> Vec d` | `p` での距離場の勾配(法線、有限差分) |
| `gravity` | `Vec3` | 標準重力ベクトル `[0, -3, 0]` |
| `reflect v n` | `Vec -> Vec -> Vec` | 反射ベクトル |

### 4.10 反復・コレクション

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `range n` | `Float -> [Float]` | `[0, 1, ..., n-1]` |
| `map f xs` | `(a->b) -> [a] -> [b]` | 写像 |
| `grid dims f` | `[Float,Float] -> (Float->Shape2) -> Shape2` | 2Dグリッド。N>64 は自動でWGSLループ化 |
| `scatter n f` | `Float -> (Float->Shape) -> Shape` | `n` 個の個体生成。N>64 は自動でループ化。`point`/`line`/`bezier` チェーンは instanced 描画へ切り替わる(ADR-0014/0016) |

`n`(要素数)は**静的に決まる必要がある**(implementation.md 3.2-2)。数値リテラルか
その定数演算で書く。

### 4.11 3Dレンダリング

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `orbit r a` | `Float -> Float -> Cam` | 原点を中心に角度 `a`、距離 `r` で周回するカメラ |
| `camera eye target` | `Vec3 -> Vec3 -> Cam` | 位置・注視点を直接指定するカメラ |
| `render cam shape` | `Cam -> Shape3 -> Image` | レイマーチしてImageにする。march 96段(重い場合48段+半解像度に自動縮退) |

### 4.12 外部入力(ADR-0012)

| 名前 | 型 | 説明 |
|---|---|---|
| `audio.lo` / `.mid` / `.hi` / `.level` | `Float` | 帯域ごとの音量(Web Audio AnalyserNode) |
| `audio.fft i` / `fft i` | `Float -> Float` | FFTビン `i` の値 |
| `mouse.x` / `.y` / `.pos` / `.down` | `Float`/`Vec2`/`Float` | マウス位置(ワールド座標)・ボタン押下 |
| `midi.cc n` | `Float -> Float` | MIDI CC番号 `n` の値(0..1) |
| `tuio.cursor i` | `Float -> {pos,angle,vel,alive,age}` | TUIOカーソル(要WebSocket中継、implementation.md 5.3.1) |

### 4.13 色定数

`white black red green blue coral midnight teal ivory indigo skyblue orange magenta gray`
(すべて `Color`)

### 4.14 数学関数(場に自動リフト)

`sin cos tan abs floor ceil fract sqrt exp log sign atan2 pow wrap min max clamp
mix step smoothstep length normalize dot cross reflect`

引数がベクトルなら成分ごとに、場(Field)なら座標に応じて評価される。

---

## 5. FFI(ADR-0011)

```
name = wgsl (型注釈) """
  fn f(p: vec2f, t: f32) -> f32 { ... }
"""
```

| 型注釈 | 生成される関数シグネチャ |
|---|---|
| `Field Float` | `fn f(p: vec2f, t: f32) -> f32` |
| `Field 3 Float` | `fn f(p: vec3f, t: f32) -> f32` |
| `Field Vec2` / `Field Vec3` / `Field Color` | 戻り値が `vec2f`/`vec3f`/`vec4f` |
| `Image` | `fn f(p: vec2f, t: f32) -> vec4f`(2D色場) |

- 中身は不透明ノードとして生成シェーダに継ぎ足される(パースしない、名前だけ
  衝突回避のためリネーム)
- `glsl (型) """..."""` — 手書きGLSLサブセットをWGSLへ変換(遅延ロード、
  `src/compiler/glsl.ts`)。for/if/関数定義/`mod`/三項演算子などに対応
- `shadertoy """..."""` — Shadertoy互換。`iTime`/`iResolution`/`iMouse` を
  自動供給、`mainImage` を `Image` 型の値としてラップ

---

## 6. ライブ性の仕組み

- **自動評価**: エディタの入力を検知し、250msデバウンス後に自動でコンパイル・
  評価する。`Shift+Enter` でデバウンスを待たずに即時評価できる
- **エラー時は直前の正常なプログラムを維持**(ADR-0010)。構文・型エラーが
  あっても映像は止まらず、診断だけ表示される
- **`<> dur`**: 再評価時のクロスフェード時間。省略時は即時切替
- **数値スクラブ**: エディタ上の数値の上で Alt+ドラッグすると値が変化する
  (uniform 高速経路、再コンパイル不要)
- **状態保持スワップ**: `simulate` は束縛名とレイアウトが変わらない限り、
  コード編集後も中身(場の状態)を保ったまま更新則だけ差し替わる

---

## 7. パフォーマンス上の注意(実装上の既知の崖)

- `scatter`/`grid`/`blendAll` は大きな N で自動的にWGSLループ化されるため、
  N=数千〜数万でも描画コストがほぼ一定になる(ADR-0014/0017)
- `line`/`bezier` は2Dなら三角形ストリップで直接ラスタライズされる(march不要、
  ADR-0016)。3Dはまだ通常のSDFパスのみ
- `range n |> map f |> blendAll k` のループ化しきい値は N>24。それ以下は
  展開されるので、極端に重い1項目のシェイプを大量に並べる場合は注意
- コンパイラは専用のWeb Workerで動く。**コンパイラのソースを変更した場合、
  ブラウザタブのハードリフレッシュが必要**(Workerは自動で再読み込みされない)

---

## 8. 未対応・既知の制限

- 3D の `line`/`bezier` の instanced 描画(2Dのみ対応、ADR-0016)
- `line`/`bezier` の instanced 描画は `outline |> fill` の連鎖のみ検出
  (`move`/`glow` 等は未対応、SDFへ安全にフォールバック)
- 半透明な3D図形の合成(`blendAll` ループ版は colour.a=1 を仮定)
- Tidal級のパターン代数(`cycle`/`every` の式展開のみ。ADR-0013)
- bbox・組合せ展開・汎用JS FFI は意図的に不採用(ADR-0013)
