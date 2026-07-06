# ADR-0002: Shape は dist と colour を持つレコード、時間は暗黙の第4座標

- Status: accepted
- Date: 2026-07-04

## Context

当初案は `Shape = Point -> Dist` と `fill : Shape -> Image` の分離だったが、
グリッドのセルごとに色を変える(夢のコード例2)と「合成後の図形からセル情報を取り出す」
不自然さが生じた(図形と色の結婚問題)。先行研究調査で Curv が
`{dist: (x,y,z,t)→距離, colour: (x,y,z,t)→RGB}` のレコード表現を実証していることが判明。

## Decision

Curv 方式を継承する:

```
Shape = { dist : Field Dist, colour : Field Color }
```

時間はすべての場(Field)の**暗黙の第4座標**とする。
`fill` は colour フィールドの差し替え、`morph` は dist と colour の同時補間として定義。

## Consequences

- ✅ 彩色が個体生成ラムダの内側で完結し、彩色済み Shape 同士も全合成子(`<+>`/`grid`/`morph`)で合成できる
- ✅ 時間変換(`slow`/`loop`)が空間変換と同じ「座標の再マップ」で実装できる
- ✅ 彩色済み図形同士の滑らかなモーフが自然に定義される
- ⚠️ SDF には Lipschitz 規律(定数 ≤ 1)が望ましいが、`warp` や FFI が破り得る
  → レイマーチ歩幅に安全係数 0.8 を掛けて「壊れても絵になる」方向に倒す(暫定解)
- bbox(Curv は保持)は当面持たない。ライブ用途では無限に広がる場が多いため

## 関連

dream-code.md 総括 / prior-art.md(Curv の Shape プロトコル)/ [[ADR-0011]]
