# ADR-0044: 2D の line/bezier ストリップを bloom 前の HDR scene テクスチャへ合成する

- Status: accepted
- Date: 2026-07-08

## Context

ADR-0016 は 2D の line/bezier を三角形ストリップとしてラスタライズし、**最終画像
(colorTex)に premultiplied-over で上描きする**と決めた。この「最後に上乗せ」構造が
2つの問題を生んでいた。

1. **`line`/`bezier` に `glow` を適用するとコンパイルエラー**になる。ADR-0037 で
   line/bezier の SDF を完全に廃止したため、`glow` が `strip2D` マーカーを落とす
   (当時の設計)と、その図形は strip 描画にも SDF フォールバックにも乗れず、
   `dist` が使えず失敗する。ユーザーには「直前フレームで固まる」だけに見える。
2. **bloom が 2D ストリップに一切届かない**。bloom の抽出(postfx.ts)は
   「ユーザーの画像式 `img.fn` を低解像度で再評価」する方式(ADR-0019/0025)。
   3D では sprite/strip3d が bloom より前に rmTex へ描き込まれ、`render` の場が
   その rmTex をサンプルするので抽出が拾える。しかし 2D ストリップは `img.fn` に
   含まれず(`.stripBatches` として別ラスタライズされる)、しかも image/tonemap の
   **後**に上乗せされるため、glow で明るくしても bloom の光暈にならず、SDR で
   ただ白飛びするだけだった。

要するに 3D は「ジオメトリを bloom 前のテクスチャに焼き込む」経路を持つのに、
2D だけがそれを欠いていた。実機検証(`bezier |> fill |> glow`)で、現状は
コンパイルエラー、`strip2D` を運んでも白飛びのみ、という2点を確認した。

## Decision

2D ストリップにも 3D と同じ「bloom 前のテクスチャに焼き込む」経路を与える。

- **`glow` は `strip2D` を落とさず運ぶ**(sprite/strip3D と対称。`recolorMarkers` の
  drop 指定を外す)。明るさブーストは座標非依存なのでマーカー色にそのまま積める。
- **`scene` テクスチャ**(全解像度・rgba16float、premultiplied)を新設。strip パスは
  最終画像ではなく **bloom より前に** この scene テクスチャへ描き込む(最初のバッチで
  clear、以降は load で累積)。
- **`toImage` が場のグラフに scene サンプルを注入する**。ストリップを運ぶ図形を場に
  変換するとき、`fn` を `overPremul(sample("scene", worldToUv(p)), 背景)` で包む。
  これでストリップの寄与が「場」の一部になり、場を再評価する bloom の抽出が拾える。
  注入は toImage の図形→場の変換点(bloom より内側)で一度だけ行う。
- ランタイムのパス順は data → sim → raymarch → sprite → strip3d → **strip(scene へ)**
  → bloom → image に変更。**image 後の strip 上描きは廃止**する。

`overPremul(top, bot)` は top=premultiplied(scene)、bot=straight(背景場)を
premultiplied-over で合成し straight alpha で返すヘルパー(overBlend の premult 版)。

## Consequences

- ✅ `line`/`bezier` に `glow`+`bloom` が効く。実機で scatter 200 本の bezier に
  `|> glow 0.8` → `|> bloom 1.2` を適用し、色付きの光暈が出ることを確認(従来は
  コンパイルエラー)。3D の bloom 経路(例15)は不変であることも実機で確認。
- ✅ **副産物**: bloom なしの `glow` も改善。ストリップが tonemap の**前**に合成
  されるようになったため、glow の HDR 超過が Reinhard(ADR-0020)で丸められ、
  従来の白飛びが色を保った明るいストリップになる。
- ✅ ストリップの無い作品は一切影響なし(`scene` テクスチャも注入も strip パスが
  あるときだけ)。golden も strip を含む例(14)以外は不変。
- ⚠️ ADR-0016 の「最終画像へ直接上描き」を差し替える。2D ストリップを含む全作品が
  scene テクスチャ+場サンプル経由になり、(1)全解像度 HDR ターゲットが1枚増える、
  (2)image/bloom-extract の各ピクセルで scene サンプルが1回増える。実測 60fps 維持。
- ⚠️ ストリップは worldToUv でサンプルするため、頂点の worldToClip と uv 規約が
  厳密に一致している必要がある(prev/webcam と同じ前提)。実機でストリップ位置が
  従来と一致することを確認済み。

## 関連

[[0016]](2D line/bezier を三角形ストリップでラスタライズ。本 ADR が描画先と合成順を差し替える)/
[[0037]](line/bezier の SDF を完全廃止。glow がエラーになる遠因)/
[[0019]](bloom のダウンサンプル連鎖)/ [[0025]](bloom 抽出はネイティブ解像度で評価)/
[[0020]](最終合成の Reinhard tonemap)/ [[0027]](Shape マーカー伝播の集約、recolorMarkers)/
[[0036]](3D line/bezier は rmTex へ描き込み bloom に乗る。2D をこれに揃えた)
