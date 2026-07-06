// WebGPU の初期化(ADR-0006: ブラウザ+WebGPU)。

export interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!("gpu" in navigator)) {
    throw new Error("このブラウザは WebGPU に対応していません(Chrome / Edge / Safari 18+ をお使いください)");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU アダプタが見つかりません");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU コンテキストが取得できません");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  return { device, context, format, canvas };
}

/** 作業テクスチャの共通フォーマット(filterable + renderable) */
export const WORK_FORMAT: GPUTextureFormat = "rgba16float";

export function createWorkTexture(device: GPUDevice, width: number, height: number, label: string): GPUTexture {
  return device.createTexture({
    label,
    size: { width: Math.max(1, width), height: Math.max(1, height) },
    format: WORK_FORMAT,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
}
