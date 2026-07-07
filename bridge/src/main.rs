//! noname OSC ブリッジ(ADR-0029)。
//!
//! UDP でOSCメッセージを受信し、アドレス末尾の数字をスロット番号(0..31)とみなして
//! 32要素の float 配列に書く(MIDI CC の固定バンクと同じ発想)。スロット配列に
//! 変化があるたびに、接続中の全 WebSocket クライアントへ現在値のスナップショットを
//! JSON 配列として送る(ブラウザ側は `src/runtime/inputs.ts` の `makeOscAdapter`)。
//!
//! ブラウザ本体(noname)はこのブリッジなしで完全に動作する。OSC を使う作品を
//! 演奏する時だけ、このバイナリを別途起動しておく、という完全にオプションの
//! 常駐プロセス(ADR-0006 の「URL を開けば動く」を壊さない)。

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use rosc::{OscPacket, OscType};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

const SLOTS: usize = 32;
const OSC_PORT: u16 = 9000;
const WS_PORT: u16 = 3334;

/// OSC アドレスの末尾の数字をスロット番号として取り出す(例: "/1/fader3" → 3)。
/// 数字が見つからなければ None
fn slot_from_address(addr: &str) -> Option<usize> {
    let digits: String = addr
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let n: usize = digits.chars().rev().collect::<String>().parse().ok()?;
    if n < SLOTS { Some(n) } else { None }
}

/// OSC メッセージの最初の引数を f32 として読む(Float/Double/Int/Bool に対応)
fn first_arg_as_f32(args: &[OscType]) -> Option<f32> {
    match args.first()? {
        OscType::Float(v) => Some(*v),
        OscType::Double(v) => Some(*v as f32),
        OscType::Int(v) => Some(*v as f32),
        OscType::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn apply_packet(packet: &OscPacket, slots: &mut [f32; SLOTS]) -> bool {
    match packet {
        OscPacket::Message(m) => {
            let (Some(slot), Some(v)) = (slot_from_address(&m.addr), first_arg_as_f32(&m.args))
            else {
                return false;
            };
            slots[slot] = v;
            true
        }
        OscPacket::Bundle(b) => {
            let mut changed = false;
            for p in &b.content {
                changed |= apply_packet(p, slots);
            }
            changed
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let (tx, rx) = watch::channel::<[f32; SLOTS]>([0.0; SLOTS]);

    let udp = UdpSocket::bind(("0.0.0.0", OSC_PORT)).await?;
    println!("noname-osc-bridge: OSC を udp://0.0.0.0:{OSC_PORT} で待ち受け中");
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        let mut slots = [0.0f32; SLOTS];
        loop {
            let Ok((len, _src)) = udp.recv_from(&mut buf).await else {
                continue;
            };
            let Ok((_rest, packet)) = rosc::decoder::decode_udp(&buf[..len]) else {
                continue;
            };
            if apply_packet(&packet, &mut slots) {
                let _ = tx.send(slots);
            }
        }
    });

    let listener = TcpListener::bind(("127.0.0.1", WS_PORT)).await?;
    println!("noname-osc-bridge: WebSocket を ws://127.0.0.1:{WS_PORT} で待ち受け中");
    loop {
        let (stream, peer): (_, SocketAddr) = listener.accept().await?;
        let mut rx = rx.clone();
        tokio::spawn(async move {
            let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                return;
            };
            println!("noname-osc-bridge: クライアント接続 {peer}");
            let (mut write, mut read) = ws.split();
            // 接続直後に現在値を1回送る(await をまたぐ前に watch のガードを手放す)
            let initial = *rx.borrow();
            if write
                .send(Message::Text(
                    serde_json::to_string(&initial).unwrap().into(),
                ))
                .await
                .is_err()
            {
                return;
            }
            loop {
                tokio::select! {
                    changed = rx.changed() => {
                        if changed.is_err() { break; }
                        let snapshot = *rx.borrow();
                        if write.send(Message::Text(serde_json::to_string(&snapshot).unwrap().into())).await.is_err() {
                            break;
                        }
                    }
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(_)) => break,
                            _ => {}
                        }
                    }
                }
            }
            println!("noname-osc-bridge: クライアント切断 {peer}");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_from_address_takes_trailing_digits() {
        assert_eq!(slot_from_address("/1/fader3"), Some(3));
        assert_eq!(slot_from_address("/fader31"), Some(31));
        assert_eq!(slot_from_address("/fader32"), None); // SLOTS の範囲外
        assert_eq!(slot_from_address("/xy"), None);
        assert_eq!(slot_from_address("/1/fader03"), Some(3));
    }

    #[test]
    fn first_arg_as_f32_reads_common_types() {
        assert_eq!(first_arg_as_f32(&[OscType::Float(0.5)]), Some(0.5));
        assert_eq!(first_arg_as_f32(&[OscType::Int(1)]), Some(1.0));
        assert_eq!(first_arg_as_f32(&[OscType::Bool(true)]), Some(1.0));
        assert_eq!(first_arg_as_f32(&[]), None);
        assert_eq!(first_arg_as_f32(&[OscType::String("x".into())]), None);
    }

    #[test]
    fn apply_packet_updates_only_matching_slot() {
        let mut slots = [0.0f32; SLOTS];
        let msg = OscPacket::Message(rosc::OscMessage {
            addr: "/1/fader3".into(),
            args: vec![OscType::Float(0.75)],
        });
        assert!(apply_packet(&msg, &mut slots));
        assert_eq!(slots[3], 0.75);
        assert!(slots.iter().enumerate().all(|(i, &v)| i == 3 || v == 0.0));
    }
}
