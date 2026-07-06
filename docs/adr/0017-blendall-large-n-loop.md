# ADR-0017: blendAll は大きな N で WGSL ループに畳み込む

- Status: accepted
- Date: 2026-07-06

## Context

`range n |> map f |> blendAll k`(例4のメタボール)は `scatter`/`grid` と違って
大きな N 向けのループ化しきい値(implementation.md 3.2-2、ADR-0014)を持たず、
`blendAll` は常に JS 側で N-1 段の smin/mix チェーンを展開していた。
ユーザー報告: 例4の `range 6` を `range 60` に変えると「重くて何もできなくなる」。

実測(このマシン、Apple Silicon + Metal でも): N=60 で生成 WGSL が 107KB
(N=6 の約9倍、ほぼ線形)になり、ドライバのシェーダコンパイルを含む swap が
17ms→471ms に悪化。ユーザーの環境ではさらに悪化していた可能性が高い。
`scatter`/`grid` の UNROLL_LIMIT(64)は N=60 をまだ「小さい」と判定してしまうため、
そのまま流用しても今回のケースは救えない。

## Decision

`range n`(`rangeOf: n` を付与)→ `map f` → `blendAll k` の連鎖を検出し、
N が `BLEND_UNROLL_LIMIT`(24。scatter/grid の 64 より小さい —
blendAll は項目ごとに dist+colour 両方、しかも colour は前段までの再帰評価を
伴うため、平坦な min 合成より生成コードが重くなりやすいことを実測から反映)を
超えたら、JS 側の展開をやめて **1つの WGSL for ループ**に畳み込む。

- `map` は `f` を **1回だけ**シンボリックな `loopi(id)` で評価した `proto`
  (まだ座標を与えていない Shape)を `symbolicLoop` として結果のリストに添える。
  `items` 自体は互換のため今まで通り展開する(他の合成子は影響を受けない)
- `blendAll` は `symbolicLoop` を見つけたら、アキュムレータ
  `vec4(dist, colour.rgb)` を1個の loop ノードで畳み込む(colour.a は
  常に1と仮定 — 3D 図形の色は基本不透明なので実用上問題ない)
- 数学的な正しさは `smin(+∞, x, k) = x`、`sminH(+∞, x, k) = 0` という恒等式に
  よる: 初期値 `+∞` から fold すれば、「items[0] から始めて残りを fold する」
  展開版と**厳密に同じ結果**になる(1周目で必ず items[0] の値に上書きされる)

## 実装時に見つけた別の(既存の)バグ

上記を実装して初めて発現した、**ループ巻き上げ機構そのものの既存バグ**を
1つ修正した: `Codegen`(wgsl.ts)の「loop」emit が `"var acc = ...;"` と
`"for (...) {"` を**本体の emit より先に** `scope.lines` へ積んでいたため、
本体の中から「ループに依存しない定数を親スコープへ巻き上げる」(implementation.md
の既存最適化)処理が走ると、巻き上げられた行が `for (...) {` の**内側**に
誤って挿入されてしまっていた(WGSL のブロックスコープ外からその変数を参照
すると `unresolved value` エラーになる)。修正: 本体を emit し終えてから
`"var acc"`/`"for("` を積む順序に変更。ADR-0014/0016 の巻き上げ機構にも
共通する潜在バグだったため、他のループ利用箇所にも波及する修正。

## Consequences

- ✅ 実測: N=60 の swap 時間が 471ms → 10ms。N=200 でも 11ms、60fps を維持
- ✅ 生成 WGSL サイズが N に依存しなくなる(N=60: 107KB → 4.7KB、N=5000でも
  ほぼ同じ約5KB)
- ✅ `range`/`map`/`blendAll` の言語表面は無変更。ユーザーのコードは書き換え不要
- ✅ 副次的に、既存のループ巻き上げ機構全体(ADR-0014 のスプライト、ADR-0016 の
  ストリップも含む)に影響し得た潜在バグを修正できた
- ⚠️ N<=24(BLEND_UNROLL_LIMIT)では今まで通り展開版を使う(小さい N では
  ループのオーバーヘッドを避ける)
- ⚠️ ループ版はアキュムレータに colour.a を含めない(常に不透明と仮定)。
  半透明な3D図形合成は現状スコープ外(元々 3D シェーディングパイプラインで
  alpha はほぼ使われていないため実害は薄い)
- ⚠️ `range n |> map f` 以外(たとえば手で書いた N 要素のリストリテラル、
  `scatter` の結果を map したもの等)には `rangeOf`/`symbolicLoop` が付かず、
  引き続き展開版になる。需要が見えたら対象を広げる(拒否ではなく延期の姿勢、
  ADR-0013 と同じ)

## 関連

dream-code.md 例4(メタボール)/ implementation.md 3.2-2 /
[[0014]](scatter の点状パーティクルのインスタンス化、同じ「大 N はループへ」の思想)/
[[0016]](line/bezier の strip 化)
