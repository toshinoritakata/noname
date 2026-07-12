# ADR-0046: コンパイラ Worker のクラッシュ/ハングから復旧する

- Status: accepted
- Date: 2026-07-12

## Context

`CompilerClient`(`src/runtime/compiler-client.ts`)は `compile()` の
Promise を Worker からの `message` イベントでしか解決していなかった。
Worker がクラッシュする、または応答せずハングすると Promise は永久に
解決せず、呼び出し元 `Renderer.evaluate()` を `await` している
`main.ts` の `runEvaluate()` が `evaluating` フラグを立てたまま戻れなくなる。
`runEvaluate()` は「実行中なら次を1回だけ予約する」coalescing 方式
([[ADR-0028]] 決定1)のため、`evaluating` が真のまま固まると以後の
`scheduleEvaluate()`/Shift+Enter が全て早期 return し、**編集が一切
反映されなくなる**。[[ADR-0010]] の「エラー時も直前の映像を維持する」が
効いて画面は止まらないため、この状態は気づきにくい。

Worker 側(`src/compiler/worker.ts`)にも対になる欠陥があった:
`self.addEventListener("message", (ev) => { void handle(ev.data); })` の
`handle` は async で、`compile()` が例外を投げると Worker 内の
unhandled rejection になるだけで親側の `Worker.onerror`(同期エラー専用)
は発火しない。つまり最も起きやすいクラッシュ経路(コンパイラのバグに
よる素の `throw`)が親側に一切通知されない盲点があった。

## Decision

**Worker 側**(`worker.ts`): `handle()` 内の `compile()` 呼び出しを
try/catch で包み、例外を通常の `CompileResult`(`program: null` +
error diagnostic)として `postMessage` する。GLSL フロントエンド読み込み
失敗時に既にあった同型のエラー diagnostic パターンに合わせた。

**親側**(`compiler-client.ts`): 3つの安全弁を追加する。

1. `worker.addEventListener("error"/"messageerror", ...)` — 同期クラッシュ
   時に発火する経路を捕まえる
2. `compile()` ごとに 15 秒のタイムアウト — 上記1で捕まらない真のハング
   (無限ループ等)への安全弁
3. `failAll(message)` — 待機中の全 `Pending` をエラー `CompileResult` で
   resolve → `evaluating` の恒久ロックを解消し、`worker.terminate()` +
   再生成で以後の `compile()` が新しい Worker で続行できるようにする。
   1・2 のどちらからもこの1関数に集約し、タイムアウト経路も
   (ハングした Worker が CPU を食い続けたまま以後毎回タイムアウトする
   ことのないよう)必ず Worker を作り直す

## Consequences

- ✅ Worker が例外・クラッシュ・ハングのいずれで壊れても `evaluate()` が
  有限時間で解決し、`evaluating` フラグの恒久ロック(=編集が二度と
  反映されない状態)が起きなくなる
- ✅ コンパイラのバグによる素の `throw` が実際の例外メッセージつきで
  診断として表面化するようになる(以前は 15 秒タイムアウトまで気づけず、
  メッセージも失われていた)
- ✅ ハングした Worker を放置せず terminate+再生成するため、無限ループの
  バグを踏んでも以後のセッションは(状態は失うが)使用可能なまま続く
- ✅ 回帰テスト: `npm test`(192→193件)は既存 golden に影響なし。
  Worker 自体は `node --test` 環境にグローバル `Worker`(WHATWG 版)が
  無く直接のユニットテストは書けなかったため、ブラウザでの目視確認が
  今後の課題として残る
- ⚠️ `failAll` は待機中の全リクエストを一律エラーにする。`main.ts` 側は
  reserve-one 制御([[ADR-0028]])のため実質同時 pending は1件だが、
  将来複数同時発行するコードが増えた場合は「1件のハングが他の正常な
  リクエストも巻き添えにする」点に注意が必要
- ⚠️ ブラウザでの実クラッシュ/ハング再現による目視確認は未実施

## 関連

[[ADR-0010]](エラー時も直前の映像を維持する)/ [[ADR-0028]](ランタイムの
ホットスワップ経路補強、reserve-one coalescing の元ネタ)
