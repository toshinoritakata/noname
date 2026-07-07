# ADR-0037: line/bezier のSDFを完全に廃止し、instanced描画専用にする

- Status: accepted
- Date: 2026-07-07

## Context

[[ADR-0015]] は line/bezier を「距離ゼロの曲線」というSDFとして定義し、
[[ADR-0016]](2D)/[[ADR-0036]](3D)がその上に instanced 描画を「昇格」
として積み重ねてきた。だがこの「SDFが本体で、instanced描画は最適化」
という構造そのものを見直し、**line/bezierからSDFを完全に削除する**。
instanced描画(strip2D/strip3D)だけが実体になる。

## Decision

`line`/`bezier` の `dist` を、呼ばれたら必ず `fail(...)`(明確なコンパイル
エラー)を返す関数に置き換える。WGSL側の `sdSegment2`/`sdSegment3`/
`sdBezier2`/`sdBezier3`(生成器・ライブラリ関数)と、CPUインタプリタ
(`interp.ts`)の対応する分岐、それらのSDF性質テスト(境界≈0・Lipschitz、
`test/sdf.test.ts`)もあわせて削除した。

**単体(scatterしない)使用**: 従来、`line`/`bezier` は `scatter` した時
だけ `loopShape` の確率的プローブで instanced 描画に昇格し、単体使用時は
常にSDFで描かれていた。SDFが無くなったので、単体使用も instanced 描画に
乗せる必要がある。`toImage`(2D、`ops.ts`)と `render`(3D、
`physics3d.ts`)に、`sh.strip2D`/`sh.strip3D` を見つけたら **`dist` に
一切触れず**、インスタンス数1の `StripBatchSpec`/`Strip3BatchSpec` を
直接登録する経路を追加した(`scatter` 集約後のバッチと同じ描画経路に
乗る)。

**結果として、line/bezier は `outline`/`fill`/`glow`(3Dのみ)/`scatter`
以外の合成子と一切組み合わせられなくなった**: `move`/`rot`/`scale`/`warp`/
`distort`/`cut`/`inter`/`<+>`/`if`/`morph` はすべて内部で `dist` を評価
しようとするため、line/bezier に対して使うと明確なコンパイルエラーになる
(ADR-0010により、エラー時は直前の正常なプログラムが描画され続ける)。

## Consequences

- ✅ 「SDFが本体、instanced描画は最適化」という二重の実装(sdSegment/
  sdBezier の解析距離関数+strip描画)を、instanced描画1本に統合できた。
  コード量が減り、「見た目を変えずに裏の描画経路が変わる」という
  ADR-0016/0036の複雑さがなくなった
- ✅ 単体使用(`out (bezier a b c |> outline w |> fill c)`)も引き続き
  正しく描画される。実機で確認済み(2Dの単体bezier、`render`経由の3Dの
  単体line、いずれも正しく描画)
- ✅ 対象外の合成(`move`等)は以前は「見た目を変えずにSDFへ安全に
  フォールバック」だったが、今は明確なコンパイルエラーになる。実機で
  確認済み: `line a b |> outline w |> move v |> fill c` は
  「line にはSDFがありません」というエラーになり、ADR-0010により直前の
  正常な映像が維持されることを確認
- ⚠️ **破壊的変更**: line/bezier を `move`/`cut`/`inter`/`<+>`/`if`/
  `morph`/一般の`warp`族と組み合わせていた既存コードは動かなくなる。
  このリポジトリの既存サンプル(14番・22番)は元々
  `scatter (... |> outline |> fill)` の対象チェーンのみを使っており影響なし
- ⚠️ line/bezier の輪郭を他のSDF図形と真にブール演算(交差・減算等)したい
  場合の手段が無くなった。必要になれば、FFI(`wgsl`ブロック)で自前の
  距離関数を書く形になる

## 関連

[[ADR-0002]](Shape の `{dist, colour}` 表現。line/bezierはこの原則から
明示的に外れる例外になった)/ [[ADR-0010]](エラー時も直前の映像を維持
する、今回のエラー経路で実際に機能することを確認)/ [[ADR-0015]](line/
bezierを距離ゼロの曲線としたSDF由来の設計、本ADRで撤回)/ [[ADR-0016]]
(2D instanced描画)/ [[ADR-0036]](3D instanced描画)
