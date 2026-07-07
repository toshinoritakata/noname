# ADR 索引 — creative coding 言語(仮称)

設計文書(dream-code.md / prior-art.md / implementation.md)から抽出した意思決定の記録。
形式: Status / Context / Decision / Consequences。番号順が概ね「意味論 → 構文 → 処理系 → 周辺」。

## 意味論(言語の核)

- [0001](0001-artwork-as-pure-function-of-spacetime.md) — 作品を時空間上の純粋関数とする(Fran/Pan 系譜)
- [0002](0002-shape-as-dist-colour-record.md) — Shape は `{dist, colour}` レコード、時間は暗黙の第4座標(Curv 継承)
- [0003](0003-two-tier-state-prev-simulate.md) — 状態は `prev` / `simulate` の2層に限定

## ライブ性

- [0004](0004-live-swap-crossfade-two-slots.md) — `<>` クロスフェード、2スロット+BufferRegistry
- [0010](0010-keep-last-good-program-on-error.md) — エラー時は直前の正常プログラムを維持(TidalCycles 方式)

## 構文

- [0005](0005-new-syntax-ml-family-pipe.md) — 独自シンタックス、ML 系+ `|>` パイプ

## 処理系

- [0006](0006-browser-webgpu-typescript.md) — ブラウザ+WebGPU、処理系は全部 TypeScript
- [0007](0007-staging-to-first-order-field-ir.md) — Staging で一階 Field IR に落とす(SubCurv 方式継承)
- [0008](0008-literals-promoted-to-uniforms.md) — 数値リテラルは uniform に昇格(再コンパイルゼロの数値編集)
- [0009](0009-restricted-hm-types-no-annotations.md) — HM 制限版+次元多相、注釈レスの全域言語

## 周辺・拡張

- [0011](0011-ffi-typed-wgsl-blocks-glsl-compat.md) — FFI: 型注釈付き WGSL ブロック+GLSL/Shadertoy 互換層
- [0012](0012-two-input-normal-forms-inputadapter.md) — 入力は2正規形、拡張点は InputAdapter のみ(TUIO 等)
- [0013](0013-rejected-features.md) — 採らないと決めたもの(組合せ展開・パターン代数・bbox ほか)
- [0014](0014-particle-instanced-sprites.md) — scatter の点状パーティクルはインスタンス化スプライトで描画(CSG ループの構造的パフォーマンス問題への対応)
- [0015](0015-line-bezier-zero-width-curves.md) — line/bezier は距離ゼロの曲線とし、太さは outline に委ねる
- [0016](0016-line-bezier-strip-polygon-2d.md) — 2D の line/bezier は SDF ではなく三角形ストリップでラスタライズする(3D は未対応、需要が見えたら再訪)
- [0017](0017-blendall-large-n-loop.md) — blendAll は大きな N で WGSL ループに畳み込む(range/map/blendAll のパフォーマンス崖に対応、ループ巻き上げ機構の既存バグも修正)
- [0018](0018-bloom-alpha-premultiply-fix.md) — bloom は glow のあるところでアルファも持ち上げる(image パスの自己アルファ事前乗算で glow が背景に一切滲まなかったバグの修正)
- [0019](0019-bloom-downsample-blur-chain.md) — bloom はダウンサンプル+ブラーの多パス連鎖にする(単一パス多方向タップ近似の花びら状エイリアシングを解消)
- [0020](0020-reinhard-tonemap.md) — 最終合成に輝度ベースのReinhardトーンマッピングを挟む(HDR超過値の唐突な白飛びを緩和)
- [0021](0021-entropy-input-for-true-randomness.md) — 真の乱数は `entropy` スカラー入力として注入し、作品関数の純粋性を保つ
- [0022](0022-grid-o1-direct-index.md) — `grid` の大 N はループ化せず、クエリ点から直接セルを求める O(1) 評価にする
- [0023](0023-bloom-radius-parameter.md) — (撤回・[0024](0024-bloom-radius-adaptive-from-k.md)に差し替え) `bloom` にコンパイル時定数の半径パラメータを追加する案
- [0024](0024-bloom-radius-adaptive-from-k.md) — `bloom` の半径(ダウンサンプル段数)は独立引数にせず、`k` の静的な値から適応的に決める
- [0025](0025-bloom-native-res-extract.md) — `bloom` の抽出はネイティブ解像度で評価してからボックスフィルタで畳み込む(半解像度での直接評価によるモアレの根本修正)
- [0026](0026-bloom-premultiply-before-brightpass.md) — `bloom` の抽出は alpha を rgb に事前乗算してから行う(図形の外側が誤って発光するバグの修正)
- [0027](0027-lift-helpers-for-shape-field-metadata.md) — `liftField`/`liftDist` で Shape/Field の副チャンネル(sprite/strip2D/spriteBatches/stripBatches/state)伝播を集約する(line/bezier が bloom 等で消えるバグの根本修正)

## 未決(ADR 化待ち)

dream-code.md「未解決の設計課題」参照: `out` の暗黙化 / 座標系の規約 /
Lipschitz 規律の最終形(現状は安全係数 0.8 の暫定解)/ `<>` と `etime` の相互作用の既定。
いずれも M0〜M3 の実測を待って決める。
