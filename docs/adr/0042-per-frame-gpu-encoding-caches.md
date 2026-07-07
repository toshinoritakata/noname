# ADR-0042: フレームごとのGPUエンコード負荷を削減する(ビュー/バインドグループのキャッシュ)

- Status: accepted
- Date: 2026-07-07

## Context

「全体的にレンダリングを高速化できるか」という検討要請を受け、レンダリング
パイプライン(`src/runtime/program.ts`/`renderer.ts`)を調査したところ、
**毎フレーム同じ結果になるはずのCPU側エンコード作業を毎フレーム律儀に
やり直している箇所**が複数見つかった。フレームごとのGPU/CPUコストを
監視するテストは今のところ無い(`test/latency.test.ts`はコンパイル所要
時間のみ)ため、いずれも実測ではなく構造的な無駄として見つけたもの。

具体的には:

1. `ProgramSlot.bindGroup()` が **draw() 呼び出し1回ごと**に
   `pipeline.getBindGroupLayout(0)` の再取得と `device.createBindGroup(...)`
   を行っていた。bloomが絡む構成では1フレームに数十パスあり、
   クロスフェード中は新旧2スロット分で倍になる
2. `execute()` 内のあらゆる箇所(`resolve` クロージャ、data/sim/raymarch/
   sprite/strip3d/bloom/image/strip の各draw呼び出し)で `texture.createView()`
   を毎フレーム呼んでいた。これらのテクスチャは `ensureTargets`/
   `swapSim`/`swapPrev` のタイミングでしか実体が変わらない
3. `renderer.ts` の `frame()` がクロスフェード用の `Float32Array` を
   毎フレーム new し、blend用のバインドグループを(canvasとprevの2箇所)
   毎フレーム作り直していた

これらは「形が同じなら再構築しない」という [[ADR-0008]] の設計精神を
GPUリソースのレイヤーでも徹底したもの、と位置づけられる。

## Decision

**ビューのメモ化**(`program.ts`、モジュールレベル):
```ts
const viewCache = new WeakMap<GPUTexture, GPUTextureView>();
export function cachedView(tex: GPUTexture): GPUTextureView { ... }
```
同じ `GPUTexture` オブジェクトに対しては常に同じ `GPUTextureView` を返す。
`WeakMap` なのでテクスチャが `destroy`/GC されれば自然に参照が切れる。
`ProgramSlot` 所有のテクスチャ(rm/bloom/data/color)と `BufferRegistry`
所有のテクスチャ(prev/sim。ping-pong で実体を往復するだけで、実体
そのものは resize まで不変)の両方に安全に使える。**唯一使ってはいけない
のが `context.getCurrentTexture()`**(canvasのスワップチェインは毎フレーム
新しいテクスチャを返すため、キャッシュすると無限にエントリが増える)。

**ビュー識別子とバインドグループのキャッシュ**: `cachedView` の1:1性を前提に、
`viewId(view): number` という連番を各ビューに振る(`program.ts` から
export、`renderer.ts` でも共有)。`ProgramSlot.bindGroup()` は解決した
全テクスチャビューの `viewId` を連結した文字列をキーに `Map<BuiltPass,
Map<string, GPUBindGroup>>` でキャッシュする。prev/sim のように実体が
2つを往復するパスでもキャッシュは高々2エントリで済み、raymarch/bloom/
data/image のような解決先が不変なパスは初回以降ずっとキャッシュヒットする。
`BindGroupLayout` も pass ごとに1回(パイプライン生成時)だけ取得して
`BuiltPass.bindGroupLayout` に保持する(以前は draw() ごとに
`pipeline.getBindGroupLayout(0)` を呼んでいた)。

**ブレンドパス**(`renderer.ts`): フェード係数用の `Float32Array` を
インスタンスフィールドとして再利用する(`this.kBuf`、書き込み先だけ
差し替え)。canvasへの書き戻し(スワップチェインが毎フレーム変わるので
キャッシュ不可)とprevへの書き戻し(実体2つのping-pong、キャッシュ可能)
を明確に分け、後者だけ同じ `viewId` ベースのキーでバインドグループを
キャッシュする(`prevBlendGroupCache`)。

## Consequences

- ✅ 「形が同じ間はGPUリソースを作り直さない」を、パイプライン(既存の
  `PipelineCache`)だけでなくビュー・バインドグループのレイヤーにも
  拡張した。resize/クロスフェード/構造変更(=キャッシュキーが変わる)
  以外では、毎フレームのCPU側エンコード作業がほぼ「バッファ書き込み+
  キャッシュ参照+drawコール」まで削減される
- ✅ resize時の無効化は明示的なコードを書かずに自然に成立する:
  `ensureTargets` がテクスチャを`destroy`+再作成すると、新しい
  `GPUTexture` オブジェクトに対して `cachedView` が新しい `GPUTextureView`
  を返し、`viewId` も新規の番号になるため、キャッシュキーが自動的に
  変わって古いバインドグループ(destroyされたテクスチャを参照する無効な
  もの)を誤って再利用することはない
- ✅ 実機で確認済み: 主要サンプル(脈打つ円/メタボール/トレイル/RD/
  ステートレスパーティクル/跳ねるパーティクル/弦の模様/bloom/TVノイズ/
  text/glitch/3Dワイヤーフレーム)の見た目に変化がないこと、`prev`
  フィードバック(トレイル)を使うシーンでウィンドウをリサイズ→元に戻す
  操作をしても破綻しないことをスクリーンショットで確認
- ⚠️ bloomのアップサンプル(9タップのテントフィルタ)のタップ数削減は
  **見送った**。一般的な「4タップのbilinearで3x3テントを近似する」
  手法(dual/Kawase filtering系)は、オフセットの取り方が現行実装
  (オフセット=srcテクセル1つ分の1-2-1/2-4-2/1-2-1)と異なり、
  有効なブラー半径・形状が変わる(=見た目が変わる)。[[ADR-0019]]が
  記録する「オフセットを間違えて花びら状のエイリアシングが出た」という
  過去の教訓と同じ轍を踏むリスクがあり、数式上の厳密な等価性を示せない
  まま投入するのは避けた。やるなら別セッションで golden 画像による
  ピクセル差分検証込みで取り組むべき

## 関連

[[ADR-0008]](uniform昇格、「形が同じなら再構築しない」の思想の起源)/
[[ADR-0019]](bloomの多パス連鎖、タップ削減を見送った理由の前例)/
[[ADR-0028]](ランタイムのホットスワップ強化。pipelineキャッシュのLRU
上限など、同じ「ライブコーディングは編集し続けるのが前提」という文脈)/
[[ADR-0041]](パスハッシュの構造的な見落とし。今回のキャッシュも
「見た目に影響する要素をキャッシュキーに正しく含めているか」という
同種の注意が要る)
