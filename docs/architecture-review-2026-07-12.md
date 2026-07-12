# アーキテクチャレビュー検証記録 — 2026-07-12

`/improve-codebase-architecture` による探索(Explore agent ×2)で挙がった6候補を、
**全て一次ソース(コード実読)で検証**した記録。エージェント報告の誤り・過大主張は訂正済み。
用語は module / interface / seam / deep / shallow / locality / leverage を厳密に使う。

HTML 版(図付き): `$TMPDIR/architecture-review-20260712-095421.html`(一時ディレクトリ、揮発)

## 検証後の総合順位

| # | 候補 | 初版 | 検証後 | 判定 |
|---|------|------|--------|------|
| 2 | CompiledPass をパス契約 module に | Strong | **Strong** | 全主張再現、根拠強化。**Top recommendation** |
| 4 | ホットスワップ状態機械の純粋 module 抽出 | Worth exploring | Worth exploring | 妥当。付随して実バグ発見(下記) |
| 6 | wgsl.ts からループ巻き上げ(IR→IR)分離 | Speculative | **Worth exploring(昇格)** | test surface 不在が判明し根拠強化 |
| 3 | InputAdapter を本物の seam に | Strong | **Worth exploring(降格)** | friction 実在だが解決策を消費側に縮小 |
| 5 | Shape 副チャンネル配管の subsystem 化 | Worth exploring | Worth exploring | 「9表現→1概念」は過大。3段階の漸進に縮小 |
| 1 | builtin 登録の一枚テーブル化 | Strong | **撤回→縮小版のみ** | 構造的前提が3つ崩壊(下記) |

即効の独立タスク(候補の採否と無関係):
1. **compiler-client.ts に reject 経路を追加**(実バグ、候補4の検証で確定)
2. 候補1縮小版の coverage テスト(infer↔stdlib 名前一致)

---

## 候補1: builtin 登録の一枚テーブル化 — 撤回

初版の「infer / stdlib / wgsl-lib / interp の4レジストリを1レコードに統合」は再検証で撤回。

崩れた前提:
1. **4つのレジストリは同じ level に居ない。** stdlib builtin ↔ WGSL LIB helper は多対多
   (`noise`→`noise2d`/`noise3d`、`checker`/`brick` は helper 0件で純IR、`hash11` は多数の
   builtin が共有)。長方形のレコードは存在しない(stdlib/noise.ts 全体、wgsl-lib.ts:5)。
2. **infer のスキーム表は既に deep module。** `builtinSchemes()`(infer.ts:310)は family
   ループ(数学11種・色定数14種・postfx 6種が各1〜3行)で compact に書かれ、型システム
   全体を1関数で監査できる。builtin ごとに分解すると11ファイルに散った95記述に爆発する。
3. **スキーム欠落は crash しない。** `lookupVar`(infer.ts:509-512)が fresh 型変数に
   fallback し、未定義エラーは staging が報告(ADR-0009 の設計通り)。危険度は「silent に
   型検査の網が痩せる」であり「わかりにくいクラッシュ」ではない。
4. **既に一度検討され縮小されている。** `test/builtin-wgsl-coverage.test.ts` のヘッダが
   「改善提案『builtin 登録を deep interface に集約する』の**安全なスコープ版**」と自ら明記。

### 生き残る縮小版
- **helper level**: LIB は純データ `{deps?, src}` なので任意の `cpu?` を追加し、interp.ts の
  影実装(hash11/noise2d/fbm2 等 ~150行)を移住、`cpu` を持つエントリに WGSL↔JS 数値
  parity テストを自動生成。ADR-0039 で実際に払った「両側手修正」コストと silent drift が消える。
  f32/f64 差は fround+許容誤差で吸収(hash 系は既に fround 済、interp.ts:207-221)。
- **builtin level**: `buildTable()` の全名 ⊆ `builtinSchemes()` ∪ 明示 allowlist を assert
  する coverage テスト1枚(~40行)。構造は動かさない。

---

## 候補2: CompiledPass をパス契約 module に — 妥当(Strong 維持、Top)

### 検証済みの証拠
- `CompiledPass`(wgsl.ts:26-69): 11-way kind × 14 optional field。kind↔field 有効性は型に無い。
- runtime が契約を手で再導出: kind別8ループと `!` 参照(program.ts:307-386)、bloom の
  3重 undefined ガード(program.ts:202-213)。
- uniform layout の二重知識: wgsl.ts:591 `header: vec4f, slots: array<vec4f,N>` ↔
  program.ts:46 `4 + slotCount*4`・:224-228 `d[4+literalBase+i]`。
- binding 規約の二重実装: wgsl.ts:597-603(@binding(0)/(1)/(i+2))↔ program.ts:101-111・:261-265。
- パス依存順はコメント頼み(program.ts:372-373「並び順どおりに実行すればよい」)。
- **決定打 = ADR-0041 の Consequences 欄自身**が「同種のバグは新しい instanced 描画の
  種類を追加するたびに再発しうる構造的リスク。新設するパスでは hash の完全性を都度確認する
  必要がある」と手動監査の継続を明記している。

### 解決策(検証で精緻化)
tex-keys.ts と同型の契約 module に、kind別 discriminated union+uniform offset 計算+
binding 割当+**パスハッシュ計算**を集約。emitter は型付き構築子で作り、ProgramSlot は
kind で narrow して読む。ハッシュを構築子が所有すれば ADR-0041 の「都度確認」が構造保証になる。

境界の正直な線引き: CompiledProgram は Worker を postMessage で越える純データなので union 化に
障害なし。execute() の kind 間オーケストレーション(sprite→spriteRmId の rmTex 等)や
blend/topology 選択(program.ts:142-160)は runtime 固有として残る。

---

## 候補3: InputAdapter を本物の seam に — friction 実在、解決策を縮小(降格)

### 確認済み
- ADR-0012 の seam を通るのは TUIO/OSC のみ。mouse/audio/MIDI/webcam/ws は bespoke:
  public field `fftTexture`(inputs.ts:75)/`camTexture`(:84)、`setWsSource`(:247)、
  `onAudioState/onCameraState/onWsState` コールバック。
- renderer の二重テクスチャキー語彙: `resolveExtra` に `"fft"/"cam"/"text:"/"ent:"` ハードコード
  (renderer.ts:203-215)+ `usesFft/usesTexture("cam")`(:143-149)。`ent:` は inputs.ts:360 でも独立定義。
- `ensure()` の bespoke 起床判定(inputs.ts:141-160)。

### 降格理由
1. bespoke 経路の差は本質的: audio/cam は権限要求つき非同期 init+UI状態通知、ws は UI 設定値、
   cam は可変解像度 `copyExternalImageToTexture`(EntityTable の固定長 writeTexture では表現不能)、
   mouse は canvas 要素+アスペクト補正。全部を1 interface に押し込むと interface が5実装の合併と
   同じ幅になる(shallow 化の逆流)。ADR-0030 は webcam を意図的な第3ケースとした accepted な決定。
2. `getInputFor()` switch の過半(time/etime/etimeF/dt/spb/cps/px)は入力ではなく Clock/スロット
   固有値(etime は `slot.evalTime` 依存、renderer.ts:157-159)で InputEngine に移せない。

### 縮小後の本体
消費側の統一 — 入力テクスチャキーを registry に合流させ `resolveExtra` の switch と文字列二重定義を
消す。`ensure()` を「名前パターン→サブシステム」の宣言表に。供給側 adapter 化は interface が自然に
合うものだけ機会的に。ADR-0012 に第3正規形(sample texture)を追記して整合を取る。

---

## 候補4: ホットスワップ状態機械の純粋 module 抽出 — 妥当(維持)

### 確認済み
- フェード開始は `evaluate()`(renderer.ts:130-138)、完了は `frame()`(:194-201)、
  reserve-one と debounce は main.ts(:148-186)、device.lost ポリシーも main.ts(:82-92)に分裂。
- renderer が slot の public field を読み書き: `slot.evalTime/fadeEndTime` 書込(renderer.ts:134-138)、
  `.colorTex!`(:231-232)、`.sampler`(:249)— フェード時刻の所有が分裂。
- runtime のテストは `matchSim`(registry)のみ。純関数として抽出済みの唯一の箇所だけが
  テストされている事実は、抽出→テスト可能の証拠。

### 実バグ(採否と無関係に修正すべき)
compiler-client.ts に reject / onerror / timeout が一切ない(pending の resolve のみ、:26-32)。
Worker がクラッシュすると `await renderer.evaluate()` が永久に返らず、main.ts の `evaluating` が
true のまま **以後の全評価が黙って無視される**(runEvaluate は早期 return、main.ts:151-153)。
映像は止まらない(ADR-0010)が「編集が二度と反映されない」状態になる。

### 正直な規模感
純粋な遷移判断はフェード ~15行+世代チェック ~5行+reserve-one ~10行+lost ~10行。
フル event→command 機構は骨組み過多になりうる。スコープは「swap+eval スケジューリングの
1 module」に留め、2 adapter(rAF/GPU/Worker と手回しクロック/fake compile)で seam を実在化。
狙いは leverage(caller は1つ)ではなく locality とテスト可能性。

---

## 候補5: Shape 副チャンネル配管の subsystem 化 — 実在、解決策を縮小(維持)

### 確認済み
- マーカー field 生アクセス数を grep で完全一致再確認: ops 23(helper 本体)/ iteration 18 /
  shapes 9 / physics3d 8 / wgsl 5 / color 5 / stage 2。
- iteration.ts:157-161 の「この崖を実際に踏んで気づいた」自認コメント。
- ops.ts は38 export・6関心の grab-bag(値構築/coerce/const-fold/lift/batch配管/sim-state)。

### 訂正2点
1. `StripBatchSpec` と `Strip3BatchSpec` は field 名まで完全同一(vec2/vec3 差のみ、
   value.ts:150-169)で統一自明。しかし `SpriteBatchSpec` は形が違う(centerRadiusIR/colourIR)。
   統一できるのは strip 2系統→1 であり、「9表現→1概念」は過大。
2. 「move/fill/glow 以外は引き継がない=安全にフォールバック」は value.ts に明記された
   **意図的な設計**(非伝播が安全弁)。centralize はこの per-合成子 opt-in 意味論を保存する必要がある。

### 縮小後の手順
① Strip/Strip3 spec 型統合 → ② ops.ts の batch+lift クラスタを shape-channels module へ →
③ iteration.ts の18箇所を named operation 経由に移行。strip-batch-propagation.test を一般化しながら漸進。

---

## 候補6: wgsl.ts からループ巻き上げ(IR→IR)を分離 — 妥当(Speculative→Worth exploring に昇格)

### 確認済み・昇格理由
- `transformLoops/hoistLoopBody`(wgsl.ts:410-546)は純粋な IR→IR(依存解析・演算量による候補
  選定・vec4 チャネル詰めは ir.ts の `padOffset/buildVec4Roots` を共用・fetch への書換)。
  WGSL 固有知識はコスト閾値のみ(cost model であって構文知識ではない)。抽出は clean。
- **昇格の決め手**: この変換は staging の後・generateWGSL の内部で走るため、IR golden
  (staging 出力を pin)は巻き上げ結果をカバーしない — 巻き上げ判断には直接の test surface が
  今日存在しない。抽出すれば既存の IR dump 機構がそのまま golden になる。

### 訂正
「WGSL 出力の guard が弱い」は言い過ぎ。wgsl.test.ts は全23例の生成 WGSL を wgsl_reflect で
パースし、ADR-0017 型バグを狙った独自の生成変数スコープ検査(`checkGeneratedVarScoping`)を持つ。
WGSL テキスト golden は emitter 変更のたびに23枚無効化される churn があり、必須ではなくオプション。

---

## メタ所見

- 探索エージェントの報告は方向性は正確だったが、**解決策の粒度で3件過大**だった(候補1の
  「一枚テーブル」、候補3の「全入力 adapter 化」、候補5の「9表現→1概念」)。いずれも
  「friction の実在」と「提案した interface が構造に合うか」は別の検証であり、後者は
  一次ソースの実読でしか確定しない。
- 逆に候補2・6は実読で根拠が**強まった**(ADR-0041 の Consequences、巻き上げの test surface 不在)。
- 検証中に発見した独立バグ1件: compiler-client.ts の reject 経路欠如(上記候補4)。
