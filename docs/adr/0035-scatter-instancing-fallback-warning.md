# ADR-0035: scatter が instanced 描画に昇格し損ねたら warning 診断を出す

- Status: accepted
- Date: 2026-07-07

## Context

`scatter`(N が `UNROLL_LIMIT` を超える場合)は `loopShape` の中で
「`point |> move |> fill/glow` の連鎖なら sprite instanced 描画([[ADR-0014]])、
`line/bezier |> outline |> fill` の連鎖なら strip instanced 描画
([[ADR-0016]])に昇格し、それ以外は O(n) の SDF ループにフォールバックする」
という判定をしている。このフォールバックは**見た目を一切変えない**(意図的な
設計、value.ts のコメントに「安全に SDF フォールバック」と明記されている)
ため、ユーザーは自分のコードが速い経路と遅い経路のどちらを通っているか、
実行結果を見ても分からない。

これは実際に踏んだ問題でもある: [[ADR-0027]] で `liftField`/`liftDist` の
副チャンネル伝播を調べていた際、`scatter` の生成関数に `move`/`fill`/`glow`/
`outline` 以外の合成子(`rot`/`scale`/`warp`/`distort`/`<+>` など)を
一つ挟むだけで、この昇格判定が静かに外れることを確認した。ライブコーディング
中に何気ないリファクタで一段挟んだだけで、O(1) の instanced 描画から
O(n) の SDF ループへ転落し、n が大きいシーンではフレームレートが
崩れうる ―― にも関わらず、それを教えてくれる仕組みが何もなかった。

## Decision

`loopShape`(`src/compiler/stdlib/iteration.ts`)で、`trySprite=true` の
呼び出し(`scatter` から)が sprite/strip どちらの昇格にも該当せず
O(n) ループにフォールバックする直前に、`severity: "warning"` の診断を
`ctx.diags` に積む。警告は**コンパイルを止めない**(`error` ではない。
`compile()` の成功判定は `severity==="error"` の有無だけを見るので、
既存の「エラー時は直前の正常プログラムを維持する」(ADR-0010)には
影響しない)。

メッセージは「なぜ」ではなく「何が対象か」を伝える固定文言にした
(`point r |> move v |> fill/glow` か `line/bezier |> outline w |> fill c`
だけが対象、という2パターンを列挙する)。実際にどの合成子が原因で
外れたかを正確に特定する仕組み(評価の来歴を追跡する等)は複雑になりすぎる
ため見送り、「この2パターンと比べてどこが違うか自分で確認してください」
という形に留めた。

## Consequences

- ✅ 「見えない性能崖」が診断パネルに出るようになった。実機で確認済み:
  `scatter 100 (\i -> point 0.05 |> move ... |> rot ... |> fill white)`
  (`rot` を挟んだだけの例)で警告が出て、対象の2パターン(`move+fill`の
  みの例、`outline+fill`の例)では警告が出ないことをテストと実ブラウザの
  両方で確認した
- ✅ 実装は `loopShape` 内の1箇所に警告を積むだけで、既存の判定ロジック
  そのものは一切変更していない
- ⚠️ 警告文言は固定で、原因の特定は利用者に委ねる(「なぜ」の自動診断は
  複雑さに見合わないと判断し見送った)
- ⚠️ `scatter` 以外の経路(`grid`/`range|>map|>blendAll`)はそもそも
  instanced 描画を試みない設計なので対象外

## 関連

[[ADR-0014]](sprite instanced 描画)/ [[ADR-0016]](strip instanced 描画)/
[[ADR-0027]](この崖を実際に踏んだ副チャンネル伝播の調査)
