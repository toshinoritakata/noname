# ADR-0026: `bloom` の抽出は alpha を rgb に事前乗算してから行う

- Status: accepted
- Date: 2026-07-07

## Context

`grid [1,1] \i -> box 0.3 |> rot (...) |> fill (...) |> bloom 0.2`
のように、画面に図形が1つだけのシンプルなシーンで `bloom` をかけると、
図形の輪郭とは無関係に**画面全体が図形の色でうっすら一様に発光する**
という報告があった([[ADR-0025]] のモアレ修正とは別の症状)。

原因を CPU 側インタプリタ(`interp.ts`)でIRを直接評価して特定した:
`Shape.colour()`(ADR-0002)は、その図形の「色」を**空間全域で**返す
関数であり、可視/不可視の判定は別チャンネルの alpha が担う設計になっている
(`toImage` が `dist` から `smoothstep` で alpha を作り、`colour` の結果と
組み合わせる)。つまり図形の外側(alpha=0の完全に透明な領域)でも、
`colour()` は普通に図形の色を返し続ける。

ところが `brightPass`(ADR-0019)は

```wgsl
fn brightPass(c: vec4f) -> vec4f {
  return vec4f(max(c.rgb - vec3f(0.55), vec3f(0.0)), 0.0);
}
```

と、`c.rgb` だけを見て `c.a` を完全に無視していた。そのため bloom の
抽出(extract)は、図形の輪郭の外側(alpha=0)でも「その図形の色」が
そのまま閾値判定にかけられ、明るい色であれば画面全域が光っているとみなされて
しまう。密なグリッド(前回までの例)では複数の色が混ざるため気づきにくかったが、
図形が1つだけの単純なシーンでは「画面全体が一様にその色でにじむ」という
形で顕在化した。

## Decision

`bloom` の抽出直前で、alpha を rgb に事前乗算(premultiply)してから
`brightPass` に渡す(`src/compiler/stdlib/postfx.ts`):

```
premultiplied.rgb = sampled.rgb * sampled.a
premultiplied.a   = sampled.a
extractRoot = brightPass(premultiplied)
```

- alpha=0 の領域は premultiply 後に rgb も確実に 0 になるので、
  `brightPass` がそこを明るいと誤判定することがなくなる
- alpha=1 の領域(図形の内部)は乗算しても値が変わらないので、
  今までの見た目には影響しない

## Consequences

- ✅ 図形の外側が誤って発光する問題を解消。図形が1つだけのシーンでも
  グリッド上のシーンでも、光るのは実際に見えている(alpha>0の)部分だけになる
- ✅ 修正は `postfx.ts` の `bloom` 内に閉じており、`brightPass` 自体や
  ダウンサンプル/アップサンプルの連鎖([[ADR-0025]])には手を入れていない
- ⚠️ 半透明(0<alpha<1)の境界のグロウは、premultiply された分だけ
  やや控えめになる(意図通り: 半分透明な縁は半分の明るさとして扱われる方が
  自然)

## 関連

[[ADR-0002]](Shape の `{dist, colour}` 表現)/ [[ADR-0018]](自己アルファ
事前乗算に関する先行の応急修正)/ [[ADR-0019]] [[ADR-0025]]
