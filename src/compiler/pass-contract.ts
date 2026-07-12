// compiler↔runtime パス契約(先例: tex-keys.ts のテクスチャキー契約の集約と同じ流儀)。
// wgsl.ts(compiler)が発行し、program.ts/renderer.ts(runtime)が読み戻す「パスの形」を
// 1つの module に集約する。純データ+純関数のみ — Worker の postMessage を越えるため
// 関数を含む型は置かない。GPU API 型(GPUDevice 等)にも依存しない。
//
// 契約:
// ① パス列(CompiledProgram.passes)は emit 順=依存順であり、runtime はその順序を
//    前提に実行してよい。特に bloom 連鎖(extract → down1..N → upN..0)は
//    compiled.passes の並び順どおりに実行すれば依存関係が満たされる
//    (program.ts の execute() 内、bloom ループのコメント参照)。
// ② uniform header の意味論: `vec4f(width, height, px, 0)` の4要素固定ヘッダに続けて
//    入力スロット・昇格リテラル(ADR-0008)が並ぶ。詳細は uniformFloatCount 等を参照。
// ③ binding 規約: group(0) の binding 0 = uniform 構造体、1 = sampler、
//    2 以降が CompiledPass.textures の順にテクスチャ(BINDING_UNIFORM/BINDING_SAMPLER/
//    textureBinding 参照)。
// ④ hash はパスの再構築要否(≒プログラムの再コンパイルが必要か、ADR-0008 の
//    高速経路 vs swap)を完全に決定する。variant に field を新設するときは、
//    その field が生成コードの「見た目」に影響するなら構築子のハッシュ式に
//    必ず含めること。見落とすと ADR-0041 のバグ(scatter の N を変えても
//    再描画されない)が再発する。

import type { Span } from "./diag.ts";
import { fnv1a } from "./ir.ts";

// ---- パス本体(discriminated union) -----------------------------------------------

interface PassCore {
  code: string;
  /** MRT のターゲット数 */
  targets: number;
  /** group(0) binding 2.. に並ぶテクスチャキー(tex-keys.ts の語彙) */
  textures: string[];
  hash: string;
  /** 生成 WGSL の行番号(1-based)→ 元コードの span */
  lineSpans: (Span | null)[];
}

export interface SimPass extends PassCore {
  kind: "sim-init" | "sim-update";
  simName: string;
}

export interface DataPass extends PassCore {
  kind: "data";
  /** 出力テクスチャのキー接頭辞(`${dataKey}:${t}`) */
  dataKey: string;
  /** 要素数(instanced 描画バッチの場合は batch.count と一致、ADR-0041) */
  dataCount: number;
}

export interface RaymarchPass extends PassCore {
  kind: "raymarch";
  rmId: number;
  /** ループ重量級は半解像度で描く。dist の loopWorkOf から導出される値であり、
   * dist 自体は structuralHash に含まれているため、halfRes 自体を hash に
   * 追加で含める必要はない(導出値なので dist が変われば hash も変わる) */
  halfRes: boolean;
}

export interface SpritePass extends PassCore {
  kind: "sprite";
  /** 描画先の raymarch id(implementation.md 追加、ADR-0014) */
  rmId: number;
  /** インスタンス数 */
  count: number;
}

export interface StripPass extends PassCore {
  kind: "strip";
  /** インスタンス数と頂点数(implementation.md 追加、ADR-0016)。最終画像に直接描く */
  count: number;
  vertexCount: number;
}

export interface Strip3dPass extends PassCore {
  kind: "strip3d";
  /** 描画先の raymarch id・インスタンス数・頂点数(ADR-0036)。
   * sprite と同じく深度テストなしでレイマーチ結果に重ね描きする */
  rmId: number;
  count: number;
  vertexCount: number;
}

export interface BloomPass extends PassCore {
  kind: "bloom-extract" | "bloom-down" | "bloom-up";
  /** 対応する BloomPassSpec の id、出力テクスチャキー、解像度の分母(ADR-0019) */
  bloomId: number;
  outKey: string;
  resDivisor: number;
}

export interface ImagePass extends PassCore {
  kind: "image";
}

export type CompiledPass =
  | SimPass
  | DataPass
  | RaymarchPass
  | SpritePass
  | StripPass
  | Strip3dPass
  | BloomPass
  | ImagePass;

// ---- kind 別構築子(ハッシュ計算を所有する。ADR-0041) -------------------------------
//
// 各構築子は「variant field(hash に入るものは自動で入る)」+「hash 専用パラメータ
// (structuralHash 文字列・loopId・segs・キー等、IR 自体には現れない数値)」を
// 型で受け取り、現行 wgsl.ts と byte 単位で同一のハッシュ入力文字列を組み立てる。

export function makeSimPass(args: {
  kind: "sim-init" | "sim-update";
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  simName: string;
  /** SimHandle.sig(BufferRegistry の照合キーの一部でもある構造署名) */
  sig: string;
  structuralHash: string;
  inputs: string[];
}): SimPass {
  const phase = args.kind === "sim-init" ? "init" : "update";
  const hash = fnv1a(`${args.sig}:${phase}:${args.structuralHash}:${args.inputs.join(",")}`);
  return {
    kind: args.kind,
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    simName: args.simName,
    hash,
  };
}

/** データパスの由来を区別する接頭辞(現行の hash 文字列接頭辞と一致させる) */
export type DataPassLabel = "data" | "sprite-data" | "strip-data" | "strip3-data";

export function makeDataPass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  dataKey: string;
  dataCount: number;
  /** "data"(ループ不変式の巻き上げ、count は hash に含めない)か、
   * instanced 描画バッチのデータパス("sprite-data"/"strip-data"/"strip3-data"、
   * count を hash に含める。ADR-0041) */
  label: DataPassLabel;
  structuralHash: string;
  inputs: string[];
}): DataPass {
  const { code, targets, textures, lineSpans, dataKey, dataCount, label, structuralHash, inputs } = args;
  const hashInput =
    label === "data"
      ? `data:${structuralHash}:${inputs.join(",")}`
      : `${label}:${dataCount}:${structuralHash}:${inputs.join(",")}`;
  return { kind: "data", code, targets, textures, lineSpans, dataKey, dataCount, hash: fnv1a(hashInput) };
}

export function makeRaymarchPass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  rmId: number;
  halfRes: boolean;
  /** arena.structuralHash([dist, colour, eye, target, fov]) */
  structuralHash: string;
  inputs: string[];
}): RaymarchPass {
  const hash = fnv1a(`rm:${args.structuralHash}:${args.inputs.join(",")}`);
  return {
    kind: "raymarch",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    rmId: args.rmId,
    halfRes: args.halfRes,
    hash,
  };
}

export function makeSpritePass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  rmId: number;
  count: number;
  loopId: number;
  /** arena.structuralHash([eye, target, fov]) */
  structuralHash: string;
  inputs: string[];
}): SpritePass {
  const hash = fnv1a(`sprite:${args.loopId}:${args.count}:${args.structuralHash}:${args.inputs.join(",")}`);
  return {
    kind: "sprite",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    rmId: args.rmId,
    count: args.count,
    hash,
  };
}

export function makeStrip3dPass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  rmId: number;
  count: number;
  vertexCount: number;
  loopId: number;
  segs: number;
  /** arena.structuralHash([eye, target, fov]) */
  structuralHash: string;
  inputs: string[];
}): Strip3dPass {
  const hash = fnv1a(
    `strip3:${args.loopId}:${args.count}:${args.segs}:${args.structuralHash}:${args.inputs.join(",")}`,
  );
  return {
    kind: "strip3d",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    rmId: args.rmId,
    count: args.count,
    vertexCount: args.vertexCount,
    hash,
  };
}

export function makeStripPass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  count: number;
  vertexCount: number;
  loopId: number;
  segs: number;
  inputs: string[];
}): StripPass {
  const hash = fnv1a(`strip:${args.loopId}:${args.count}:${args.segs}:${args.inputs.join(",")}`);
  return {
    kind: "strip",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    count: args.count,
    vertexCount: args.vertexCount,
    hash,
  };
}

export function makeBloomExtractPass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  bloomId: number;
  outKey: string;
  resDivisor: number;
  structuralHash: string;
  inputs: string[];
}): BloomPass {
  const hash = fnv1a(`bloom-n:${args.bloomId}:${args.structuralHash}:${args.inputs.join(",")}`);
  return {
    kind: "bloom-extract",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    bloomId: args.bloomId,
    outKey: args.outKey,
    resDivisor: args.resDivisor,
    hash,
  };
}

export function makeBloomDownPass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  bloomId: number;
  outKey: string;
  resDivisor: number;
  srcKey: string;
  dstKey: string;
}): BloomPass {
  const hash = fnv1a(`bloom-d:${args.bloomId}:${args.srcKey}:${args.dstKey}`);
  return {
    kind: "bloom-down",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    bloomId: args.bloomId,
    outKey: args.outKey,
    resDivisor: args.resDivisor,
    hash,
  };
}

export function makeBloomUpPass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  bloomId: number;
  outKey: string;
  resDivisor: number;
  smallKey: string;
  skipKey: string;
  dstKey: string;
}): BloomPass {
  const hash = fnv1a(`bloom-u:${args.bloomId}:${args.smallKey}:${args.skipKey}:${args.dstKey}`);
  return {
    kind: "bloom-up",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    bloomId: args.bloomId,
    outKey: args.outKey,
    resDivisor: args.resDivisor,
    hash,
  };
}

export function makeImagePass(args: {
  code: string;
  targets: number;
  textures: string[];
  lineSpans: (Span | null)[];
  structuralHash: string;
  inputs: string[];
}): ImagePass {
  const hash = fnv1a(`img:${args.structuralHash}:${args.inputs.join(",")}`);
  return {
    kind: "image",
    code: args.code,
    targets: args.targets,
    textures: args.textures,
    lineSpans: args.lineSpans,
    hash,
  };
}

// ---- finalize(パイプラインの誤共有防止 + プログラム全体のハッシュ) ------------------

/**
 * パイプラインの誤共有を防ぐため、uniform スロット数とテクスチャ構成もハッシュに含める
 * (シェーダ本文の `array<vec4f, N>` とバインディング数がキャッシュキーに効く)。
 * generateWGSL の最後、全パス構築後に一度だけ呼ぶ。
 */
export function finalizePassHashes(passes: CompiledPass[], slotCount: number): void {
  for (const p of passes) {
    p.hash = fnv1a(`${p.hash}:${slotCount}:${p.textures.join(",")}`);
  }
}

/** プログラム全体のハッシュ(ADR-0008 の高速経路判定に使う) */
export function programHashOf(passes: CompiledPass[], usesPrev: boolean): string {
  return fnv1a(passes.map((p) => p.hash).join("|") + "|prev:" + usesPrev);
}

// ---- CompiledProgram / UniformLayout / SimRuntimeSpec -----------------------------

export interface SimRuntimeSpec {
  name: string;
  sig: string;
  kind: "grid" | "array";
  width: number;
  height: number;
  texCount: number;
}

export interface UniformLayout {
  /** 入力スロット名(time / etime / audio.lo / lag:... など)。slots 配列の先頭から詰める */
  inputs: string[];
  /** リテラルの開始 float オフセット(inputs の直後) */
  literalBase: number;
  literalCount: number;
  /** slots の vec4 数 */
  slotCount: number;
}

export interface CompiledProgram {
  passes: CompiledPass[];
  uniformLayout: UniformLayout;
  literals: { value: number; span: Span }[];
  fade: { value: number; unit: "s" | "beat" } | null;
  sims: SimRuntimeSpec[];
  usesPrev: boolean;
  derivedInputs: { name: string; source: string; kind: "lag"; k: number }[];
  /** `text`(ADR-0032)がラスタライズを要求する文字列。key ごとに重複なし */
  textTextures: { key: string; text: string }[];
  programHash: string;
}

// ---- uniform layout 契約 -----------------------------------------------------------

/** header は `vec4f(width, height, px, 0)`。w 成分は未使用(将来の予約) */
export const HEADER_FLOATS = 4;

/** uniform バッファ全体の float 数(header + slots) */
export function uniformFloatCount(layout: UniformLayout): number {
  return HEADER_FLOATS + layout.slotCount * 4;
}

/** 入力スロット i の float オフセット */
export function inputOffset(i: number): number {
  return HEADER_FLOATS + i;
}

/** 昇格リテラル(ADR-0008)i の float オフセット */
export function literalOffset(layout: UniformLayout, i: number): number {
  return HEADER_FLOATS + layout.literalBase + i;
}

/** 1px 相当のワールド座標幅(program.ts / renderer.ts で重複していた式) */
export function pxOf(width: number, height: number): number {
  return 2 / Math.max(1, Math.min(width, height));
}

/** uniform 構造体+サンプラーの WGSL 宣言(binding 0/1) */
export function uniformWgslDecl(slotCount: number): string {
  const n = Math.max(1, slotCount);
  return `struct Uniforms {
  header: vec4f,
  slots: array<vec4f, ${n}>,
}
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var samp: sampler;
`;
}

// ---- binding 契約 --------------------------------------------------------------------

export const BINDING_UNIFORM = 0;
export const BINDING_SAMPLER = 1;

/** テクスチャ i(CompiledPass.textures のインデックス)の binding 番号 */
export function textureBinding(i: number): number {
  return i + 2;
}

/** テクスチャ群の WGSL 宣言(binding 2..) */
export function textureWgslDecls(texKeys: string[]): string {
  return texKeys.map((_, i) => `@group(0) @binding(${textureBinding(i)}) var tex${i}: texture_2d<f32>;`).join("\n");
}
