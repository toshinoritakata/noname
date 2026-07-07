# ADR-0041: instanced描画バッチのパスハッシュに count を含める

- Status: accepted
- Date: 2026-07-07

## Context

ユーザー報告: `scatter` の要素数(N)を変更しても、実際に描かれる線
(line/bezier の instanced strip 描画)の本数が変わらない。

原因は [[ADR-0008]] の「数値リテラルの変更だけなら uniform 更新のみで
再コンパイルを省略する」高速経路(`renderer.ts` の
`this.active.compiled.programHash === result.program.programHash`)。
`programHash` は各パスの `hash` フィールド(`wgsl.ts`)を連結したもので、
これは「パスを再構築すべきか」を判定する**構造**ハッシュである
(uniformの値そのものは含まない、という設計、implementation.md 3.4)。

sprite(ADR-0014)/strip(ADR-0016)/strip3d(ADR-0036)の instanced 描画
バッチは、`StripBatchSpec`/`Strip3BatchSpec`/`SpriteBatchSpec` の
`p0IR`/`p1IR`/`colourIR` 等が **`loopi(id)` を含む1つの式**で、
実際の描画時に GPU 側が `instance_index` を渡して同じ式を N 回評価する
仕組み(データパス+instanced draw)になっている。つまり **N を変えても
式グラフ(IR)自体は一切変わらない** —— 変わるのは `batch.count` という
ただの数値フィールドだけ。

ところが `wgsl.ts` でこれら6箇所(sprite-data/sprite/strip3-data/
strip3/strip-data/strip)のパスハッシュ計算は、式グラフの
`structuralHash`(+ 参照している `input` 名のリスト)だけをハッシュに
入れ、**`batch.count` を含めていなかった**。そのため `scatter 5` を
`scatter 50` に変えても6パス全てのハッシュが不変 → `programHash` も
不変 → ADR-0008 の高速経路が誤って発動し、GPU側は旧プログラムの
古い instance count のまま描画し続けていた。

同じ仕組みの `loop`(非instanced、大きいNのSDFループ、ADR-0035の
警告対象)IR ノードは `structuralHash` の実装内で `count` を
明示的に含んでいた(`loop:${n.count}:...`)ので無関係。JS側で unroll
する小Nのパスも、Nが変わればunion展開されるノードの個数自体が変わる
ため、これも自然に安全だった。**instanced描画の6箇所だけが例外的に
「countがIRの外にある」構造だったために見落とされていた。**

## Decision

sprite-data/sprite/strip3-data/strip3/strip-data/strip の6つの
パスハッシュ計算すべてに `batch.count` を追加した:

```ts
// before
hash: fnv1a("strip:" + batch.loopId + ":" + segs + ":" + inputs.join(","))
// after
hash: fnv1a("strip:" + batch.loopId + ":" + batch.count + ":" + segs + ":" + inputs.join(","))
```

## Consequences

- ✅ `scatter N` の N を変えると(instanced描画の対象であっても)必ず
  `programHash` が変わり、正しく新スロットへの再構築+クロスフェード
  (ADR-0008の「swap」経路)が走るようになった。実機で確認済み:
  N=5→50→5 と変えるたびに毎回 `swap` になり(以前は2回目以降
  `uniform 更新のみ` に落ちて本数が変わらなかった)、実際に描画される
  線の本数が正しく追従することをスクリーンショットで確認
  (5本 → 50本 → 5本)
- ✅ 同じ N のまま再コンパイルした場合は引き続き `programHash` が一致し、
  ADR-0008の高速経路(uniform更新のみ)が正しく効く(回帰なし)
- ✅ `test/compile.test.ts` に sprite/strip/strip3d 全種で N の変更が
  `programHash` を変えることを検査する回帰テストを追加した
- ⚠️ 同種のバグ(「IRグラフの外にある数値がパスの見た目に影響するのに
  ハッシュに含まれていない」)は、新しい instanced 描画の種類を追加する
  たびに再発しうる構造的リスク。新設するパスでは「この pass.hash は
  再構築要否を完全に決定できているか」を都度確認する必要がある

## 関連

[[ADR-0008]](数値リテラルのuniform昇格、今回誤発動した高速経路)/
[[ADR-0014]](sprite instancing)/ [[ADR-0016]](2D strip instancing)/
[[ADR-0036]](3D strip instancing)
