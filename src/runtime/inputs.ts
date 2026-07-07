// Clock と外部入力(implementation.md 5.3 / 5.3.1、ADR-0012)。
// すべての入力は「毎フレーム書かれるスカラー uniform」か「エンティティ表テクスチャ」に
// 正規化される。拡張点は InputAdapter の1インタフェースのみ。

import { createWorkTexture, WORK_FORMAT } from "./gpu.ts";

// ---- InputAdapter(設計の拡張点) ------------------------------------------------

export interface ScalarSlot {
  name: string; // 言語から見える入力名(例 "tuio.count")
}

export interface EntityTable {
  texKey: string; // IR 上のテクスチャキー(例 "ent:tuio")
  slots: number; // 最大エンティティ数
  texelsPerEntity: number;
}

export interface InputAdapter {
  name: string;
  schema: { scalars?: ScalarSlot[]; table?: EntityTable };
  /** 毎フレーム呼ばれる。スカラーは values に、表は texture に書く */
  writeFrame(values: Map<string, number>, queue: GPUQueue, texture: GPUTexture | null): void;
  /** この入力が使われ始めたときに一度呼ばれる */
  start?(): void;
}

/** JSON の中からドット区切りのパス(例 "current.temp_c")で値を取り出す。
 * 数字だけのセグメントは配列添字としても機能する(JSではキーが文字列でも同じ) */
function getJsonPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ---- Clock ----------------------------------------------------------------------

export class Clock {
  /** パフォーマンス開始からの秒。どんな操作でもリセットされない(ADR-0004) */
  time = 0;
  dt = 1 / 60;
  cps = 0.5; // cycles per second(tempo)。1beat = 1/cps 秒
  private last: number | null = null;

  tick(nowMs: number): void {
    const now = nowMs / 1000;
    if (this.last !== null) {
      this.dt = Math.min(0.1, Math.max(1e-4, now - this.last));
    }
    this.last = now;
    this.time = now;
  }
}

// ---- 入力エンジン -----------------------------------------------------------------

interface LagState {
  value: number;
  k: number;
  source: string;
  name: string;
}

export class InputEngine {
  private device: GPUDevice;
  values = new Map<string, number>();
  private lags = new Map<string, LagState>();
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private fftBins: Float32Array | null = null;
  fftTexture: GPUTexture | null = null;
  private audioRequested = false;
  private midiRequested = false;
  private adapters = new Map<string, { adapter: InputAdapter; texture: GPUTexture | null; started: boolean }>();
  private mouseX = 0;
  private mouseY = 0;
  private mouseDown = 0;
  onAudioState: ((state: string) => void) | null = null;
  private video: HTMLVideoElement | null = null;
  camTexture: GPUTexture | null = null;
  private cameraRequested = false;
  onCameraState: ((state: string) => void) | null = null;
  private wsUrl: string | null = null;
  private wsPath = "";
  private wsValue = 0;
  private wsSocket: WebSocket | null = null;
  onWsState: ((state: string) => void) | null = null;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
    this.device = device;
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      const u = (e.clientX - r.left) / Math.max(1, r.width);
      const v = (e.clientY - r.top) / Math.max(1, r.height);
      const aspect = r.width / Math.max(1, r.height);
      // ワールド座標(短辺 -1..1)に正規化
      if (aspect >= 1) {
        this.mouseX = (u * 2 - 1) * aspect;
        this.mouseY = -(v * 2 - 1);
      } else {
        this.mouseX = u * 2 - 1;
        this.mouseY = -(v * 2 - 1) / aspect;
      }
    });
    canvas.addEventListener("pointerdown", () => (this.mouseDown = 1));
    canvas.addEventListener("pointerup", () => (this.mouseDown = 0));
  }

  registerAdapter(adapter: InputAdapter): void {
    let texture: GPUTexture | null = null;
    if (adapter.schema.table) {
      const t = adapter.schema.table;
      texture = this.device.createTexture({
        label: `adapter:${adapter.name}`,
        size: { width: t.slots * t.texelsPerEntity, height: 1 },
        format: WORK_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    this.adapters.set(adapter.name, { adapter, texture, started: false });
  }

  adapterTexture(texKey: string): GPUTexture | null {
    for (const a of this.adapters.values()) {
      if (a.adapter.schema.table?.texKey === texKey) return a.texture;
    }
    return null;
  }

  /** プログラムが使う入力名に応じてサブシステムを起こす */
  ensure(
    inputNames: string[],
    derived: { name: string; source: string; kind: "lag"; k: number }[],
    usesFft: boolean,
    usesCamera = false,
  ): void {
    const needsAudio = usesFft || inputNames.some((n) => n.startsWith("audio.") || (n.startsWith("lag:audio.") ?? false));
    if (needsAudio) this.initAudio();
    if (usesCamera) this.initCamera();
    if (inputNames.some((n) => n.startsWith("midi."))) this.initMidi();
    for (const name of inputNames) {
      const m = name.match(/^([a-zA-Z0-9_]+)\./);
      if (m) {
        const a = this.adapters.get(m[1]);
        if (a && !a.started) {
          a.started = true;
          a.adapter.start?.();
        }
      }
    }
    for (const d of derived) {
      if (!this.lags.has(d.name)) {
        this.lags.set(d.name, { value: 0, k: d.k, source: d.source, name: d.name });
      }
      if (d.source.startsWith("audio.")) this.initAudio();
    }
  }

  private initAudio(): void {
    if (this.audioRequested) return;
    this.audioRequested = true;
    this.onAudioState?.("マイクを要求中…");
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        this.audioCtx = new AudioContext();
        const srcNode = this.audioCtx.createMediaStreamSource(stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.5;
        srcNode.connect(this.analyser);
        this.fftBins = new Float32Array(this.analyser.frequencyBinCount);
        this.fftTexture = this.device.createTexture({
          label: "fft",
          size: { width: 512, height: 1 },
          format: WORK_FORMAT,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.onAudioState?.("audio: on");
      })
      .catch((e) => {
        this.onAudioState?.(`audio: 失敗 (${e?.message ?? e})`);
      });
  }

  private initMidi(): void {
    if (this.midiRequested) return;
    this.midiRequested = true;
    if (!("requestMIDIAccess" in navigator)) return;
    navigator
      .requestMIDIAccess()
      .then((access) => {
        const hook = (): void => {
          for (const input of access.inputs.values()) {
            input.onmidimessage = (ev: MIDIMessageEvent) => {
              const d = ev.data;
              if (!d || d.length < 3) return;
              const status = d[0] & 0xf0;
              if (status === 0xb0) {
                this.values.set(`midi.cc${d[1]}`, d[2] / 127);
              }
            };
          }
        };
        hook();
        access.onstatechange = hook;
      })
      .catch(() => {});
  }

  /** Webcam(`webcam`、ADR-0030): 実解像度が分かってからテクスチャを確保し、
   * 毎フレーム copyExternalImageToTexture で直接GPUへコピーする(CPU側での
   * ピクセル読み出しを経由しない) */
  private initCamera(): void {
    if (this.cameraRequested) return;
    this.cameraRequested = true;
    this.onCameraState?.("カメラを要求中…");
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.addEventListener("loadedmetadata", () => {
          this.camTexture?.destroy();
          this.camTexture = createWorkTexture(this.device, video.videoWidth, video.videoHeight, "webcam");
          this.onCameraState?.("webcam: on");
        });
        void video.play();
        this.video = video;
      })
      .catch((e) => {
        this.onCameraState?.(`webcam: 失敗 (${e?.message ?? e})`);
      });
  }

  /** UI(エディタ横のテキストボックス、ADR-0033)から呼ばれる。URL は言語仕様に
   * 持ち込まない(この言語には1行文字列リテラルはあるが、URLは「作品ロジック」
   * ではなく実行環境の設定に近いという ADR-0031 の判断を踏襲)。
   * HTTPポーリング(ADR-0031、廃止)と違い接続を張りっぱなしにし、サーバ側からの
   * push を都度反映する。URL が空なら切断するだけ(前回値は保持、ADR-0010 の精神) */
  setWsSource(url: string, path: string): void {
    this.wsSocket?.close();
    this.wsSocket = null;
    this.wsUrl = url || null;
    this.wsPath = path;
    if (!this.wsUrl) {
      this.onWsState?.("");
      return;
    }
    try {
      const ws = new WebSocket(this.wsUrl);
      this.wsSocket = ws;
      ws.onopen = () => this.onWsState?.("ws: 接続");
      ws.onmessage = (ev) => {
        try {
          const obj = JSON.parse(String(ev.data));
          const v = getJsonPath(obj, this.wsPath);
          if (typeof v === "number" && Number.isFinite(v)) {
            this.wsValue = v;
            this.onWsState?.(`ws: ${v}`);
          } else {
            this.onWsState?.(`ws: パス "${this.wsPath}" が数値ではありません`);
          }
        } catch {
          this.onWsState?.("ws: JSONとして解釈できないメッセージ");
        }
      };
      ws.onerror = () => this.onWsState?.("ws: 接続エラー");
      ws.onclose = () => this.onWsState?.("ws: 切断");
    } catch (e) {
      this.onWsState?.(`ws: 失敗 (${e instanceof Error ? e.message : e})`);
    }
  }

  /** 毎フレーム更新。値は values に貯まり、ProgramSlot が uniform に書く */
  frame(dt: number, queue: GPUQueue): void {
    this.values.set("mouse.x", this.mouseX);
    this.values.set("mouse.y", this.mouseY);
    this.values.set("mouse.down", this.mouseDown);
    this.values.set("entropy", Math.random()); // 真の乱数は入力として注入し、作品関数自体は純粋に保つ(ADR-0021)
    this.values.set("ws.value", this.wsValue);

    if (this.analyser && this.fftBins) {
      this.analyser.getFloatFrequencyData(this.fftBins as Float32Array<ArrayBuffer>);
      // dB(-100..-30) → 0..1
      const norm = (db: number): number => Math.min(1, Math.max(0, (db + 90) / 60));
      const bins = this.fftBins;
      const band = (lo: number, hi: number): number => {
        let s = 0;
        for (let i = lo; i < hi; i++) s += norm(bins[i]);
        return s / Math.max(1, hi - lo);
      };
      const n = bins.length;
      this.values.set("audio.lo", band(1, Math.floor(n * 0.04)));
      this.values.set("audio.mid", band(Math.floor(n * 0.04), Math.floor(n * 0.25)));
      this.values.set("audio.hi", band(Math.floor(n * 0.25), Math.floor(n * 0.9)));
      this.values.set("audio.level", band(1, Math.floor(n * 0.9)));
      if (this.fftTexture) {
        const data = new Float16Array(512 * 4);
        for (let i = 0; i < 512; i++) {
          data[i * 4] = norm(bins[Math.min(n - 1, i)]);
        }
        queue.writeTexture(
          { texture: this.fftTexture },
          data.buffer,
          { bytesPerRow: 512 * 8 },
          { width: 512, height: 1 },
        );
      }
    }

    if (this.video && this.camTexture && this.video.readyState >= this.video.HAVE_CURRENT_DATA) {
      queue.copyExternalImageToTexture(
        { source: this.video },
        { texture: this.camTexture },
        { width: this.camTexture.width, height: this.camTexture.height },
      );
    }

    // lag(指数平滑)。実装は CPU 側の派生入力(implementation.md の時間族)
    for (const lag of this.lags.values()) {
      const target = this.values.get(lag.source) ?? 0;
      const a = 1 - Math.exp(-dt / Math.max(1e-3, lag.k));
      lag.value += (target - lag.value) * a;
      this.values.set(lag.name, lag.value);
    }

    for (const a of this.adapters.values()) {
      if (a.started) a.adapter.writeFrame(this.values, queue, a.texture);
    }
  }
}

// ---- TUIO アダプタ(M5 の実装例。UDP→WebSocket 中継が必要な旨は設計に明記) ----------

export function makeTuioAdapter(url = "ws://127.0.0.1:3333"): InputAdapter {
  const SLOTS = 32;
  interface Cursor {
    x: number;
    y: number;
    angle: number;
    vx: number;
    vy: number;
    age: number;
    alive: number;
  }
  const cursors: Cursor[] = Array.from({ length: SLOTS }, () => ({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, age: 0, alive: 0 }));
  let ws: WebSocket | null = null;

  return {
    name: "tuio",
    schema: {
      scalars: [{ name: "tuio.count" }],
      table: { texKey: "ent:tuio", slots: SLOTS, texelsPerEntity: 2 },
    },
    start() {
      try {
        ws = new WebSocket(url);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as { id: number; x: number; y: number; angle?: number; vx?: number; vy?: number; age?: number }[];
            for (const c of cursors) c.alive = 0;
            for (const m of msg) {
              const slot = m.id % SLOTS;
              const c = cursors[slot];
              c.x = m.x * 2 - 1;
              c.y = -(m.y * 2 - 1);
              c.angle = m.angle ?? 0;
              c.vx = m.vx ?? 0;
              c.vy = m.vy ?? 0;
              c.age = m.age ?? 0;
              c.alive = 1;
            }
          } catch {
            /* 形式外のメッセージは無視 */
          }
        };
      } catch {
        /* 中継サーバなし。エンティティ表は全て alive=0 のまま */
      }
    },
    writeFrame(values, queue, texture) {
      values.set("tuio.count", cursors.reduce((s, c) => s + c.alive, 0));
      if (!texture) return;
      const data = new Float16Array(SLOTS * 2 * 4);
      for (let i = 0; i < SLOTS; i++) {
        const c = cursors[i];
        const o = i * 8;
        data[o] = c.x;
        data[o + 1] = c.y;
        data[o + 2] = c.angle;
        data[o + 3] = c.alive;
        data[o + 4] = c.vx;
        data[o + 5] = c.vy;
        data[o + 6] = c.age;
      }
      queue.writeTexture({ texture }, data.buffer, { bytesPerRow: SLOTS * 2 * 8 }, { width: SLOTS * 2, height: 1 });
    },
  };
}

// ---- OSC アダプタ(ADR-0029: bridge/ の Rust ヘルパー経由) -----------------------

/** OSC アドレス末尾の数字を固定バンクのスロット番号とみなす(MIDI CC と同じ発想)。
 * ブリッジ(`bridge/`)がスロット抽出済みの32要素配列を送ってくるので、ここでは
 * そのままスカラー入力 `osc.f0`..`osc.f31` に反映するだけ */
export function makeOscAdapter(url = "ws://127.0.0.1:3334"): InputAdapter {
  const OSC_SLOTS = 32;
  const values = new Float32Array(OSC_SLOTS);
  let ws: WebSocket | null = null;

  return {
    name: "osc",
    schema: {
      scalars: Array.from({ length: OSC_SLOTS }, (_, i) => ({ name: `osc.f${i}` })),
    },
    start() {
      try {
        ws = new WebSocket(url);
        ws.onmessage = (ev) => {
          try {
            const snapshot = JSON.parse(String(ev.data)) as number[];
            for (let i = 0; i < OSC_SLOTS && i < snapshot.length; i++) values[i] = snapshot[i];
          } catch {
            /* 形式外のメッセージは無視 */
          }
        };
      } catch {
        /* ブリッジなし。全スロット0のまま */
      }
    },
    writeFrame(vals) {
      for (let i = 0; i < OSC_SLOTS; i++) vals.set(`osc.f${i}`, values[i]);
    },
  };
}
