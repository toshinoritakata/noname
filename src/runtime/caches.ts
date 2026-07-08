// GPU リソースのメモ化キャッシュ群(候補4: program.ts から抽出)。
// ProgramSlot(使い捨て)とは寿命が違う3種を1ファイルにまとめる:
// - view/viewId: テクスチャ→ビューのメモ化・ビューへの連番付与(ADR-0042)
// - PipelineCache: パスの構造ハッシュ→パイプライン(implementation.md 3.4、LRU)
// - TextTextureCache: `text`(ADR-0032)のラスタライズ結果(LRU)

import { createWorkTexture } from "./gpu.ts";

/**
 * テクスチャ→ビューのメモ化(パフォーマンス改善、ADR-0042)。同じ GPUTexture に対して
 * createView() を毎フレーム呼び直すのは無駄なアロケーションでしかない(ビューは
 * テクスチャが再作成されない限り不変)。WeakMap なのでテクスチャが destroy/GC
 * された後の参照は残らない。ProgramSlot 所有のテクスチャ(rm/bloom/data/color)と
 * BufferRegistry 所有のテクスチャ(prev/sim、ping-pong で2つの実体を往復するだけで
 * 実体そのものは変わらない)の両方に対して安全に使える
 */
const viewCache = new WeakMap<GPUTexture, GPUTextureView>();
export function cachedView(tex: GPUTexture): GPUTextureView {
  let v = viewCache.get(tex);
  if (!v) {
    v = tex.createView();
    viewCache.set(tex, v);
  }
  return v;
}

/**
 * cachedView() が返すビューに振る連番。同じテクスチャなら常に同じビュー・同じ番号に
 * なる(cachedView の1:1性が前提)ので、これを文字列キーに連結すればバインドグループ
 * キャッシュのキーになる。context.getCurrentTexture() のようにフレームごとに新しい
 * テクスチャを返すもの(cachedView を通さない生の createView())には使わないこと
 */
const viewIds = new WeakMap<GPUTextureView, number>();
let nextViewId = 0;
export function viewId(v: GPUTextureView): number {
  let id = viewIds.get(v);
  if (id === undefined) {
    id = nextViewId++;
    viewIds.set(v, id);
  }
  return id;
}

const PIPELINE_CACHE_LIMIT = 128;

/**
 * パイプラインキャッシュ: パスの構造ハッシュ → パイプライン(implementation.md 3.4)。
 * ライブコーディングは編集し続けるのが前提の道具で、構造が変わるたびに新しい
 * ハッシュのパイプラインが積み上がる。ProgramSlot.destroy() 側ではエントリを
 * 消さない(同じハッシュを別スロットが今後も再利用しうるため)ので、ここで
 * 上限を設けて最も使われていないものから捨てる(LRU、挿入順を保つ Map の性質を使う)
 */
export class PipelineCache {
  private map = new Map<string, Promise<GPURenderPipeline>>();
  private limit: number;

  constructor(limit = PIPELINE_CACHE_LIMIT) {
    this.limit = limit;
  }

  get(key: string): Promise<GPURenderPipeline> | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // 参照されたので最新として末尾に移動する
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Promise<GPURenderPipeline>): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

const TEXT_CACHE_LIMIT = 64;
/** ラスタライズの基準高さ(px)。文字の世界座標サイズは Shape 側の `text h str` の h で決まる */
const TEXT_PIXEL_HEIGHT = 128;

interface TextTextureEntry {
  texture: GPUTexture;
  /** 幅/高さ。text の dist 計算がこの比率で外接矩形の幅を決める */
  aspect: number;
}

/**
 * `text`(ADR-0032)のラスタライズ結果(文字列内容→GPUテクスチャ)のキャッシュ。
 * Canvas2D の fillText は同期APIなので、fetch/getUserMedia と違い await 不要で
 * 即座にテクスチャを用意できる。PipelineCache と同じ理由(ライブコーディングは
 * 編集し続けるのが前提)でLRU上限を設ける
 */
export class TextTextureCache {
  private device: GPUDevice;
  private map = new Map<string, TextTextureEntry>();
  private limit: number;

  constructor(device: GPUDevice, limit = TEXT_CACHE_LIMIT) {
    this.device = device;
    this.limit = limit;
  }

  /** 未キャッシュならラスタライズしてGPUへアップロードする。同期的に完了する */
  ensure(key: string, text: string): TextTextureEntry {
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.map.set(key, existing); // 参照されたので最新として末尾に移動する(LRU)
      return existing;
    }
    const height = TEXT_PIXEL_HEIGHT;
    const measure = new OffscreenCanvas(1, 1).getContext("2d")!;
    measure.font = `${Math.round(height * 0.8)}px sans-serif`;
    const width = Math.max(1, Math.ceil(measure.measureText(text || " ").width));
    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext("2d")!;
    c2d.font = measure.font;
    c2d.textBaseline = "middle";
    c2d.fillStyle = "white";
    c2d.fillText(text, 0, height / 2);
    const texture = createWorkTexture(this.device, width, height, key);
    this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture }, { width, height });
    const entry: TextTextureEntry = { texture, aspect: width / height };
    this.map.set(key, entry);
    if (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.get(oldestKey)?.texture.destroy();
        this.map.delete(oldestKey);
      }
    }
    return entry;
  }

  get(key: string): TextTextureEntry | undefined {
    return this.map.get(key);
  }
}
