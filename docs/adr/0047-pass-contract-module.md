# ADR-0047: compiler↔runtime のパス契約を pass-contract.ts に集約する

- Status: accepted
- Date: 2026-07-12

## Context

コンパイラが発行し(`wgsl.ts`)、ランタイムが読み戻す(`program.ts` /
`renderer.ts`)「パスの形」の契約が、3つの形で両側に重複散在していた:

1. **パス型**: `CompiledPass` が 11-way の `kind` 文字列 × 14 個の
   optional field の袋で、どの kind にどの field が有効かが型に載って
   いなかった。runtime 側は `p.spec.rmId!` のような non-null assertion と
   `!== undefined` ガードで契約を手で再導出していた。
2. **uniform layout と binding 規約**: header 4 float + slots
   (`d[4 + literalBase + i]`)というオフセット計算と、
   binding 0=uniform / 1=sampler / i+2=texture という規約を、
   compiler(WGSL 宣言の生成)と runtime(バッファ書き込み・
   BindGroupLayout 構築)が別々にハードコードしていた。
   `px = 2 / min(w, h)` の式も program.ts と renderer.ts で重複していた。
3. **パスハッシュ**: 各 emitter が `fnv1a(...)` の式を手書きしており、
   [[ADR-0041]] の Consequences が明記したとおり「IRグラフの外にある数値が
   パスの見た目に影響するのにハッシュに含まれていない」バグは、新しい
   instanced パスを追加するたびに再発しうる構造的リスクだった
   (新設するパスでは hash の完全性を都度・手動で確認する必要があった)。

先例として `tex-keys.ts` がある: compiler が発行し runtime が正規表現で
再解析していたテクスチャキーの文字列プロトコルを1つの module に集約した。
同じ流儀をパス契約全体に適用する。

## Decision

`src/compiler/pass-contract.ts` を新設し、compiler↔runtime 契約の唯一の
置き場とする。純データ+純関数のみ(Worker の postMessage を越えるため
関数を含む型は不可。GPU API 型にも依存しない)。

1. **`CompiledPass` を discriminated union にする**。共通コア
   (code/targets/textures/hash/lineSpans)+ kind ごとに必須化した
   variant field(`SimPass.simName`、`DataPass.dataKey/dataCount`、
   `RaymarchPass.rmId/halfRes`、`SpritePass.rmId/count`、
   `StripPass.count/vertexCount`、`Strip3dPass.rmId/count/vertexCount`、
   `BloomPass.bloomId/outKey/resDivisor`、`ImagePass`)。variant 内では
   接頭辞を落とした単純名にする(`spriteCount` → `count` 等)。
   runtime は kind で narrow するだけでよく、`!` と undefined ガードが消える。
2. **kind 別構築子がハッシュ計算を所有する**(`makeSpritePass` 等)。
   構築子は variant field と hash 専用パラメータ(structuralHash 文字列・
   loopId・segs 等)を型で受け、ハッシュ入力文字列は従来の emitter の式と
   byte 単位で同一に組み立てる(挙動変化ゼロ)。sprite-data/strip-data/
   strip3-data のデータパスは `makeDataPass` の `label` 引数で区別し、
   instanced 系ラベルのみ count を hash に含める(ADR-0041 の式を保存)。
   finalize(slotCount+テクスチャ構成の混ぜ込み)と programHash も
   `finalizePassHashes` / `programHashOf` として module が所有する。
3. **uniform layout / binding 契約を関数化**: `HEADER_FLOATS` /
   `uniformFloatCount` / `inputOffset` / `literalOffset` / `pxOf` /
   `uniformWgslDecl` / `BINDING_UNIFORM` / `BINDING_SAMPLER` /
   `textureBinding` / `textureWgslDecls`。compiler の WGSL 宣言生成と
   runtime のバッファ書き込み・BindGroupLayout が同じ関数を参照する。
4. `CompiledProgram` / `UniformLayout` / `SimRuntimeSpec` も wgsl.ts から
   移す。wgsl.ts は生成器(generateWGSL / wgslCanResolveCall)に専念する。
5. `test/pass-contract.test.ts` に**ハッシュ完全性のミューテーションテスト**
   を追加: 全構築子について「hash に影響すべき各引数を1つずつ変えると
   hash が必ず変わる」ことを機械的に検査する。ADR-0041 の教訓
   (count の入れ忘れ)の一般化であり、新しい構築子を足すときは
   このテストに1ケース足せば完全性が回帰検査される。

## Consequences

- ✅ どの kind にどの field があるかが型で表現され、runtime(program.ts)
  から non-null assertion と手動 undefined ガードが消えた
- ✅ ハッシュ式が構築子に集約され、「新設パスの hash 完全性を都度確認する」
  リスク(ADR-0041)がミューテーションテストで機械化された
- ✅ uniform layout / binding 規約の変更はこのファイル1箇所+テストで済む
- ✅ 挙動変化ゼロを確認済み: 全23例(src/examples.ts)の programHash が
  移行前後で一致、IR golden・WGSL 構文テストも無変更で通過
- ⚠️ 契約 module は wgsl.ts(emitter)からも program.ts(runtime)からも
  import される共有依存になる。契約以外のもの(IR 依存・GPU 依存・関数を
  含む型)をここに足すと Worker 境界(postMessage)を壊すので置かないこと
- variant に field を新設するときは、生成コードの見た目に影響するなら
  構築子のハッシュ式に必ず含める(module ヘッダの契約④に明文化)

## 関連

[[ADR-0041]](instanced バッチの count をパスハッシュに含める — 本 ADR が
一般化した構造的リスクの記録)/ [[ADR-0042]](パイプライン・バインド
グループのキャッシュ — pass.hash がキャッシュキーとして正しいことに依存)/
[[ADR-0008]](数値リテラルの uniform 昇格 — programHash による高速経路と
uniform layout の意味論)
