// エントリポイント: エディタ(textarea)+ WebGPU ランタイムの配線。
// - 入力を検知して自動評価する(デバウンス付き)。エラー時は直前の正常プログラムが
//   走り続ける(ADR-0010)ので、打鍵の途中で構文が壊れていても映像は乱れない
// - Shift+Enter はデバウンスを待たずに即時評価する明示トリガー
// - 数値リテラルの上で Alt+ドラッグするとスクラブ(uniform 高速経路の見せ場、ADR-0008)

import { formatDiagnostic } from "./compiler/diag.ts";
import { EXAMPLES } from "./examples.ts";
import { initGPU } from "./runtime/gpu.ts";
import { makeTuioAdapter } from "./runtime/inputs.ts";
import { Renderer } from "./runtime/renderer.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} が見つかりません`);
  return el as T;
};

async function boot(): Promise<void> {
  const boot = $("boot");
  const editor = $<HTMLTextAreaElement>("editor");
  const diagEl = $<HTMLPreElement>("diagnostics");
  const statusEl = $("status");
  const canvas = $<HTMLCanvasElement>("stage") as unknown as HTMLCanvasElement;
  const picker = $<HTMLSelectElement>("example-picker");

  const setStatus = (s: string): void => {
    statusEl.textContent = s;
  };

  // キャンバスの実サイズ追従
  const resize = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  let renderer: Renderer;
  try {
    const gpu = await initGPU(canvas);
    renderer = new Renderer(gpu);
  } catch (e) {
    boot.innerHTML = `<div><strong>WebGPU 初期化エラー</strong><br><code>${e instanceof Error ? e.message : e}</code></div>`;
    return;
  }
  renderer.inputs.registerAdapter(makeTuioAdapter());
  renderer.inputs.onAudioState = setStatus;
  boot.classList.add("ready");
  boot.textContent = "ready";

  // デバッグ・検証用フック(インスペクタの足場)
  (window as unknown as { __noname: unknown }).__noname = renderer;
  renderer.gpu.device.addEventListener("uncapturederror", (e) => {
    console.error("[noname webgpu]", (e as GPUUncapturedErrorEvent).error.message);
  });

  // ---- サンプル ----
  for (const [i, ex] of EXAMPLES.entries()) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = ex.name;
    picker.appendChild(opt);
  }
  const loadExample = (i: number): void => {
    const ex = EXAMPLES[(i + EXAMPLES.length) % EXAMPLES.length];
    picker.value = String(EXAMPLES.indexOf(ex));
    editor.value = ex.source;
    void evaluate();
  };
  picker.addEventListener("change", () => loadExample(Number(picker.value)));
  $("prev-example").addEventListener("click", () => loadExample(Number(picker.value) - 1));
  $("next-example").addEventListener("click", () => loadExample(Number(picker.value) + 1));

  // ---- 評価 ----
  let lastGoodSource = "";
  const evaluate = async (): Promise<void> => {
    const src = editor.value;
    setStatus("compiling…");
    const r = await renderer.evaluate(src);
    const errors = r.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      diagEl.classList.remove("ok");
      diagEl.textContent = errors.map((d) => formatDiagnostic(src, d)).join("\n\n");
      setStatus(`エラー(映像は直前のプログラムを維持) ${r.compileMs.toFixed(0)}ms`);
      return;
    }
    lastGoodSource = src;
    diagEl.classList.add("ok");
    diagEl.textContent = r.diagnostics.map((d) => formatDiagnostic(src, d)).join("\n\n");
    setStatus(
      r.outcome === "fast"
        ? `uniform 更新のみ ${r.compileMs.toFixed(1)}ms`
        : `swap ${r.compileMs.toFixed(0)}ms`,
    );
  };
  // 入力のたびに即評価すると打鍵ごとにコンパイラが走ってしまうため、短い無入力
  // (デバウンス)を待ってから評価する。エラー時は直前の正常プログラムを維持する
  // (ADR-0010)ので、打鍵の途中で構文が壊れていても映像は止まらない
  const DEBOUNCE_MS = 250;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleEvaluate = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    setStatus("編集中…");
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void evaluate();
    }, DEBOUNCE_MS);
  };
  editor.addEventListener("input", scheduleEvaluate);
  editor.addEventListener("keydown", (e) => {
    // Shift+Enter はデバウンスを待たずに即時評価する明示トリガー
    if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      void evaluate();
    }
  });

  // ---- 数値スクラブ(Alt+ドラッグ) ----
  let scrub: { start: number; end: number; value: number; decimals: number; x0: number } | null = null;
  editor.addEventListener("pointerdown", (e) => {
    if (!e.altKey) return;
    const pos = caretIndexAt(editor);
    const m = numberAt(editor.value, pos);
    if (!m) return;
    e.preventDefault();
    editor.classList.add("scrubbing");
    editor.setPointerCapture(e.pointerId);
    scrub = { ...m, x0: e.clientX };
  });
  editor.addEventListener("pointermove", (e) => {
    if (!scrub) return;
    const dx = e.clientX - scrub.x0;
    const step = Math.pow(10, -scrub.decimals);
    const nv = scrub.value + dx * step * 0.5;
    const text = nv.toFixed(scrub.decimals);
    const src = editor.value.slice(0, scrub.start) + text + editor.value.slice(scrub.end);
    if (src !== editor.value) {
      const selStart = editor.selectionStart;
      editor.value = src;
      editor.selectionStart = editor.selectionEnd = selStart;
      scrub.end = scrub.start + text.length;
      void evaluate(); // 形が同じなら uniform 更新だけ(< 1 フレーム)
    }
  });
  const endScrub = (): void => {
    scrub = null;
    editor.classList.remove("scrubbing");
  };
  editor.addEventListener("pointerup", endScrub);
  editor.addEventListener("pointercancel", endScrub);

  // 初期プログラム
  loadExample(0);
  void lastGoodSource;
}

/** テキストエリア内で、直近のクリック位置に相当するキャレット位置を返す */
function caretIndexAt(editor: HTMLTextAreaElement): number {
  return editor.selectionStart ?? 0;
}

/** pos 位置にある数値リテラルの範囲を探す */
function numberAt(src: string, pos: number): { start: number; end: number; value: number; decimals: number } | null {
  const re = /\d+(\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index <= pos && pos <= m.index + m[0].length) {
      const decimals = m[1] ? m[1].length - 1 : 0;
      return { start: m.index, end: m.index + m[0].length, value: Number(m[0]), decimals };
    }
    if (m.index > pos) break;
  }
  return null;
}

boot().catch((e) => {
  const el = document.getElementById("boot");
  if (el) el.innerHTML = `<div><strong>起動エラー</strong><br><code>${e instanceof Error ? e.message : e}</code></div>`;
});
