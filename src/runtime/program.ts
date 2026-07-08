// ProgramSlot — 使い捨てのコンパイル済みプログラム(implementation.md 5.1、ADR-0004)。
// シェーダ・パイプライン・uniform バッファを持つ。simulate / prev の実体は持たない
// (BufferRegistry の所有)。数値リテラルのみの変更は updateLiterals の高速経路で反映。

import type { Diagnostic } from "../compiler/diag.ts";
import { parseTexKey } from "../compiler/tex-keys.ts";
import type { CompiledPass, CompiledProgram } from "../compiler/wgsl.ts";
import { cachedView, PipelineCache, viewId } from "./caches.ts";
import { createWorkTexture, WORK_FORMAT } from "./gpu.ts";
import type { BufferRegistry } from "./registry.ts";

export type TexResolver = (key: string) => GPUTextureView | null;

interface BuiltPass {
  spec: CompiledPass;
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
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
  /** 2Dストリップ層(premultiplied)。bloom より前に描き込み、場が "scene" キーで
   * サンプルする。これにより glow+bloom が2D line/bezier にも効く(ADR-0044) */
  sceneTex: GPUTexture | null = null;
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
          const pipeline = await p;
          return { spec, pipeline, bindGroupLayout: pipeline.getBindGroupLayout(0) };
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
    // sprite(ADR-0014)/strip(ADR-0016)/strip3d(ADR-0036)パスは頂点シェーダで
    // uniform とテクスチャを読むため、頂点段も可視にする
    const vis =
      kind === "sprite" || kind === "strip" || kind === "strip3d"
        ? GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
        : GPUShaderStage.FRAGMENT;
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
    // 標準の premultiplied-over ブレンドで下地(image パスの出力)に正しく重なる。
    // strip3d パス(ADR-0036)は sprite と同じく深度テストなしでレイマーチ結果に
    // 重ね描きするので、sprite と同じ加算+maxアルファのブレンドを使う
    const blend: GPUBlendState | undefined =
      spec.kind === "sprite" || spec.kind === "strip3d"
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
      primitive: { topology: spec.kind === "strip" || spec.kind === "strip3d" ? "triangle-strip" : "triangle-list" },
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
    // 2Dストリップ層(ADR-0044): strip パスがあるときだけ確保
    this.sceneTex?.destroy();
    this.sceneTex = this.compiled.passes.some((p) => p.kind === "strip")
      ? createWorkTexture(this.device, width, height, "slot:scene")
      : null;
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
    return cachedView(this.dummyTex);
  }

  /** pass ごとのバインドグループキャッシュ(ADR-0042)。キーは解決された各テクスチャ
   * ビューの識別子(viewId、cachedView 経由なので同一テクスチャなら不変)を連結した
   * 文字列。prev/sim のように ping-pong で実体が2つを往復するパスでも、実体は
   * 高々2種なのでキャッシュは高々2エントリで済む。ほとんどのパス(raymarch/bloom/
   * data/image)は解決先が resize まで不変なので、初回以降は毎フレーム bindGroup を
   * 作り直さずこのキャッシュを返す */
  private bindGroupCache = new Map<BuiltPass, Map<string, GPUBindGroup>>();

  private bindGroup(pass: BuiltPass, resolve: TexResolver): GPUBindGroup {
    const views = pass.spec.textures.map((key) => resolve(key) ?? this.dummyView());
    let key = "";
    for (const v of views) key += viewId(v) + ",";
    let cache = this.bindGroupCache.get(pass);
    if (!cache) {
      cache = new Map();
      this.bindGroupCache.set(pass, cache);
    }
    const hit = cache.get(key);
    if (hit) return hit;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
      { binding: 1, resource: this.sampler },
    ];
    views.forEach((v, i) => entries.push({ binding: i + 2, resource: v }));
    const bg = this.device.createBindGroup({ layout: pass.bindGroupLayout, entries });
    cache.set(key, bg);
    return bg;
  }

  /**
   * このスロットのパスを実行する。
   * stepSims=false のときは simulate の更新を走らせない(フェード中の旧スロット)。
   */
  execute(encoder: GPUCommandEncoder, registry: BufferRegistry, resolveExtra: TexResolver, stepSims: boolean): void {
    const resolve: TexResolver = (key) => {
      const parsed = parseTexKey(key);
      switch (parsed.kind) {
        case "prev": {
          const t = registry.getPrevRead();
          return t ? cachedView(t) : null;
        }
        case "sim": {
          const entry = registry.getSim(parsed.name);
          return entry ? cachedView(entry.read[parsed.index]) : null;
        }
        case "rm": {
          const t = this.rmTex.get(parsed.id);
          return t ? cachedView(t) : null;
        }
        case "bloom": {
          const t = this.bloomTex.get(key);
          return t ? cachedView(t) : null;
        }
        case "scene":
          return this.sceneTex ? cachedView(this.sceneTex) : null;
        case "data": {
          const t = this.dataTex.get(parsed.dataKey)?.[parsed.index];
          return t ? cachedView(t) : null;
        }
        case "other":
          return resolveExtra(key);
      }
    };

    // ---- data(ループ不変式の巻き上げ先。毎フレーム再計算 — time 依存があり得るため) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "data" || !p.spec.dataKey) continue;
      const texs = this.dataTex.get(p.spec.dataKey);
      if (!texs) continue;
      this.draw(encoder, p, texs.map((t) => cachedView(t)), resolve);
    }

    // ---- simulate: init(必要なら)→ update → swap ----
    for (const p of this.passes) {
      if (p.spec.kind !== "sim-init") continue;
      const entry = registry.getSim(p.spec.simName!);
      if (!entry || !entry.needsInit) continue;
      this.runSimPass(encoder, p, entry.write.map((t) => cachedView(t)), resolve);
      registry.swapSim(p.spec.simName!);
      entry.needsInit = false;
    }
    if (stepSims) {
      for (const p of this.passes) {
        if (p.spec.kind !== "sim-update") continue;
        const entry = registry.getSim(p.spec.simName!);
        if (!entry) continue;
        this.runSimPass(encoder, p, entry.write.map((t) => cachedView(t)), resolve);
        registry.swapSim(p.spec.simName!);
      }
    }

    // ---- raymarch ----
    for (const p of this.passes) {
      if (p.spec.kind !== "raymarch") continue;
      const tex = this.rmTex.get(p.spec.rmId!);
      if (!tex) continue;
      this.draw(encoder, p, [cachedView(tex)], resolve);
    }

    // ---- sprite(scatter の instanced 描画。レイマーチ結果に加算ブレンドで重ね描き。ADR-0014) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "sprite" || p.spec.spriteRmId === undefined) continue;
      const tex = this.rmTex.get(p.spec.spriteRmId);
      if (!tex) continue;
      this.draw(encoder, p, [cachedView(tex)], resolve, "load", 6, p.spec.spriteCount ?? 1);
    }

    // ---- strip3d(3D line/bezier の instanced 描画。sprite と同じくレイマーチ結果に
    // 深度テストなしで重ね描き。ADR-0036) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "strip3d" || p.spec.strip3RmId === undefined || p.spec.strip3VertexCount === undefined) continue;
      const tex = this.rmTex.get(p.spec.strip3RmId);
      if (!tex) continue;
      this.draw(encoder, p, [cachedView(tex)], resolve, "load", p.spec.strip3VertexCount, p.spec.strip3Count ?? 1);
    }

    // ---- strip(2D line/bezier の instanced 描画。ADR-0044、ADR-0016 を差し替え) ----
    // march 不要で三角形ストリップを直接ラスタライズし、bloom より前に scene テクスチャへ
    // premultiplied で焼き込む(最初のバッチで clear、以降は load で累積)。場が "scene" キーで
    // これをサンプルして合成するため、glow の明るさが bloom の抽出に拾われ光暈になる
    if (this.sceneTex) {
      let firstStrip = true;
      for (const p of this.passes) {
        if (p.spec.kind !== "strip" || p.spec.stripVertexCount === undefined) continue;
        this.draw(encoder, p, [cachedView(this.sceneTex)], resolve, firstStrip ? "clear" : "load", p.spec.stripVertexCount, p.spec.stripCount ?? 1);
        firstStrip = false;
      }
    }

    // ---- bloom(ダウンサンプル+ブラー多パス連鎖。ADR-0019) ----
    // 生成順(extract → down1 → down2 → up1 → up0)が依存順そのものなので、
    // compiled.passes の並び順どおりに実行すればよい
    for (const p of this.passes) {
      if (p.spec.kind !== "bloom-extract" && p.spec.kind !== "bloom-down" && p.spec.kind !== "bloom-up") continue;
      const tex = this.bloomTex.get(p.spec.bloomOutKey!);
      if (!tex) continue;
      this.draw(encoder, p, [cachedView(tex)], resolve);
    }

    // ---- image(最終) ----
    for (const p of this.passes) {
      if (p.spec.kind !== "image") continue;
      if (!this.colorTex) continue;
      this.draw(encoder, p, [cachedView(this.colorTex)], resolve);
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
    this.sceneTex?.destroy();
    for (const t of this.rmTex.values()) t.destroy();
    for (const texs of this.dataTex.values()) for (const t of texs) t.destroy();
    this.dummyTex?.destroy();
    this.uniformBuffer.destroy();
  }
}
