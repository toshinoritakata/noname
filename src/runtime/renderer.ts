// レンダラ — フレームループと2スロットのクロスフェード(implementation.md 5章)。
// 評価(Shift+Enter)中も現行スロットが描画を続け、準備完了後に blend 係数を動かす。
// エラー時は直前の正常プログラムが走り続ける(ADR-0010)。

import type { Diagnostic } from "../compiler/diag.ts";
import type { Gpu } from "./gpu.ts";
import { WORK_FORMAT } from "./gpu.ts";
import { cachedView, PipelineCache, TextTextureCache, viewId } from "./caches.ts";
import { Clock, InputEngine } from "./inputs.ts";
import { ProgramSlot } from "./program.ts";
import { BufferRegistry } from "./registry.ts";
import { CompilerClient } from "./compiler-client.ts";

export interface EvalResult {
  diagnostics: Diagnostic[];
  /** "fast" = uniform 更新のみ / "swap" = 新スロットへクロスフェード / "error" = 旧維持 */
  outcome: "fast" | "swap" | "error";
  /** コンパイル所要時間(ms)。レイテンシ予算の観測用(implementation.md 7章) */
  compileMs: number;
}

export class Renderer {
  gpu: Gpu;
  clock = new Clock();
  inputs: InputEngine;
  registry: BufferRegistry;
  private cache: PipelineCache = new PipelineCache();
  private textCache: TextTextureCache;
  private active: ProgramSlot | null = null;
  private old: ProgramSlot | null = null;
  private fadeStart = 0;
  private fadeDur = 0;
  private evalGen = 0;
  private blendPipeline: GPURenderPipeline | null = null;
  private blendPipelineCanvas: GPURenderPipeline | null = null;
  private blendBuf: GPUBuffer;
  /** 毎フレーム writeBuffer するだけの一時バッファ。都度 new する必要はない(ADR-0042) */
  private kBuf = new Float32Array(4);
  /** prev への書き戻し(blendTo)用のバインドグループキャッシュ。canvas への書き戻しは
   * 毎フレーム新しいテクスチャ(context.getCurrentTexture())が来るため対象外 */
  private prevBlendGroupCache = new Map<string, GPUBindGroup>();
  private compiler = new CompilerClient();
  onStatus: ((s: string) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private stopped = false;

  constructor(gpu: Gpu) {
    this.gpu = gpu;
    this.inputs = new InputEngine(gpu.device, gpu.canvas);
    this.registry = new BufferRegistry(gpu.device);
    this.textCache = new TextTextureCache(gpu.device);
    this.blendBuf = gpu.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const loop = (t: number): void => {
      if (this.stopped) return;
      this.frame(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** 内部の rAF ループを止める(device.lost からの再初期化で古い Renderer を捨てる時に使う) */
  stop(): void {
    this.stopped = true;
  }

  /**
   * ソースを評価する。映像は評価が成功して初めて切り替わる。
   * parse/infer/stage/WGSL 生成(同期・重い)はコンパイラ Worker に投げ、
   * メインスレッドは常にキー入力とフレームループに専念できるようにする
   */
  async evaluate(src: string): Promise<EvalResult> {
    const t0 = performance.now();
    const gen = ++this.evalGen;

    const result = await this.compiler.compile(src);
    if (!result.program) {
      return { diagnostics: result.diagnostics, outcome: "error", compileMs: performance.now() - t0 };
    }

    // text(ADR-0032)のラスタライズは Canvas2D の同期APIなので await 不要。
    // fast path でも swap 前でも、参照されているテクスチャが必ず揃っているようにする
    for (const t of result.program.textTextures) this.textCache.ensure(t.key, t.text);

    // ---- 高速経路: 形が同じ → uniform 更新のみ(< 1 フレーム、ADR-0008) ----
    if (this.active && this.active.compiled.programHash === result.program.programHash) {
      this.active.updateLiterals(result.program);
      this.inputs.ensure(
      result.program.uniformLayout.inputs,
      result.program.derivedInputs,
      this.usesFft(result.program),
      this.usesTexture(result.program, "cam"),
    );
      return { diagnostics: result.diagnostics, outcome: "fast", compileMs: performance.now() - t0 };
    }

    // ---- 新スロットを非同期に構築(その間も旧スロットが描画を続ける) ----
    const slot = new ProgramSlot(this.gpu.device, result.program);
    const shaderDiags = await slot.build(this.cache);
    if (shaderDiags.some((d) => d.severity === "error")) {
      slot.destroy();
      return {
        diagnostics: [...result.diagnostics, ...shaderDiags],
        outcome: "error",
        compileMs: performance.now() - t0,
      };
    }
    if (gen !== this.evalGen) {
      // その間に次の評価が始まっていたら破棄
      slot.destroy();
      return { diagnostics: result.diagnostics, outcome: "error", compileMs: performance.now() - t0 };
    }

    // 状態の照合と引き継ぎ(BufferRegistry、ADR-0004)
    for (const sim of result.program.sims) {
      this.registry.ensureSim(sim);
    }
    const liveNames = new Set<string>(result.program.sims.map((s) => s.name));
    if (this.old) for (const s of this.old.compiled.sims) liveNames.add(s.name);
    this.registry.gc(liveNames);

    this.inputs.ensure(
      result.program.uniformLayout.inputs,
      result.program.derivedInputs,
      this.usesFft(result.program),
      this.usesTexture(result.program, "cam"),
    );

    // スワップ開始
    this.old?.destroy();
    this.old = this.active;
    this.active = slot;
    slot.evalTime = this.clock.time;
    const fade = result.program.fade;
    this.fadeDur = fade ? (fade.unit === "beat" ? fade.value / this.clock.cps : fade.value) : 0;
    this.fadeStart = this.clock.time;
    slot.fadeEndTime = this.fadeStart + this.fadeDur;

    return { diagnostics: result.diagnostics, outcome: "swap", compileMs: performance.now() - t0 };
  }

  private usesFft(p: { passes: { textures: string[] }[] }): boolean {
    return this.usesTexture(p, "fft");
  }

  private usesTexture(p: { passes: { textures: string[] }[] }, key: string): boolean {
    return p.passes.some((pass) => pass.textures.includes(key));
  }

  private getInputFor(slot: ProgramSlot): (name: string) => number {
    return (name: string): number => {
      switch (name) {
        case "time":
          return this.clock.time;
        case "etime":
          return this.clock.time - slot.evalTime;
        case "etimeF":
          return Math.max(0, this.clock.time - slot.fadeEndTime);
        case "dt":
          return Math.min(this.clock.dt, 1 / 30);
        case "spb":
          return 1 / this.clock.cps;
        case "cps":
          return this.clock.cps;
        case "px":
          return 2 / Math.max(1, Math.min(this.gpu.canvas.width, this.gpu.canvas.height));
        default:
          if (name.startsWith("text:") && name.endsWith(":aspect")) {
            const key = name.slice(0, -":aspect".length);
            return this.textCache.get(key)?.aspect ?? 1;
          }
          return this.inputs.values.get(name) ?? 0;
      }
    };
  }

  private frame(nowMs: number): void {
    const { device, canvas, context } = this.gpu;
    this.clock.tick(nowMs);
    this.inputs.frame(this.clock.dt, device.queue);
    this.tickFps(nowMs);
    if (!this.active) return;

    // キャンバスサイズ追従
    const w = Math.max(1, canvas.width);
    const h = Math.max(1, canvas.height);
    this.active.ensureTargets(w, h);
    this.old?.ensureTargets(w, h);
    const needsPrev = this.active.compiled.usesPrev || (this.old?.compiled.usesPrev ?? false);
    if (needsPrev) this.registry.ensurePrev(w, h);

    // フェード係数
    let k = 1;
    if (this.old) {
      k = this.fadeDur <= 0 ? 1 : Math.min(1, (this.clock.time - this.fadeStart) / this.fadeDur);
      if (k >= 1) {
        this.old.destroy();
        this.old = null;
      }
    }

    const resolveExtra = (key: string): GPUTextureView | null => {
      if (key === "fft") return this.inputs.fftTexture ? cachedView(this.inputs.fftTexture) : null;
      if (key === "cam") return this.inputs.camTexture ? cachedView(this.inputs.camTexture) : null;
      if (key.startsWith("text:")) {
        const t = this.textCache.get(key)?.texture;
        return t ? cachedView(t) : null;
      }
      if (key.startsWith("ent:")) {
        const t = this.inputs.adapterTexture(key);
        return t ? cachedView(t) : null;
      }
      return null;
    };

    const encoder = device.createCommandEncoder();

    // 旧スロット(フェード中): simulate は進めない(更新則は新プログラムに差し替え済み)
    if (this.old) {
      this.old.writeUniforms(this.getInputFor(this.old), w, h);
      this.old.execute(encoder, this.registry, resolveExtra, false);
    }
    this.active.writeUniforms(this.getInputFor(this.active), w, h);
    this.active.execute(encoder, this.registry, resolveExtra, true);

    // ---- blend: 画面へ、そして prev へ書き戻す(ADR-0004: フェード中も一貫した前フレーム) ----
    this.ensureBlendPipelines();
    this.kBuf[0] = this.old ? k : 1;
    device.queue.writeBuffer(this.blendBuf, 0, this.kBuf.buffer);
    const texA = cachedView((this.old ?? this.active).colorTex!);
    const texB = cachedView(this.active.colorTex!);

    const blendTo = (view: GPUTextureView, pipeline: GPURenderPipeline, cacheKey: string | null): void => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(pipeline);
      // canvas への書き戻し(cacheKey===null)は context.getCurrentTexture() が毎フレーム
      // 新しいテクスチャを返すのでキャッシュできない。prev への書き戻しは実体が2つの
      // ping-pong バッファを往復するだけなので、texA/texB/targetの組み合わせが同じ間は
      // バインドグループを再利用できる(ADR-0042)
      let bg: GPUBindGroup | undefined = cacheKey ? this.prevBlendGroupCache.get(cacheKey) : undefined;
      if (!bg) {
        bg = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.blendBuf } },
            { binding: 1, resource: this.active!.sampler },
            { binding: 2, resource: texA },
            { binding: 3, resource: texB },
          ],
        });
        if (cacheKey) this.prevBlendGroupCache.set(cacheKey, bg);
      }
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    };

    blendTo(context.getCurrentTexture().createView(), this.blendPipelineCanvas!, null);
    if (needsPrev) {
      const prevW = this.registry.getPrevWrite();
      if (prevW) {
        const key = `${viewId(cachedView(prevW))}:${viewId(texA)}:${viewId(texB)}`;
        blendTo(cachedView(prevW), this.blendPipeline!, key);
      }
    }

    device.queue.submit([encoder.finish()]);
    if (needsPrev) this.registry.swapPrev();
  }

  /** 直近1秒間のフレーム数から FPS を算出し、1秒に1回だけ onFps へ通知する */
  private tickFps(nowMs: number): void {
    if (this.fpsWindowStart === 0) this.fpsWindowStart = nowMs;
    this.fpsFrames++;
    const elapsed = nowMs - this.fpsWindowStart;
    if (elapsed >= 1000) {
      this.onFps?.((this.fpsFrames * 1000) / elapsed);
      this.fpsFrames = 0;
      this.fpsWindowStart = nowMs;
    }
  }

  private ensureBlendPipelines(): void {
    if (this.blendPipeline) return;
    const code = `
struct BU { k: vec4f }
@group(0) @binding(0) var<uniform> bu: BU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}
@fragment fn fs_main(in: VOut) -> @location(0) vec4f {
  let a = textureSampleLevel(texA, samp, in.uv, 0.0);
  let b = textureSampleLevel(texB, samp, in.uv, 0.0);
  return mix(a, b, bu.k.x);
}`;
    const module = this.gpu.device.createShaderModule({ code });
    const mk = (format: GPUTextureFormat): GPURenderPipeline =>
      this.gpu.device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
    this.blendPipeline = mk(WORK_FORMAT);
    this.blendPipelineCanvas = mk(this.gpu.format);
  }
}
