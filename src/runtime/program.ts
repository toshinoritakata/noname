// ProgramSlot — 使い捨てのコンパイル済みプログラム(implementation.md 5.1、ADR-0004)。
// シェーダ・パイプライン・uniform バッファを持つ。simulate / prev の実体は持たない
// (BufferRegistry の所有)。数値リテラルのみの変更は updateLiterals の高速経路で反映。

import type { Diagnostic } from "../compiler/diag.ts";
import type { CompiledPass, CompiledProgram } from "../compiler/wgsl.ts";
import { createWorkTexture, WORK_FORMAT } from "./gpu.ts";
import type { BufferRegistry } from "./registry.ts";

export type TexResolver = (key: string) => GPUTextureView | null;

interface BuiltPass {
  spec: CompiledPass;
  pipeline: GPURenderPipeline;
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

export class ProgramSlot {
  device: GPUDevice;
  compiled: CompiledProgram;
  passes: BuiltPass[] = [];
  uniformBuffer: GPUBuffer;
  private uniformData: Float32Array;
  sampler: GPUSampler;
  /** raymarch パスの出力テクスチャ(id → texture) */
  rmTex = new Map<number, GPUTexture>();
  /** bloom パス連鎖の出力テクスチャ(`${id}:${stage}` → texture。ADR-0019) */
  bloomTex = new Map<string, GPUTexture>();
  /** data パス(ループ不変式の巻き上げ先)の出力テクスチャ(dataKey → texCount 本) */
  private dataTex = new Map<string, GPUTexture[]>();
  /** 最終 image パスの出力 */
  colorTex: GPUTexture | null = null;
  evalTime = 0;
  fadeEndTime = 0;
  private width = 0;
  private height = 0;

  constructor(device: GPUDevice, compiled: CompiledProgram) {
    this.device = device;
    this.compiled = compiled;
    const floats = 4 + compiled.uniformLayout.slotCount * 4;
    this.uniformData = new Float32Array(floats);
    this.uniformBuffer = device.createBuffer({
      size: floats * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  /** シェーダコンパイル(非同期)。エラーは診断として返し、スロットは捨てられる(ADR-0010) */
  async build(cache: PipelineCache): Promise<Diagnostic[]> {
    const diags: Diagnostic[] = [];
    const built = await Promise.all(
      this.compiled.passes.map(async (spec) => {
        const key = spec.hash + ":" + spec.targets;
        let p = cache.get(key);
        if (!p) {
          p = this.createPipeline(spec, diags);
          cache.set(key, p);
        }
        try {
          return { spec, pipeline: await p };
        } catch (e) {
          cache.delete(key);
          diags.push({
            severity: "error",
            message: `シェーダの生成に失敗しました: ${e instanceof Error ? e.message : e}`,
            span: { start: 0, end: 0 },
          });
          return null;
        }
      }),
    );
    if (diags.length > 0) return diags;
    this.passes = built.filter((b): b is BuiltPass => b !== null);
    return diags;
  }

  /**
   * 明示的な BindGroupLayout(binding 0: uniform / 1: sampler / 2..: textures)。
   * layout:"auto" は未使用バインディングを刈り取るため、bind group 側と食い違う。
   */
  private bindGroupLayout(texCount: number, kind: CompiledPass["kind"]): GPUBindGroupLayout {
    // sprite(ADR-0014)/strip(ADR-0016)パスは頂点シェーダで uniform とテクスチャを
    // 読むため、頂点段も可視にする
    const vis =
      kind === "sprite" || kind === "strip" ? GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT : GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: vis, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ];
    for (let i = 0; i < texCount; i++) {
      entries.push({
        binding: i + 2,
        visibility: vis,
        texture: { sampleType: "float", viewDimension: "2d" },
      });
    }
    return this.device.createBindGroupLayout({ entries });
  }

  private async createPipeline(spec: CompiledPass, diags: Diagnostic[]): Promise<GPURenderPipeline> {
    const module = this.device.createShaderModule({ code: spec.code, label: `${spec.kind}:${spec.hash}` });
    const info = await module.getCompilationInfo();
    for (const m of info.messages) {
      if (m.type === "error") {
        // 生成 WGSL の行を必ずソースへ写像する(implementation.md 6.3)。
        // 現状は行スパン表が粗いので、WGSL 行の抜粋を添えてプログラム全体に紐づける
        const lines = spec.code.split("\n");
        const excerpt = lines[Math.max(0, m.lineNum - 1)]?.trim().slice(0, 80) ?? "";
        diags.push({
          severity: "error",
          message: `生成シェーダのエラー: ${m.message}(${spec.kind} パス、行 ${m.lineNum}: \`${excerpt}\`)`,
          span: spec.lineSpans[m.lineNum - 1] ?? { start: 0, end: 0 },
        });
      }
    }
    if (diags.length > 0) throw new Error("shader compilation failed");
    // sprite パス(ADR-0014)は加算ブレンドで、深度テストなしにレイマーチ結果へ重ね描きする。
    // alpha は rgb と違って「被覆率」として <over> 合成(overBlend の a = top.w + bot.w*(1-top.w))
    // に使われるため、加算すると粒子が密集した箇所で 1.0 を大きく超え、(1-top.w) が
    // 大きく負になって合成そのものが破綻する(実測: alpha が float16 上限 65504 まで発散)。
    // alpha は max にして 0..1 の被覆率のまま保つ(rgb は加算のまま、密集ほど明るく光る)
    // strip パス(ADR-0016)は line/bezier をラスタライズして最終画像に直接上描きする。
    // フラグメントはあらかじめ premultiplied(rgb*coverage, coverage)で出すので、
    // 標準の premultiplied-over ブレンドで下地(image パスの出力)に正しく重なる
    const blend: GPUBlendState | undefined =
      spec.kind === "sprite"
        ? {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "max" },
          }
        : spec.kind === "strip"
          ? {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            }
          : undefined;
    const targets: GPUColorTargetState[] = Array.from({ length: spec.targets }, () => ({ format: WORK_FORMAT, blend }));
    const bgl = this.bindGroupLayout(spec.textures.length, spec.kind);
    return this.device.createRenderPipelineAsync({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets },
      primitive: { topology: spec.kind === "strip" ? "triangle-strip" : "triangle-list" },
    });
  }

  /** 高速経路: 形が同じ再評価はリテラル値の差し替えだけ(ADR-0008) */
  updateLiterals(compiled: CompiledProgram): void {
    this.compiled = { ...this.compiled, literals: compiled.literals, fade: compiled.fade, derivedInputs: compiled.derivedInputs };
  }

  ensureTargets(width: number, height: number): void {
    // data テクスチャは解像度に依存しないので一度だけ作る
    if (this.dataTex.size === 0) {
      for (const p of this.compiled.passes) {
        if (p.kind === "data" && p.dataKey && p.dataCount) {
          const texs = Array.from({ length: p.targets }, (_, i) =>
            createWorkTexture(this.device, p.dataCount!, 1, `slot:${p.dataKey}:${i}`),
          );
          this.dataTex.set(p.dataKey, texs);
        }
      }
    }
    if (this.width === width && this.height === height && this.colorTex) return;
    this.width = width;
    this.height = height;
    this.colorTex?.destroy();
    this.colorTex = createWorkTexture(this.device, width, height, "slot:color");
    for (const t of this.rmTex.values()) t.destroy();
    this.rmTex.clear();
    for (const p of this.compiled.passes) {
      if (p.kind === "raymarch" && p.rmId !== undefined) {
        const rw = p.halfRes ? Math.max(1, Math.floor(width / 2)) : width;
        const rh = p.halfRes ? Math.max(1, Math.floor(height / 2)) : height;
        this.rmTex.set(p.rmId, createWorkTexture(this.device, rw, rh, `slot:rm${p.rmId}`));
      }
    }
    for (const t of this.bloomTex.values()) t.destroy();
    this.bloomTex.clear();
    for (const p of this.compiled.passes) {
      if (
        (p.kind === "bloom-extract" || p.kind === "bloom-down" || p.kind === "bloom-up") &&
        p.bloomId !== undefined &&
        p.bloomOutKey !== undefined &&
        p.bloomResDivisor !== undefined
      ) {
        const bw = Math.max(1, Math.floor(width / p.bloomResDivisor));
        const bh = Math.max(1, Math.floor(height / p.bloomResDivisor));
        this.bloomTex.set(p.bloomOutKey, createWorkTexture(this.device, bw, bh, `slot:${p.bloomOutKey}`));
      }
    }
  }

  writeUniforms(getInput: (name: string) => number, width: number, height: number): void {
    const d = this.uniformData;
    const px = 2 / Math.max(1, Math.min(width, height));
    d[0] = width;
    d[1] = height;
    d[2] = px;
    d[3] = 0;
    const { inputs, literalBase } = this.compiled.uniformLayout;
    for (let i = 0; i < inputs.length; i++) {
      d[4 + i] = getInput(inputs[i]);
    }
    for (let i = 0; i < this.compiled.literals.length; i++) {
      d[4 + literalBase + i] = this.compiled.literals[i].value;
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, d.buffer, 0, d.byteLength);
  }

  private dummyTex: GPUTexture | null = null;

  private dummyView(): GPUTextureView {
    if (!this.dummyTex) {
      this.dummyTex = createWorkTexture(this.device, 1, 1, "dummy");
    }
    return this.dummyTex.createView();
  }

  private bindGroup(pass: BuiltPass, resolve: TexResolver): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
      { binding: 1, resource: this.sampler },
    ];
    pass.spec.textures.forEach((key, i) => {
      // 明示レイアウトなので全バインディングを埋める(未解決はダミー)
      entries.push({ binding: i + 2, resource: resolve(key) ?? this.dummyView() });
    });
    return this.device.createBindGroup({ layout: pass.pipeline.getBindGroupLayout(0), entries });
  }

  /**
   * このスロットのパスを実行する。
   * stepSims=false のときは simulate の更新を走らせない(フェード中の旧スロット)。
   */
  execute(encoder: GPUCommandEncoder, registry: BufferRegistry, resolveExtra: TexResolver, stepSims: boolean): void {
    const resolve: TexResolver = (key) => {
      if (key === "prev") return registry.getPrevRead()?.createView() ?? null;
      const sim = key.match(/^sim:(.+):(\d+)$/);
      if (sim) {
        const entry = registry.getSim(sim[1]);
        return entry ? entry.read[Number(sim[2])].createView() : null;
      }
      const rm = key.match(/^rm:(\d+)$/);
      if (rm) return this.rmTex.get(Number(rm[1]))?.createView() ?? null;
      if (key.startsWith("bloom:")) return this.bloomTex.get(key)?.createView() ?? null;
      const data = key.match(/^((?:data|sprite|strip):\d+):(\d+)$/);
      if (data) return this.dataTex.get(data[1])?.[Number(data[2])]?.createView() ?? null;
      return resolveExtra(key);
    };

    // ---- data(ループ不変式の巻き上げ先。毎フレーム再計算 — time 依存があり得るため) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "data" || !p.spec.dataKey) continue;
      const texs = this.dataTex.get(p.spec.dataKey);
      if (!texs) continue;
      this.draw(encoder, p, texs.map((t) => t.createView()), resolve);
    }

    // ---- simulate: init(必要なら)→ update → swap ----
    for (const p of this.passes) {
      if (p.spec.kind !== "sim-init") continue;
      const entry = registry.getSim(p.spec.simName!);
      if (!entry || !entry.needsInit) continue;
      this.runSimPass(encoder, p, entry.write.map((t) => t.createView()), resolve);
      registry.swapSim(p.spec.simName!);
      entry.needsInit = false;
    }
    if (stepSims) {
      for (const p of this.passes) {
        if (p.spec.kind !== "sim-update") continue;
        const entry = registry.getSim(p.spec.simName!);
        if (!entry) continue;
        this.runSimPass(encoder, p, entry.write.map((t) => t.createView()), resolve);
        registry.swapSim(p.spec.simName!);
      }
    }

    // ---- raymarch ----
    for (const p of this.passes) {
      if (p.spec.kind !== "raymarch") continue;
      const tex = this.rmTex.get(p.spec.rmId!);
      if (!tex) continue;
      this.draw(encoder, p, [tex.createView()], resolve);
    }

    // ---- sprite(scatter の instanced 描画。レイマーチ結果に加算ブレンドで重ね描き。ADR-0014) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "sprite" || p.spec.spriteRmId === undefined) continue;
      const tex = this.rmTex.get(p.spec.spriteRmId);
      if (!tex) continue;
      this.draw(encoder, p, [tex.createView()], resolve, "load", 6, p.spec.spriteCount ?? 1);
    }

    // ---- bloom(ダウンサンプル+ブラー多パス連鎖。ADR-0019) ----
    // 生成順(extract → down1 → down2 → up1 → up0)が依存順そのものなので、
    // compiled.passes の並び順どおりに実行すればよい
    for (const p of this.passes) {
      if (p.spec.kind !== "bloom-extract" && p.spec.kind !== "bloom-down" && p.spec.kind !== "bloom-up") continue;
      const tex = this.bloomTex.get(p.spec.bloomOutKey!);
      if (!tex) continue;
      this.draw(encoder, p, [tex.createView()], resolve);
    }

    // ---- image(最終) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "image") continue;
      if (!this.colorTex) continue;
      this.draw(encoder, p, [this.colorTex.createView()], resolve);
    }

    // ---- strip(line/bezier の instanced 描画。march 不要で最終画像に直接上描き。ADR-0016) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "strip" || p.spec.stripVertexCount === undefined) continue;
      if (!this.colorTex) continue;
      this.draw(encoder, p, [this.colorTex.createView()], resolve, "load", p.spec.stripVertexCount, p.spec.stripCount ?? 1);
    }
  }

  private runSimPass(encoder: GPUCommandEncoder, p: BuiltPass, targets: GPUTextureView[], resolve: TexResolver): void {
    this.draw(encoder, p, targets, resolve);
  }

  private draw(
    encoder: GPUCommandEncoder,
    p: BuiltPass,
    targets: GPUTextureView[],
    resolve: TexResolver,
    loadOp: "clear" | "load" = "clear",
    vertexCount = 3,
    instanceCount = 1,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: targets.map((view) => ({
        view,
        loadOp,
        storeOp: "store" as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
    });
    pass.setPipeline(p.pipeline);
    pass.setBindGroup(0, this.bindGroup(p, resolve));
    pass.draw(vertexCount, instanceCount);
    pass.end();
  }

  destroy(): void {
    this.colorTex?.destroy();
    for (const t of this.rmTex.values()) t.destroy();
    for (const texs of this.dataTex.values()) for (const t of texs) t.destroy();
    this.dummyTex?.destroy();
    this.uniformBuffer.destroy();
  }
}
