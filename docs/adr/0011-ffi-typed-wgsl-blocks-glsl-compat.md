# ADR-0011: FFI は型注釈付き WGSL ブロックを一級とし、GLSL/Shadertoy は互換層で受ける

- Status: accepted
- Date: 2026-07-04

## Context

新言語はエコシステムを持たない。一方 Shadertoy には世界最大級のシェーダ作品群があり、
手書き GLSL 資産を持つユーザーも多い。本言語は全体が WGSL に落ちる(ADR-0007)ため、
外来シェーダコードとの境界にマーシャリングコストが存在しない。

## Decision

二段構えの FFI:

1. **`wgsl (型) """..."""`** — 一級市民。型注釈が翻訳規約を決める
   (`Field 2 Float` → `fn(p: vec2f, t: f32) -> f32` 等)。中身は不透明ノードとして
   生成シェーダに継ぎ足す。型ごとに機械的な対応があるため、外来値にも
   `warp`/`twist`/`blendAll` 等の合成子がすべて効く
2. **`glsl` / `shadertoy`** — naga(wasm、遅延ロード)の GLSL フロントエンドで変換して
   1 と同じ扱い。`shadertoy` は `iTime/iResolution/iMouse` のシムを注入し
   `mainImage` を `Image` 型にラップ — Shadertoy がコピペで素材になる

## Consequences

- ✅ 境界コストゼロ(生成シェーダへの継ぎ足しのみ、インライン化で呼び出しも消える)
- ✅ 既存資産(Shadertoy/GLSL)を吸えるため、新言語の採用障壁が下がる
- ⚠️ 型注釈の正しさは信用ベース。ただしシグネチャ不一致はシェーダコンパイル時に必ず検出される
- ⚠️ Lipschitz 規律(ADR-0002)は外来ブロックでは検査不能 → 責任範囲を文書で明示
- ⚠️ naga-wasm はサイズが大きい → glsl ブロック初遭遇時の遅延ロード

## 関連

dream-code.md 例11 / implementation.md 6章 / [[ADR-0002]] [[ADR-0007]]
