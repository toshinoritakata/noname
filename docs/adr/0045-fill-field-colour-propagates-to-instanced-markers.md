# ADR-0045: `fill` に場の色を渡しても sprite/strip の instanced マーカーを引き継ぐ

- Status: accepted
- Date: 2026-07-12

## Context

`fill`(`src/compiler/stdlib/color.ts`)に `VField`(座標依存の色)を渡すと、
従来は `sprite`/`strip2D`/`strip3D` マーカーを無条件で `undefined` にして
いた。コメントには「場は座標依存なのでスプライト/ストリップ伝播できない
(安全にフォールバック)」とあり、[[ADR-0027]] が定義した「性質2」の
安全なフォールバック(前提が壊れたら黙って通常の SDF ループに落ちる)を
意図した実装だった。

しかし `scatter` された `point`/`line`/`bezier` に色フィールドを `fill`
すると、フォールバック先の SDF ループ自体が [[ADR-0037]] で存在しない
(line/bezier は instanced 描画専用、単体使用はコンパイルエラー)ため、
実際にはフォールバックせず**コンパイルエラーになるか**(line/bezier)、
[[ADR-0035]] の警告つきで O(n) ループに転落していた(point)。
「粒子ごとに違う色をつけたい」という `ramp`/`noise`/`fbm` 等を使う典型的な
用途がそもそも書けない状態だった。

`sprite.center`/`strip2D.p0,p2`/`strip3D.p0,p2` はいずれも `loopi` にのみ
依存する値であり(`scatter` のマーカー契約、`value.ts:100-105`)、これらの
点で場を1回評価すれば「粒子ごとに違う色」という意味論を保ったまま
sprite/strip マーカーを継続できる。[[ADR-0027]] が `liftDist` の対象外に
した理由(colour だけを変える合成子は sprite/strip 側のリテラル色も
追従させる必要があり、単純な spread では扱えない)がここでも成立するため、
`liftDist`/`liftColour` を新設せず `fill` 内で直接組み立てる。

## Decision

`fill` の場分岐(`color.ts`)で、`sprite`/`strip2D`/`strip3D` マーカーが
既存するなら、評価点(sprite は `center`、strip は `p0`/`p2` の中点)で
場を1回評価した色を差し込んで引き継ぐ。line の場合 `mid(p0,p2)` は
`value.ts` の規約上の中点 `p1` と一致するため、直線・曲線どちらでも
歪みなく成立する。マーカーが元々 `undefined`(すでに他の変換で伝播が
切れている)場合はそのまま `undefined` を維持する。

```ts
sprite: sh.sprite ? { ...sh.sprite, colour: asColor(ctx, cf.fn(ctx, sh.sprite.center, span), span) } : undefined,
strip2D: sh.strip2D
  ? { ...sh.strip2D, colour: asColor(ctx, cf.fn(ctx, mid(sh.strip2D.p0, sh.strip2D.p2, 2), span), span) }
  : undefined,
```

## Consequences

- ✅ `scatter ... |> fill (ramp [...] (noise 2))` のような色フィールドが
  point/line/bezier の instanced 描画(sprite/strip/strip3d)でも
  コンパイルでき、粒子ごとに異なる色で描画される
- ✅ 定数色ブランチ(`recolorMarkers`)とは独立した経路のため、既存の
  定数色 `fill` の挙動には影響しない
- ✅ 回帰テスト追加(`test/compile.test.ts`):
  bezier(strip2D)/point(sprite)/line(strip3D)の3ケースで、色フィールド
  `fill` 後もエラーなく該当 instanced パスに正しい count で昇格することを
  確認
- ⚠️ `fill` を `scatter` の**後**に適用した場合(集約済み `spriteBatches`
  等への `fill`)は本 ADR の対象外で、従来どおり旧色のまま(既知の別課題、
  回帰ではない)
- ⚠️ 目視でのブラウザ確認(粒子ごとに実際に色が変わって見えること)は
  未実施。次回 `/verify` 等で確認するとよい

## 関連

[[ADR-0027]](liftField/liftDist による副チャンネル伝播の集約、fill/glow を
対象外にした理由)/ [[ADR-0014]](sprite instanced 描画)/
[[ADR-0016]](line/bezier strip 描画)/ [[ADR-0035]](instanced 昇格し損ねの
警告)/ [[ADR-0037]](line/bezier SDF 完全廃止)
