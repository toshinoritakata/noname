# ADR-0030: Webcam入力を `prev` と同じ sample テクスチャパターンで追加する

- Status: accepted
- Date: 2026-07-07

## Context

外部入力の観点でこのプロジェクトを見直したところ、映像/カメラ入力が
一切ないことが分かった(`getUserMedia({video:true})` の使用箇所ゼロ)。
ライブビジュアルでは「客席・パフォーマー自身をカメラで撮ってエフェクトに
混ぜる」という表現が定番で、この欠落は([[ADR-0029]] の OSC と並んで)
実務上のギャップとして指摘されていた。

既存の入力(`audio`/`mouse`/`midi`/`tuio`/`osc`)は ADR-0012 の2正規形
(スカラー uniform / 固定長エンティティ表)のどちらかに収まるが、
カメラ映像は「解像度が可変な2Dの色そのもの」であり、どちらの形にも
うまく当てはまらない。一方でこのプロジェクトには既に全く同じ形の値が
存在する: `prev`(前フレーム画像、ADR-0003)。`prev` は
`{v:"field", dim:2, fn: (c,p) => sample("prev", worldToUv(p))}` という
実装で、2Dテクスチャをワールド座標でサンプルする Field そのもの。
カメラ映像もこれと全く同じ形で表現できる。

## Decision

`webcam` という名前で、`prev` と同一のパターンの組み込み `Field` を追加する
(`src/compiler/stdlib/inputs.ts`)。3D用の `camera eye target` コンストラクタ
(§4.11)と紛らわしくならないよう `camera` ではなく `webcam` にした。

```ts
add("webcam", (ctx) => ({
  v: "field", dim: 2,
  fn: (c, p) => sample("cam", worldToUv(p)), // 実際は vecV(4, ...) でラップ
}));
```

ランタイム側(`src/runtime/inputs.ts`)は `getUserMedia({video:true})` で
取得した映像を `<video>` 要素に流し込み、`loadedmetadata` で実解像度が
判明してから(カメラの解像度は機種依存で事前に分からない)
`createWorkTexture` でテクスチャを確保、毎フレーム
`GPUQueue.copyExternalImageToTexture()` で直接GPUへコピーする
(CPU側でピクセルを読んで `writeTexture` するfft/TUIOの経路より低コスト。
ブラウザネイティブのビデオフレーム→テクスチャ転送 API を使う)。

起動トリガーは `fft` と同じパターン: コンパイル済みプログラムが
`"cam"` というテクスチャキーを実際に参照しているか
(`passes[].textures.includes("cam")`)を見て、参照している時だけ
カメラ許可を要求する。`webcam` を使わない作品はカメラに一切触れない。
この判定を `usesFft`/新設の `usesCamera` の2箇所で重複させないよう、
`Renderer` に共通の `usesTexture(program, key)` ヘルパーを切り出した。

## Consequences

- ✅ `webcam |> chromatic 0.05 |> bloom 0.3` のように、既存の2D postfx
  パイプラインへそのまま合流できる(`prev` と同じ Field である以上、
  特別扱いが要らない)
- ✅ `copyExternalImageToTexture` はブラウザのビデオデコード/カラー変換を
  経由してGPUに直接転送するので、CPU側でのピクセル走査を伴う
  fft/TUIO/OSC の経路より効率が良い
- ⚠️ **アスペクト比の不一致は未対応(既知の制限)**: `worldToUv` は
  キャンバスのアスペクト比を前提にした座標系で、カメラ映像は実解像度が
  それと一致するとは限らない(例: 16:9のカメラを正方形キャンバスで使うと
  伸び縮みする)。`webcam |> fit "cover"` のような crop/letterbox 制御は
  次のイテレーションに回した
- ⚠️ カメラ権限が拒否される/取得できない環境では `camTexture` が
  `null` のままになり、`webcam` を参照するプログラムは(ダミーテクスチャに
  フォールバックする既存の bind group 機構により)クラッシュはしないが、
  何も映らない。明示的なプレースホルダ画像は用意していない

## 関連

[[ADR-0003]](2層状態、`prev` の実装元)/ [[ADR-0012]](2正規形+InputAdapter、
本機能はどちらの正規形にも当てはまらない第3のケース)/ [[ADR-0029]]
(同じ「実務ギャップの洗い出し」から見つかった OSC 入力)
