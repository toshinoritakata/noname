// コンパイラ専用の Web Worker(implementation.md 7章のレイテンシ予算対応)。
//
// 背景: parse/infer/stage/WGSL 生成は全部同期 JS で、プログラムが複雑になるほど
// 実行時間が伸びる。メインスレッドで直接呼ぶと、その間キー入力の処理(テキスト
// エリアの再描画・rAF のフレームループ)が止まり「レンダリングが重くなるとエディタの
// 入力も重くなる」体感になる。コンパイラをこの Worker に隔離し、メインスレッドは
// 常に入力とレンダリングのフレームループだけに専念できるようにする。
//
// GPU 呼び出し(シェーダコンパイル・パイプライン生成)はメインスレッド側に残す
// (ここで作るのは WGSL 文字列までの、構造化複製可能なプレーンデータだけ)。

import { compile, needsGlslFrontend } from "./index.ts";
import type { GlslFrontend } from "./stdlib.ts";

let glslFrontend: GlslFrontend | null = null;

interface Req {
  id: number;
  src: string;
}

self.addEventListener("message", (ev: MessageEvent<Req>) => {
  void handle(ev.data);
});

async function handle(req: Req): Promise<void> {
  const { id, src } = req;
  if (needsGlslFrontend(src) && !glslFrontend) {
    try {
      const mod = await import("./glsl.ts");
      glslFrontend = mod.glslToWgsl;
    } catch (e) {
      (self as unknown as Worker).postMessage({
        id,
        result: {
          program: null,
          diagnostics: [
            {
              severity: "error",
              message: `GLSL 変換器の読み込みに失敗しました: ${e instanceof Error ? e.message : e}`,
              span: { start: 0, end: 0 },
            },
          ],
        },
      });
      return;
    }
  }
  const result = compile(src, glslFrontend ?? undefined);
  (self as unknown as Worker).postMessage({ id, result });
}
