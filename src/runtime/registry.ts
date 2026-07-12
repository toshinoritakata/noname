// BufferRegistry — スワップを跨ぐ状態の所有者(implementation.md 5.2、ADR-0003/0004)。
// 「プログラムは使い捨て、状態は永続」。simulate / prev の実体テクスチャはスロットではなく
// ここが所有し、再評価時はキー(束縛名+型シグネチャ)照合で中身を引き継ぐ。

import type { SimRuntimeSpec } from "../compiler/pass-contract.ts";
import { createWorkTexture, WORK_FORMAT } from "./gpu.ts";

export interface SimEntry {
  spec: SimRuntimeSpec;
  read: GPUTexture[];
  write: GPUTexture[];
  /** init パスの実行が必要(新規 or 引き継ぎ不能) */
  needsInit: boolean;
}

export class BufferRegistry {
  private device: GPUDevice;
  private sims = new Map<string, SimEntry>(); // key = 束縛名
  private prevRead: GPUTexture | null = null;
  private prevWrite: GPUTexture | null = null;
  private prevW = 0;
  private prevH = 0;
  private blitPipeline: GPURenderPipeline | null = null;
  private blitSampler: GPUSampler | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  // ---- simulate ------------------------------------------------------------

  /**
   * キー照合(implementation.md 5.2):
   * - 名前+シグネチャ一致 → 中身を保持したまま更新則だけ差し替え(needsInit=false)
   * - 名前一致・サイズだけ違う → バイリニアで新サイズにリサンプルして引き継ぐ
   * - それ以外 → 新規(初期値から)
   */
  ensureSim(spec: SimRuntimeSpec): SimEntry {
    const existing = this.sims.get(spec.name);
    if (existing) {
      const decision = matchSim(existing.spec, spec);
      if (decision === "keep") {
        existing.spec = spec;
        return existing;
      }
      if (decision === "resample") {
        // サイズ違い: リサンプルして引き継ぐ
        const entry = this.createEntry(spec, false);
        for (let i = 0; i < spec.texCount; i++) {
          this.blit(existing.read[i], entry.read[i]);
        }
        this.destroyEntry(existing);
        this.sims.set(spec.name, entry);
        return entry;
      }
      // 引き継ぎ不能 → 初期値から
      this.destroyEntry(existing);
    }
    const entry = this.createEntry(spec, true);
    this.sims.set(spec.name, entry);
    return entry;
  }

  getSim(name: string): SimEntry | undefined {
    return this.sims.get(name);
  }

  swapSim(name: string): void {
    const e = this.sims.get(name);
    if (!e) return;
    const t = e.read;
    e.read = e.write;
    e.write = t;
  }

  /** 現在どのプログラムからも使われていない状態を解放する */
  gc(liveNames: Set<string>): void {
    for (const [name, entry] of this.sims) {
      if (!liveNames.has(name)) {
        this.destroyEntry(entry);
        this.sims.delete(name);
      }
    }
  }

  private createEntry(spec: SimRuntimeSpec, needsInit: boolean): SimEntry {
    const mk = (phase: string): GPUTexture[] =>
      Array.from({ length: spec.texCount }, (_, i) =>
        createWorkTexture(this.device, spec.width, spec.height, `sim:${spec.name}:${i}:${phase}`),
      );
    return { spec, read: mk("a"), write: mk("b"), needsInit };
  }

  private destroyEntry(e: SimEntry): void {
    for (const t of [...e.read, ...e.write]) t.destroy();
  }

  // ---- prev(最終出力の前フレーム) -------------------------------------------

  ensurePrev(width: number, height: number): void {
    if (this.prevRead && this.prevW === width && this.prevH === height) return;
    this.prevRead?.destroy();
    this.prevWrite?.destroy();
    this.prevRead = createWorkTexture(this.device, width, height, "prev:a");
    this.prevWrite = createWorkTexture(this.device, width, height, "prev:b");
    this.prevW = width;
    this.prevH = height;
  }

  getPrevRead(): GPUTexture | null {
    return this.prevRead;
  }
  getPrevWrite(): GPUTexture | null {
    return this.prevWrite;
  }
  swapPrev(): void {
    const t = this.prevRead;
    this.prevRead = this.prevWrite;
    this.prevWrite = t;
  }

  // ---- バイリニア・ブリット(サイズ引き継ぎ用) -----------------------------------

  private blit(src: GPUTexture, dst: GPUTexture): void {
    if (!this.blitPipeline) {
      const mod = this.device.createShaderModule({
        code: `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  return textureSampleLevel(t, s, in.uv, 0.0);
}`,
      });
      this.blitPipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module: mod, entryPoint: "vs" },
        fragment: { module: mod, entryPoint: "fs", targets: [{ format: WORK_FORMAT }] },
        primitive: { topology: "triangle-list" },
      });
      this.blitSampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
    }
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: dst.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.blitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.blitSampler! },
          { binding: 1, resource: src.createView() },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}

function stripSize(sig: string): string {
  return sig.replace(/:\d+x\d+:/, ":");
}

/**
 * 状態照合の判定(implementation.md 5.2 のルールを純関数化):
 * - "keep": シグネチャ完全一致 → 中身保持・更新則差し替え
 * - "resample": レイアウト同一・サイズ違い → バイリニアで引き継ぐ
 * - "reset": 引き継ぎ不能 → 初期値から
 */
export function matchSim(oldSpec: SimRuntimeSpec, newSpec: SimRuntimeSpec): "keep" | "resample" | "reset" {
  if (oldSpec.sig === newSpec.sig) return "keep";
  if (
    oldSpec.texCount === newSpec.texCount &&
    oldSpec.kind === newSpec.kind &&
    stripSize(oldSpec.sig) === stripSize(newSpec.sig)
  ) {
    return "resample";
  }
  return "reset";
}
