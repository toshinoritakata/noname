# アーキテクチャ図集(mermaid)

implementation.md / docs/adr/ の設計を図として固定したもの。文章と食い違ったら文章側が正。

## 1. システム全景

3層構造。全部 TypeScript・ブラウザ内(ADR-0006)。

```mermaid
flowchart TD
    subgraph Editor["Editor (CodeMirror 6)"]
        SRC["ソーステキスト"]
        SCRUB["数値スクラブ UI"]
        DIAG["診断のインライン表示"]
    end

    subgraph Compiler["Compiler (TypeScript, ブラウザ内)"]
        PARSE["1 Lexer / Parser"]
        DESUGAR["2 Desugar"]
        TYPE["3 型推論 (HM制限版+次元多相)"]
        STAGE["4 Staging (部分評価)"]
        SPLIT["5 パス分割"]
        CODEGEN["6 WGSL 生成"]
    end

    subgraph Runtime["Runtime (TypeScript + WebGPU)"]
        SLOTS["ProgramSlot ×2"]
        REG["BufferRegistry"]
        CLOCK["Clock: time / etime"]
        INPUT["InputAdapter 群"]
        LOOP["フレームループ"]
    end

    SRC -->|"Shift+Enter"| PARSE
    PARSE --> DESUGAR --> TYPE --> STAGE --> SPLIT --> CODEGEN
    CODEGEN -->|"RenderGraph + WGSL + uniform表"| SLOTS
    PARSE -.->|"エラー: 診断のみ、映像は継続 (ADR-0010)"| DIAG
    SCRUB -.->|"uniform 直接更新 (再コンパイルなし)"| LOOP
    SLOTS --> LOOP
    REG --> LOOP
    CLOCK --> LOOP
    INPUT --> LOOP
    LOOP -->|"画面"| SCREEN(["Canvas"])
```

## 2. コンパイルパイプライン(中間表現と最適化)

```mermaid
flowchart LR
    SRC["ソース"] --> AST["AST<br/>(全ノードに span)"]
    AST --> CORE["Core<br/>(パイプ・糖衣を展開)"]
    CORE --> TCORE["型付き Core"]
    TCORE --> IR["Field IR<br/>(一階・純粋な式 DAG)"]
    IR --> RG["RenderGraph<br/>(パスの DAG)"]
    RG --> WGSL["WGSL + uniform 表<br/>(パスごと)"]

    subgraph Staging["Staging (ADR-0007)"]
        S1["β簡約 (全インライン)"]
        S2["ループ展開<br/>大きな N は WGSL for 文に"]
        S3["次元多相の単相化 (2D/3D)"]
        S4["hash-consing (CSE 兼用)"]
    end
    TCORE -.- Staging -.- IR

    IR -->|"リテラル → uniform 昇格 (ADR-0008)"| WGSL
    IR -->|"パス単位ハッシュ比較 → 差分再コンパイル"| RG
```

## 3. 型の流れ(言語のパイプラインは型のパイプライン)

```mermaid
flowchart LR
    P["プリミティブ<br/>circle / sphere / noise"] --> SH["Shape d<br/>{dist, colour}"]
    SH -->|"warp 族: move rot twist repeat"| SH
    SH -->|"合成: <+> blendAll morph"| SH
    SH -->|"fill / shade (colour 差し替え)"| SH
    SH -->|"render cam (3D) / flatten (2D)"| IMG["Image"]
    IMG -->|"ポスト: bloom grain vignette"| IMG
    IMG -->|"&lt;over&gt; (レイヤ合成)"| IMG
    IMG --> OUT["out ... &lt;&gt; dur"]
    PREV["prev (前フレーム)"] --> IMG
    SIM["simulate (場の進化)"] -->|"ramp 等で可視化"| IMG
    SIG["Signal: time etime audio.* tuio.*"] -.->|"すべての引数に暗黙に流れる"| SH
```

## 4. RenderGraph の例(例12: simulate + 3D + prev + ポスト)

```mermaid
flowchart TD
    subgraph Registry["BufferRegistry が所有 (スロット非依存)"]
        PP["simulate ピンポン対<br/>(rgba16f ×2)"]
        PREVTEX["prev テクスチャ"]
    end

    SIMP["SimulatePass<br/>更新則シェーダ"] -->|"write"| PP
    PP -->|"read (前ステップ)"| SIMP
    PP -->|"read"| RAY["RaymarchPass<br/>dist/colour 継ぎ足しテンプレート"]
    RAY --> IMGP["ImagePass<br/>&lt;over&gt;・ポストは可能な限り融合"]
    PREVTEX -->|"read"| IMGP
    IMGP --> BLEND["BlendPass<br/>旧スロット出力と mix"]
    BLEND -->|"書き戻し (新旧から見て一貫)"| PREVTEX
    BLEND --> SCREEN(["画面"])
```

## 5. ホットスワップのシーケンス(ADR-0004, 0010)

```mermaid
sequenceDiagram
    participant E as Editor
    participant C as Compiler
    participant B as SlotB (新)
    participant A as SlotA (現行)
    participant R as BufferRegistry
    participant S as 画面

    Note over A,S: SlotA が描画し続ける (フレーム落ちなしが至上命題)
    E->>C: Shift+Enter (評価)
    alt パース/型エラー
        C-->>E: 診断のみ表示
        Note over A,S: 映像は SlotA のまま継続 (TidalCycles 方式)
    else 成功
        C->>B: RenderGraph + WGSL (非同期コンパイル)
        Note over A,S: コンパイル中も SlotA が描画
        B->>R: simulate/prev を「束縛名+型」で照合
        R-->>B: 一致 → 場の中身を保持して更新則だけ差し替え
        B->>S: 準備完了
        loop dur 秒 (out ... <> dur)
            A->>S: 旧出力
            B->>S: 新出力
            Note over S: BlendPass が mix (0→1)
        end
        Note over A: フェード完了後リソース解放 (Registry の中身は除く)
    end
```

## 6. 状態の所有権(「プログラムは使い捨て、状態は永続」)

```mermaid
flowchart LR
    subgraph Disposable["使い捨て (評価ごとに作り直す)"]
        SA["SlotA: パイプライン・シェーダ"]
        SB["SlotB: パイプライン・シェーダ"]
    end
    subgraph Persistent["永続 (スワップを跨いで保持)"]
        REG["BufferRegistry"]
        T1["simulate テクスチャ対<br/>キー: 束縛名+型"]
        T2["prev テクスチャ"]
        CLK["Clock: time (単調・リセットなし)"]
        REG --- T1
        REG --- T2
    end
    SA -->|"read/write"| REG
    SB -->|"read/write"| REG
    SB -->|"キー照合: 一致なら中身保持<br/>サイズ変更ならリサンプル"| T1
```

## 7. 入力の2正規形と InputAdapter(ADR-0012)

```mermaid
flowchart LR
    subgraph Sources["入力源"]
        MOUSE["mouse"]
        MIDI["Web MIDI"]
        AUDIO["Web Audio AnalyserNode"]
        GP["gamepad"]
        TUIO["TUIO (OSC/UDP)"]
    end
    BRIDGE["UDP→WebSocket 中継<br/>(ローカル・TUIO 系のみ)"]
    TUIO --> BRIDGE

    subgraph Adapters["InputAdapter { name, schema, writeFrame }"]
        A1["mouse アダプタ"]
        A2["midi アダプタ"]
        A3["audio アダプタ"]
        A4["gamepad アダプタ"]
        A5["tuio アダプタ"]
    end
    MOUSE --> A1
    MIDI --> A2
    AUDIO --> A3
    GP --> A4
    BRIDGE --> A5

    subgraph Normal["2つの正規形 (毎フレーム書き込み)"]
        U["スカラー uniform<br/>mouse.x / audio.lo / midi.cc"]
        ET["エンティティ表テクスチャ<br/>最大 N スロット+alive<br/>fft / tuio.cursor / 骨格"]
    end
    A1 --> U
    A2 --> U
    A3 --> U
    A3 --> ET
    A4 --> ET
    A5 --> ET
    U --> SH["生成シェーダ"]
    ET --> SH
    Adapters -.->|"コンパイラは schema しか見ない"| SH
```

## 8. 物理シミュレーションの3段(ADR-0003 追記)

```mermaid
flowchart TD
    PHYS["物理表現"] --> T1["第1段: 閉形式の運動<br/>(シード, 経過時間) の純粋関数<br/>状態なし・数千個 (例10)"]
    PHYS --> T2["第2段: gather 型 simulate<br/>反応拡散・流体・布・粒子積分<br/>SDF 衝突 dist/grad (例6, 例12)"]
    PHYS --> T3["第3段: scatter/ソート/アトミック<br/>大規模 SPH・拘束付き剛体"]
    T1 -->|"設計済み"| OK1(["✅"])
    T2 -->|"設計済み"| OK2(["✅"])
    T3 -->|"意識的な範囲外<br/>拡張経路: SimulatePass の compute 化"| DEFER(["⏸ 延期 (ADR-0013 と同趣旨)"])
```

## 9. マイルストーン(垂直に切る)

```mermaid
flowchart LR
    M0["M0 例1のみ<br/>パーサ→WGSL→表示<br/>ホットスワップ+&lt;&gt;+uniform昇格<br/>★ライブの体感を検証"]
    M1["M1 2D SDF 代数<br/>warp族・&lt;+&gt;・morph・fill"]
    M2["M2 grid/scatter 展開<br/>let 多相・次元多相"]
    M3["M3 3D<br/>render・shade・レイマーチャ"]
    M4["M4 prev + simulate<br/>BufferRegistry"]
    M5["M5 入力+tempo<br/>InputAdapter (TUIO 含む)"]
    M6["M6 FFI<br/>wgsl → glsl/shadertoy"]
    M0 --> M1 --> M2 --> M3 --> M4 --> M5 --> M6
    M0 -.->|"体感が出なければ設計に戻る"| M0
```
