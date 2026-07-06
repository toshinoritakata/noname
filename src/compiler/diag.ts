// 診断とソース位置。全 AST ノード・IR ノード・WGSL 行がここの Span に写像される
// (implementation.md 1.1 / 6.3、ADR-0010)。

export interface Span {
  start: number; // source offset (inclusive)
  end: number; // source offset (exclusive)
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  span: Span;
  // 単一化失敗時などに「もう一方の由来」を示す(ADR-0009: 期待側と実際側の両 span)
  related?: { message: string; span: Span }[];
}

export function span(start: number, end: number): Span {
  return { start, end };
}

export function merge(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

/** offset → 1-based line/col。エディタ表示・WGSL ソースマップ翻訳用 */
function lineCol(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const n = Math.min(offset, src.length);
  for (let i = 0; i < n; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}

export function formatDiagnostic(src: string, d: Diagnostic): string {
  const { line, col } = lineCol(src, d.span.start);
  const head = `${d.severity === "error" ? "エラー" : d.severity === "warning" ? "警告" : "情報"} ${line}:${col} ${d.message}`;
  const lines = [head];
  // 該当行の抜粋とカレット
  const lineStart = src.lastIndexOf("\n", d.span.start - 1) + 1;
  let lineEnd = src.indexOf("\n", d.span.start);
  if (lineEnd < 0) lineEnd = src.length;
  const text = src.slice(lineStart, lineEnd);
  if (text.trim().length > 0) {
    const caretLen = Math.max(1, Math.min(d.span.end, lineEnd) - d.span.start);
    lines.push("  " + text);
    lines.push("  " + " ".repeat(d.span.start - lineStart) + "^".repeat(caretLen));
  }
  if (d.related) {
    for (const r of d.related) {
      const rc = lineCol(src, r.span.start);
      lines.push(`  └ ${rc.line}:${rc.col} ${r.message}`);
    }
  }
  return lines.join("\n");
}

/** コンパイルを打ち切るための例外。span 付きで必ず元コードに帰着する */
export class CompileError extends Error {
  diagnostic: Diagnostic;
  constructor(message: string, sp: Span, related?: { message: string; span: Span }[]) {
    super(message);
    this.diagnostic = { severity: "error", message, span: sp, related };
  }
}
