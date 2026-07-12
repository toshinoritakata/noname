// コンパイラ Worker への薄いクライアント(implementation.md 7章のレイテンシ予算対応)。
// 重い同期コンパイルをメインスレッドから追い出し、キー入力とフレームループが
// 常に応答できるようにする(src/compiler/worker.ts 参照)。

import type { CompileResult } from "../compiler/index.ts";
import type { Diagnostic } from "../compiler/diag.ts";

interface Pending {
  resolve: (r: CompileResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// Worker がハングした(クラッシュせず応答もしない)場合の安全弁。
// この時間を超えたら compile() を諦めて error diagnostic で解決する
const COMPILE_TIMEOUT_MS = 15000;

function errorResult(message: string): CompileResult {
  const diagnostics: Diagnostic[] = [{ severity: "error", message, span: { start: 0, end: 0 } }];
  return { program: null, diagnostics };
}

export class CompilerClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("../compiler/worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (ev: MessageEvent<{ id: number; result: CompileResult }>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      clearTimeout(p.timeout);
      this.pending.delete(ev.data.id);
      p.resolve(ev.data.result);
    });
    // Worker のクラッシュ/破損メッセージを診断できずに放置すると、compile() が
    // 永久に解決せず evaluate() 呼び出し元(main.ts の evaluating フラグ)が
    // 恒久的にロックされ、以後の全編集が黙って無視される(ADR-0010 の「映像は
    // 止まらない」が「編集も二度と反映されない」を隠してしまう罠)。
    // 待機中の要求を全部エラーとして解決し、Worker を作り直して復旧する
    worker.addEventListener("error", (ev) => {
      this.failAll(`コンパイラ Worker がクラッシュしました: ${ev.message}`);
    });
    worker.addEventListener("messageerror", () => {
      this.failAll("コンパイラ Worker からのメッセージが破損しています");
    });
    return worker;
  }

  private failAll(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.resolve(errorResult(message));
    }
    this.pending.clear();
    this.worker.terminate();
    this.worker = this.createWorker();
  }

  compile(src: string): Promise<CompileResult> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // 単に resolve するだけだと、無限ループでハングした worker は生き続け
        // (CPU 100%)、以後の全コンパイルが毎回タイムアウトするだけになる。
        // failAll で terminate+作り直しまで行い、真のハングから復旧する
        this.failAll("コンパイラ Worker が応答しません(タイムアウト)");
      }, COMPILE_TIMEOUT_MS);
      this.pending.set(id, { resolve, timeout });
      this.worker.postMessage({ id, src });
    });
  }
}
