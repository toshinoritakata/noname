# noname-osc-bridge

汎用 OSC コントローラ(TouchOSC/Lemur等)を noname に繋ぐための、完全に
オプションの中継ヘルパー。詳しい設計根拠は
[docs/adr/0029-osc-input-via-bridge-helper.md](../docs/adr/0029-osc-input-via-bridge-helper.md)
を参照。

noname 本体(ブラウザ)はこのブリッジなしで動く。OSC を使う作品を演奏する
時だけ、別プロセスとしてこれを起動しておく。

## 使い方

```bash
cargo run --release
```

- UDP `0.0.0.0:9000` で OSC メッセージを受信する
- アドレス末尾の数字をスロット番号(0〜31)とみなし、最初の引数を値として
  読む(例: `/1/fader3 0.75` → スロット3に0.75)
- WebSocket `ws://127.0.0.1:3334` で、値が変わるたびに32要素の現在値
  スナップショットを JSON 配列として全クライアントへ送る

noname 側では `renderer.inputs.registerAdapter(makeOscAdapter())`
(`src/main.ts`)で接続し、言語からは `osc.f 0` 〜 `osc.f 31` で読める。

## テスト

```bash
cargo test
```
