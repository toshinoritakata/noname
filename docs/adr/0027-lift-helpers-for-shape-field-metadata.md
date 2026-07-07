# ADR-0027: `liftField`/`liftDist` で Shape/Field の副チャンネル伝播を集約する

- Status: accepted
- Date: 2026-07-07

## Context

`VField`/`VShape`(`value.ts`)は本体の `fn`/`dist`/`colour` に加えて、
scatter 由来の最適化のための副チャンネルを持つ: `state`([[ADR-0003]] の
simulate 由来マーカー)、`sprite`/`spriteBatches`([[ADR-0014]])、
`strip2D`/`stripBatches`([[ADR-0016]])。これらは合成子(`bloom` のような
postfx、`outline`、`warp` 族、`<+>`、`if`、`morph` など)が新しい
field/shape オブジェクトを組み立てるたびに、該当するチャンネルを手で
コピーする規約に頼っていた。

実際に踏んだバグ(line/bezier を `bloom` に通すと真っ黒になる)を調べたところ、
同じ規約違反が `ops.ts` 内に複数見つかった: `shapeUnion` は `spriteBatches` は
マージするのに `stripBatches` は見落としており、`selectValue`/`mixValue`
(`if`/`morph` の実体)は5チャンネルを全て落としていた。落とし先は
`postfx.ts` の6関数に留まらず、規約だけに頼る限り新しい合成子を書くたびに
再発する構造的なバグクラスだと判断した。

副チャンネルには2つの性質がある:

1. **集約後のバッチ(`spriteBatches`/`stripBatches`)は無条件で継承しなければ
   ならない。** 一度 `loopShape` が集約すると、対象の `dist` は定数 `+∞` に
   すり替えられ、実体は専用パスだけが描く([[ADR-0014]]/[[ADR-0016]])。
   このため通常の SDF へのフォールバックが存在せず、伝播を落とすと図形が
   完全に不可視になる(バグ)。
2. **集約前の単項マーカー(`sprite`/`strip2D`)は前提条件付きでしか継承できない。**
   「中心・半径・制御点・色が座標に依存しない」という前提の下で
   `loopShape` の確率的プローブに見つけてもらうためのマーカーであり、
   `dist` を書き換える変換(`outline`/`warp`/`distort`/二項 CSG)がこの前提を
   壊しうる。これは黙って落としても安全なフォールバック
   (`loopShape` がマーカーを見つけられず、通常の(遅いが正しい)SDF ループに
   落ちる)であり、`value.ts` のコメントで既にそう明記されていた。

## Decision

`ops.ts` に2つのリフト関数を追加し、新しい field/shape を組み立てる箇所を
これらに置き換える:

```ts
// VField: state/stripBatches はどちらも fn が何をしようと安全に持ち越せるので
// base を spread して fn(必要なら dim)だけ差し替える
function liftField(base: VField, fn: VField["fn"], dim = base.dim): VField

// VShape: dist を変える変換の共通リフト。spriteBatches/stripBatches は
// 無条件で base から継承(性質1)。sprite/strip2D は呼び出し側に必須キーとして
// 明示させる(undefined でもよいが、書き忘れをコンパイルエラーにする、性質2)
function liftDist(base: VShape, dist: VShape["dist"], opts: {
  colour?: VShape["colour"];      // 省略時は base.colour のまま
  sprite: VShape["sprite"];       // 必須
  strip2D: VShape["strip2D"];     // 必須
}): VShape
```

colour だけを変える合成子(`fill`/`glow`)は対象外とした: これらは
`sprite.colour`/`strip2D.colour` という**リテラル値**も同じ変換で追従させる
必要があり(`glow` は boost を再適用、`fill` は新しい定数で上書き)、
「base を spread して colour だけ差し替え」では sprite/strip2D 側の色が
古いまま取り残される。単純な spread ではこの2つを正しく扱えないため、
`liftColour` は作らず既存の手書き実装のままにした。

適用箇所: `toImage`(field分岐)、`warpValue`(move/rot/scale/repeat/mirror/twist
の実体)、`timeWarp`(slow/loop の実体)、`outline`、`distort`、`postfx.ts` の
6関数。あわせて性質1の見落としバグを修正: `shapeUnion`・`cut`・`inter`・
`selectValue`・`mixValue` に `spriteBatches`/`stripBatches` の無条件マージを
追加(`sprite`/`strip2D` は二項combinatorで意味が壊れるため明示的に
`undefined`)。

## Consequences

- ✅ 副チャンネル(特に性質1のバッチ)の伝播漏れが型システムで検出できる
  範囲が広がる(`liftDist` の `sprite`/`strip2D` は必須キー)
- ✅ 実弾だったバグ4件(`shapeUnion`/`cut`/`inter`/`selectValue`/`mixValue`
  の stripBatches・spriteBatches 消失)を副次的に修正
- ✅ 回帰テスト追加(`test/strip-batch-propagation.test.ts`): scatter した
  line/bezier を bloom 系 postfx・`<+>`・`if`・`cut`・`inter` に通しても
  消えないことを確認。修正前のコードに対して実際に落ちることも確認済み
- ⚠️ `liftColour` は作らなかったため、今後 colour だけを変える新しい合成子を
  書く際は sprite/strip2D の色追従を引き続き手で書く必要がある
  (fill/glow の実装を参考にする)

## 関連

[[ADR-0002]](Shape の `{dist, colour}` 表現)/ [[ADR-0014]](sprite
instanced 描画)/ [[ADR-0016]](line/bezier strip 描画)/ [[ADR-0026]]
(今回と同種の、bloom 内での副チャンネル関連の事前乗算バグ修正)
