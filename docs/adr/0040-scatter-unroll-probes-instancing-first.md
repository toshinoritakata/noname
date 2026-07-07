# ADR-0040: scatter は unroll するかどうかの前に instanced 描画の判定を行う

- Status: accepted
- Date: 2026-07-07

## Context

[[ADR-0037]] で line/bezier からSDFを完全に削除して以降、
`scatter N \i -> ... bezier ... |> outline w |> fill c` が **N が
`UNROLL_LIMIT`(64、implementation.md 3.2-2)以下だと必ずコンパイル
エラーになる**という回帰が見つかった(ユーザー報告: `scatter 2` で
「bezier にはSDFがありません」)。

原因は `scatterBuiltin`(`stdlib/iteration.ts`)の既存の分岐順序:

```
if (n <= UNROLL_LIMIT) {
  // JS側でN回 gen() を呼び、foldUnion(= 通常の shapeUnion の連鎖)で合成
} else {
  loopShape(ctx, n, gen, span, true)  // instanced 描画への昇格判定はここだけ
}
```

`foldUnion`/`shapeUnion` は合成のために **必ず `dist` を呼ぶ**。
line/bezier に SDF が無くなった今、`dist` を呼んだ時点で
`fail(...)`(ADR-0037)になる。N=1 だけは `foldUnion` が「配列が1個なら
ループを回さずそのまま返す」実装だったため偶然動いていたが(`dist` に
一切触れない)、N=2〜64 は必ず `shapeUnion` を経由するため確実に壊れて
いた。N=65 以上は `loopShape` の instanced 描画判定(プローブ)を先に
通るため問題なかった —— **判定順序が逆だったのが根本原因**。

## Decision

「unroll するか WGSL ループにするか」の分岐を `loopShape` の内部に
移し、**scatter は常に無条件で `loopShape` を呼ぶ**ようにした。
`loopShape` は次の優先順位で判定する:

1. sprite/strip2D/strip3D への instanced 描画に昇格できるか(プローブ、
   ADR-0014/0016/0036)。**N の大小に関係なく常にこれを最初に試す**
2. 昇格できない場合、N が `UNROLL_LIMIT` 以下なら JS 側で unroll して
   `foldUnion`(従来の小N向けの挙動をそのまま踏襲)
3. それでも N が大きい場合だけ、WGSL の for ループ + ADR-0035 の警告

これにより「instanced 描画に昇格できるかどうか」は N の大小と完全に
独立な判定になり、line/bezier のような **SDFを持たない図形は
scatter一つの実装経路だけを通る**(N=1〜64 と N=65 以上で別の関数を
呼ぶという非対称性が無くなった)。

## Consequences

- ✅ `scatter N \i -> line/bezier |> outline w |> fill c` は N の大小に
  関わらず常にコンパイルできる。実機・単体テスト双方で N=1〜1000 の
  幅広い範囲を確認済み(冒頭のユーザー報告のケースを含む)
- ✅ instanced 描画に昇格できない普通のSDF図形(`circle`/`box`等)の
  小N `scatter` は、挙動を変えず引き続き unroll+foldUnion される
  (ADR-0035の警告は大Nの場合のみ、という既存の意味も保たれる)
- ✅ プローブ呼び出し(`gen` を1回追加で呼ぶ)が全ての `scatter` に
  掛かるようになったが、`gen` はもともと instanced 昇格が成立する
  パスで probe→real の2回呼びを前提にした設計であり、副作用への
  依存も元から無い(想定されている)ため実質的なコスト増のみ
- ⚠️ このバグは「N=200 の例だけでテストしていた」ため見つからなかった。
  `test/strip-batch-propagation.test.ts` に N=1,2,3,10,63,64,65 を
  横断する回帰テストを追加した

## 関連

[[ADR-0037]](line/bezierのSDF完全廃止。本バグの引き金)/ [[ADR-0014]]
(sprite instancing)/ [[ADR-0016]](2D strip instancing)/ [[ADR-0036]]
(3D strip instancing)/ [[ADR-0035]](見えない性能崖の警告診断)
