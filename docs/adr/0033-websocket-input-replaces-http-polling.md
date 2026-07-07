# ADR-0033: WebSocket 入力を追加し、HTTPポーリング(ADR-0031)を置き換える

- Status: accepted
- Date: 2026-07-07

## Context

[[ADR-0031]] で実装した HTTP(JSON)入力は5秒間隔のポーリングだった。
ライブ演奏用途には反応が遅すぎる(センサー値やコントローラ値の変化を
すぐ映像に反映したい)という指摘を受け、HTTPポーリングを廃止し、
持続接続でサーバ側から push された値を即座に反映できる WebSocket 入力に
置き換える。

設計判断は ADR-0031 からほぼそのまま引き継ぐ:

- **URLはUIで設定、言語側は固定名スカラー**という判断は変えない
  (ADR-0031 の該当理由をそのまま踏襲: URLは「作品ロジック」ではなく
  実行環境の設定に近い)
- データの種類はJSON数値のみ(ADR-0031と同じ)
- 変わるのは**取得方式**だけ: 定期ポーリング(`fetch` を5秒ごと)→
  持続接続(`WebSocket`、サーバがpushした瞬間に反映)

## Decision

`src/runtime/inputs.ts` の `InputEngine.setHttpSource(url, path)` を
`setWsSource(url, path)` に置き換える:

- `url` が空なら既存の接続を閉じるだけ(前回値は保持、ADR-0010 の精神)
- 空でなければ `new WebSocket(url)` を張り、`onmessage` で受信するたびに
  `JSON.parse` → `getJsonPath(obj, path)`(ADR-0031 と同じドット区切り
  パスヘルパー、そのまま流用)で数値を取り出し、数値でなければ前回値を
  保持してステータスにその旨を出す。`onerror`/`onclose` もステータスに
  反映する(再接続は行わない、TUIO/OSCアダプタと同じ簡潔さ)
- 取得した値は `values.set("ws.value", ...)` として毎フレーム無条件で書く
  (`http.value` と同じ扱い)
- 言語側(`src/compiler/stdlib/inputs.ts`)は `http.value` を削除し
  `ws.value`(`Float`)を追加
- `index.html` のテキストボックスを「Data URL」→「WebSocket URL」に変更
  (JSON pathは変更なし)

## Consequences

- ✅ サーバ側からのpushが即座に(次フレームで)反映される。5秒の遅延がなくなる
- ✅ ADR-0031 のCORS制約(相手のAPIがCORSを許可しないと `fetch` が失敗する)
  から解放される。WebSocketは同一オリジン制約を受けない(ただしサーバ側が
  WebSocketで待ち受けている必要があり、任意の既存HTTP JSONエンドポイントを
  そのまま使うことはできなくなった — 用途が「自分でWebSocketサーバを
  用意できるデータソース」に変わる点はトレードオフ)
- ✅ ポーリング間隔という概念自体が無くなる(設定不要)
- ⚠️ 再接続ロジックは持たない(切断されたら手動でURLを再設定する必要がある。
  TUIO/OSCアダプタと同じ割り切り)
- ⚠️ 任意の公開JSON API(天気・価格等の一般的なREST API)は基本的に
  WebSocketを話さないため、ADR-0031が想定していたユースケースの一部は
  直接には使えなくなる(必要ならユーザー側でHTTP→WebSocketの小さな
  中継を用意する形になる。ADR-0029のOSCブリッジと同じ発想)

## 関連

[[ADR-0010]](エラー時も直前の値を維持する精神)/ [[ADR-0012]](2正規形+
InputAdapter)/ [[ADR-0028]](device.lost 再初期化)/ [[ADR-0029]]
(同種の「持続接続でpushを受ける」ローカル中継パターン)/ [[ADR-0031]]
(置き換え元。URLをUIに置くという判断はここから引き継いだ)
