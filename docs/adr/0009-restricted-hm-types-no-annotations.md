# ADR-0009: 型は Hindley-Milner 制限版+次元多相、注釈レスで書ける全域言語とする

- Status: accepted
- Date: 2026-07-04

## Context

型は `Field / Shape / Image / Signal` の4系に潰れる(dream-code.md)。GPU コンパイル
(ADR-0007)のためには静的型が必要だが、ライブコーディングで型注釈を書かせたくない。

## Decision

- **HM の制限版**: let 多相あり、高階の型変数なし、一般再帰なし(全域言語)。推論は W アルゴリズム
- **次元多相**: `move` や `<+>` は 2D/3D 両用。次元変数 `d ∈ {2,3}` の制限付き多相として
  推論し、Staging で単相化
- **スカラー昇格**: `Float` → 定数場、`Float` と `Signal Float` の区別はユーザーに見せない
  (すべての値が暗黙にシグナル)
- 型注釈は不要(FFI ブロックの型宣言を除く。ADR-0011)
- エラーメッセージはドメイン語彙に言い換える(`Field 2 Color` → 「2Dの色場(Image)」)。
  単一化失敗時は期待側・実際側両方の由来 span を示す

## Consequences

- ✅ ユーザーは型システムの存在をほぼ意識せずに書ける
- ✅ 全域性+静的型で Staging の停止と WGSL 生成が保証される
- ⚠️ 注釈レスの代償はエラーメッセージの質で払う — ここが UX の勝負どころ
- ⚠️ ADT・パターンマッチ・型クラスは当面持たない(必要になったら別 ADR で再訪)

## 関連

dream-code.md 総括 / implementation.md 2章 / [[ADR-0007]]
