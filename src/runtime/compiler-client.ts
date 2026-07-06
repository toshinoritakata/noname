// コンパイラ Worker への薄いクライアント(implementation.md 7章のレイテンシ予算対応)。
// 重い同期コンパイルをメインスレッドから追い出し、キー入力とフレームループが
// 常に応答できるようにする(src/compiler/worker.ts 参照)。

import type { CompileResult } from "../compiler/index.ts";

interface Pending {
  resolve: (r: CompileResult) => void;
}

export class CompilerClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("../compiler/worker.js", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (ev: MessageEvent<{ id: number; result: CompileResult }>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      p.resolve(ev.data.result);
    });
  }

  compile(src: string): Promise<CompileResult> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ id, src });
    });
  }
}
