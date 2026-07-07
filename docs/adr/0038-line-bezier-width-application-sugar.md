# ADR-0038: `line a b w` は Shape への数値適用として `outline` の糖衣構文にする

- Status: accepted
- Date: 2026-07-07

## Context

`line`/`bezier` の幅を `|> outline w` ではなく `line a b w` のように直接
指定したい、という要望があった。素直には「`line` の第3引数(`bezier` は
第4引数)に幅を追加する」形だが、この言語の関数適用は**固定arityの
カリー化**(`stage.ts` の `applyValue`)で、`line`/`bezier` という同じ名前で
「幅なし版(2引数/3引数)」と「幅あり版(3引数/4引数)」を共存させることが
できない(部分適用が何引数目で確定するかは名前ごとに1つの固定値でなければ
ならない)。

## Decision

`line a b`(既存どおり、幅0のShapeを返す)自体は変更しない。その代わり、
**line/bezier が返す Shape(strip2D/strip3Dを持つ)に数値をもう1つ適用すると、
`outline` と同じ意味になる**、という評価規則を `stage.ts` の `applyValue`
に追加した:

```
line a b w  =  (line a b) w  =  line a b |> outline w
```

実装は `outline` ビルトインの本体を `ops.ts` の `outlineShape(ctx, sh, wn, span)`
という共有関数に切り出し、`stdlib/shapes.ts` の `outline` ビルトインと
`stage.ts` の新しい `applyValue` の `case "shape"`(`fn.strip2D || fn.strip3D`
の時だけ許可、それ以外の Shape に数値を適用すると従来通りエラー)の
両方から呼ぶようにした。

**型推論(infer.ts)側の対応**: `infer.ts` は「関数適用」の型検査を持つ
best-effort 層(CLAUDE.md/index.ts のコメントの通り「staging が最終判定」)
だが、この新しい適用パターンを知らないと最終的に staging が成功しても
`error` severity の診断が残ってしまう(diagnostics に error が1つでもあると
UIはエラー表示にする)。`app` ケースに、関数側の型が `shape` に解決した
場合は Float の適用を許し結果型を同じ shape とする分岐を追加した(既存の
`field` サンプリングの特別扱いと同じ形)。infer は「どの Shape が
strip2D/strip3D 持ちか」までは追跡しないため、`circle 0.3 0.05` のような
対象外の誤用は型検査では防げないが、staging 側が実行時に正しく
コンパイルエラーにする(実機で確認済み)。

## Consequences

- ✅ `line a b w |> fill c` / `bezier a b c w |> fill col` と直接書ける。
  実機で確認済み: `line a b w` で幅付きの線が正しく描画され、診断も
  一切出ない(infer側の誤検知も解消済み)
- ✅ 既存の `|> outline w` の書き方は完全にそのまま使える(内部で同じ
  `outlineShape` を呼ぶ実装の共有により、意味が完全に一致する)
- ✅ line/bezier 以外の Shape(`circle`/`box`等)に数値を適用するのは
  引き続きコンパイルエラー(`fn.strip2D || fn.strip3D` のガードにより)
- ⚠️ 「Shapeに数値を適用する」という構文が、line/bezier由来のShapeに限って
  特別な意味を持つ非対称な規則になった。一般化(任意のShapeに任意個の
  引数を後付けできる仕組み)ではなく、line/bezierという1ケースのための
  ピンポイントな対応

## 関連

[[ADR-0016]](2D strip、`outline`が幅を更新する規約の元)/ [[ADR-0036]]
(3D strip)/ [[ADR-0037]](line/bezierのSDF完全廃止、本ADRの前提)
