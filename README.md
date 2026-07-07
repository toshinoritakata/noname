# noname(仮称・未命名)

creative coding 向けのライブコーディング言語と、その TypeScript 実装(コンパイラ + WebGPU ランタイム)。

```
out (circle (0.3 + 0.1 * sin time) |> fill white) <> 0.5s
```

![デモ: 上のコード(脈打つ円)をそのまま実行した様子](assets/demo.webp)

**[Live Demo](https://toshinoritakata.github.io/noname/)** — WebGPU対応ブラウザならインストール不要でその場で触れる。

作品を **`(空間座標, 時間) → 色` の純粋関数** として書き、SDF(符号付き距離場)の代数で図形を合成する。書いたコードはブラウザ内で WGSL にコンパイルされ、WebGPU で実行される。コードを書き換えると、直前のプログラムと新しいプログラムを(`<>` でクロスフェード時間を指定すれば)なめらかに混ぜながら差し替わる。

Conal Elliott の Fran(アニメーション=時間の純粋関数)/ Pan(画像=座標の純粋関数)の系譜を継ぎ、Curv(SDF代数はあるがライブ性なし)と Punctual(ライブ性はあるがSDF代数なし)の間を埋める設計。詳しくは [prior-art.md](prior-art.md) を参照。

## クイックスタート

Node.js があれば十分(実行時依存ゼロ — devDependencies はテスト用の型定義と WGSL 構文チェッカーのみ)。

```sh
npm install
npm run dev
```

`http://localhost:8787/` を WebGPU 対応ブラウザ(最新の Chrome 等)で開く。左側のエディタにコードを書くと、250ms のデバウンス後に自動でコンパイル・評価される(`Shift+Enter` で即時評価)。数値の上で `Alt` を押しながらドラッグすると、再コンパイルなしにその場で値をスクラブできる。

```sh
npm run build   # tsc のみ。ビルド成果物は dist/
npm test        # node --test で全テストを実行(golden 更新は UPDATE_GOLDEN=1 npm test)
```

## このリポジトリの構成

```
dream-code.md          -- 「書きたい作品」12例から言語仕様を逆算した設計スケッチ
prior-art.md           -- Curv / Punctual 調査、設計判断の根拠
implementation.md      -- 処理系設計(コンパイラ6段 + ランタイム)、マイルストーン
docs/adr/               -- 個々の設計判断の記録(Architecture Decision Records)
docs/architecture-diagrams.md -- 構成図(mermaid)
docs/reference.md      -- 実装済みの構文・標準ライブラリの詳細リファレンス
src/compiler/            -- lexer / parser / 型推論 / staging / パス分割+WGSL生成 / GLSL互換層
                            / 専用Web Worker(重いコンパイルをメインスレッドから追い出す)
                            / stdlib(標準ライブラリ、shapes・color・postfx 等カテゴリ別)
src/runtime/             -- WebGPU ランタイム(2スロットクロスフェード・BufferRegistry・
                            Worker への薄いクライアント・Clock/audio/mouse/MIDI 等の入力)
src/examples.ts          -- サンプル集23例(エディタの Prev/Next で切り替えられる)
test/                    -- node --test 一式(構文・golden・レイテンシ予算 等)
```

設計ドキュメントを読む順番は `dream-code.md → prior-art.md → implementation.md → docs/adr/` の順(設計の導出順)。**「今どんな構文・標準ライブラリが使えるか」だけを知りたい場合は [docs/reference.md](docs/reference.md) から読むのが早い。**

このリポジトリで Claude Code(または他のコーディングエージェント)に作業させる場合の詳しいガイドは [CLAUDE.md](CLAUDE.md) を参照。

## 言語のコア

- 作品は純粋関数。状態は「前フレーム参照(`prev`)」と「シミュレーション(`simulate`)」の2層のみに限定し、それ以外はすべて時空間の関数として書く
- 図形(Shape)は `{dist, colour}` レコード(距離場と色が最初から同居する)。`<+>`(合成)・`cut`(くり抜き)・`blendAll`(スムーズブレンド)などで組み立てる
- 数値リテラルは自動で uniform 昇格される。`0.3` を `0.35` に書き換える程度の編集は再コンパイル不要、1フレーム以内に反映される(ライブ体感の要)
- 型注釈は書かない。2D/3D の次元も含めて全部推論される
- エラー時は直前の正常なプログラムが走り続ける(映像は止まらない)

## 現状

M0〜M6 まで実装済み(パーティクルの instanced 描画、line/bezier の三角形ストリップ化、blendAll の大 N 対応など、実測に基づく最適化も含む)。設計上の未解決課題は `dream-code.md`「未解決の設計課題」と `docs/adr/README.md`「未決」に残っている。
