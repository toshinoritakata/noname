# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリは何か

creative coding 向けライブコーディング言語(仮称・未命名)の設計ドキュメントと、その**TypeScript 実装**(コンパイラ+WebGPU ランタイム)。ドキュメントはすべて日本語。

## 実装の構成とコマンド

- `src/compiler/` — lexer / parser / infer(HM 制限版、best-effort 層)/ stage(部分評価 → Field IR、**staging が意味判定の正**)/ wgsl(パス分割+WGSL 生成)/ interp(CPU 側 IR インタプリタ)/ glsl(GLSL/Shadertoy 互換層、遅延ロード)/ worker(コンパイラ専用 Web Worker。重い同期コンパイルをメインスレッドから追い出し、入力とフレームループを止めない)/ stdlib.ts(バレル)+ stdlib/(標準ライブラリの実装本体。カテゴリ別に分割: shared/shapes/color/postfx/time/simulate/iteration/physics3d/noise/math/inputs/ffi)
- `src/runtime/` — gpu / program(ProgramSlot)/ registry(BufferRegistry)/ renderer(2スロット+クロスフェード、コンパイルは compiler-client 経由で Worker に委譲)/ compiler-client(Worker への薄いクライアント)/ inputs(Clock・audio・mouse・MIDI・InputAdapter・TUIO)
- `src/examples.ts` — dream-code 12例(未定義補助を補った適合版)+ 実装確認用に追加した2例(六角柱の床・line/bezier の弦の模様)
- ビルド: `npm run build`(tsc のみ。実行時依存ゼロ。devDeps は @types/node と wgsl_reflect(テストの WGSL 構文検証)だけ)
- テスト: `npm test`(node --test が .ts を直接実行。golden 更新は `UPDATE_GOLDEN=1`)
- 開発サーバ: `npm run dev` → http://localhost:8787/(WebGPU 対応ブラウザで開く。入力を検知して自動評価(250msデバウンス、Shift+Enter で即時評価)、数値の上で Alt+ドラッグでスクラブ)。コンパイラは専用 Web Worker で動くため、**コンパイラ側のソースを直したらブラウザタブのハードリフレッシュが必要**(Worker は自動で再読み込みされない)
- レイテンシ予算(implementation.md §7)は `test/latency.test.ts` が CI 的に監視する

言語のコア意味論: **作品 = `(空間座標, 時間) → 色` の純粋関数**。SDF(符号付き距離場)シーン代数で図形を合成し、全体を WGSL にコンパイルしてブラウザ(WebGPU)で実行する。ニッチは「Pan の意味論 × SDF シーン代数 × テンポパターン × 2層状態 × ライブクロスフェード」の交差点で、Curv(SDF 代数はあるがライブ性なし)と Punctual(ライブ性はあるが SDF 代数なし)のどちらにも無い組み合わせ。

## ドキュメントの構成と優先順位

読む順番 = 設計の導出順:

1. **dream-code.md** — 12本の「書きたい作品」のコード例から言語プリミティブを逆算した設計スケッチ。型の骨格・標準ライブラリの章立て・未解決課題はここの「総括」にある
2. **prior-art.md** — Curv / Punctual の調査。何を採り何を避けるかの判断根拠
3. **implementation.md** — 処理系設計(コンパイラ6段+ランタイム)。マイルストーン M0〜M6 とレイテンシ予算もここ
4. **docs/adr/** — 上記から抽出した意思決定の記録(0001〜0020)。索引は docs/adr/README.md
5. **docs/architecture-diagrams.md** — mermaid 図集。**文章と食い違ったら文章側(implementation.md / ADR)が正**
6. **docs/reference.md** — 実装済みの構文・標準ライブラリ全体を網羅した詳細リファレンス(設計の経緯は上記1〜4を参照。ここは「今何が使えるか」の一次情報)

## 設計変更時のルール

- 新しい設計判断をしたら ADR を追加する。形式は既存に合わせる: `Status / Date / Context / Decision / Consequences / 関連`、ファイル名は `NNNN-kebab-case-slug.md`、docs/adr/README.md の索引にも追記
- **ADR-0013 は「採らないと決めたもの」の記録**(組合せ展開・Tidal 級パターン代数・bbox・モナド/型クラス・汎用 JS FFI・デスクトップネイティブ)。これらを再提案・再発明しない。再訪するなら個別 ADR で
- 設計文書を変えたら、対応する図(architecture-diagrams.md)と ADR の整合を確認する
- 未解決課題は dream-code.md「未解決の設計課題」と docs/adr/README.md「未決」に列挙されている。これらは M0〜M3 の実測を待って決める方針であり、先回りして確定させない

## アーキテクチャの要点(実装が始まったときの前提)

- **全部 TypeScript・ブラウザ内で完結**(ADR-0006)。ゼロインストールは Curv の失敗からの譲れない一線。wasm 化は退路(Staging 以降のみ、境界は「型付き Core → Field IR」)
- コンパイラは6段: Lexer/Parser → Desugar → 型推論(HM 制限版+次元多相、注釈レス)→ **Staging(部分評価で一階の Field IR へ。処理系の心臓部)** → パス分割(RenderGraph)→ WGSL 生成
- **数値リテラルは uniform に昇格**(ADR-0008): 数値編集は再コンパイルなしで 1 フレーム以内に反映。ライブ体感の最重要機構
- ランタイムは **ProgramSlot ×2(新旧クロスフェード用、使い捨て)+ BufferRegistry(simulate/prev の状態、スワップを跨いで永続)**。「プログラムは使い捨て、状態は永続」が所有権の原則
- 状態は `prev`(前フレーム画像)と `simulate`(場の進化)の2層のみ(ADR-0003)
- エラー時は直前の正常プログラムが走り続け、映像を止めない(ADR-0010、TidalCycles 方式)
- 実装は M0 から垂直に切る(implementation.md §9)。**M0(例1のみ+ホットスワップ+uniform 昇格)でライブの体感を検証し、出なければ設計に戻る**。レイテンシ予算(§7)は M0 からベンチマークとして自動検証する方針
