// コンパイラのドライバ: ソース → parse → staging → WGSL(implementation.md 0章)。
// 型推論(infer.ts)は診断品質のための層で、staging の前に best-effort で走る。

import type { Diagnostic } from "./diag.ts";
import { parse } from "./parser.ts";
import { stageProgram } from "./stage.ts";
import type { GlslFrontend } from "./stdlib.ts";
import { generateWGSL } from "./wgsl.ts";
import type { CompiledProgram } from "./pass-contract.ts";
import { inferProgram } from "./infer.ts";

export interface CompileResult {
  program: CompiledProgram | null;
  diagnostics: Diagnostic[];
}

export function compile(src: string, glsl?: GlslFrontend): CompileResult {
  const diagnostics: Diagnostic[] = [];
  const parsed = parse(src);
  diagnostics.push(...parsed.diagnostics);
  if (parsed.diagnostics.some((d) => d.severity === "error")) {
    return { program: null, diagnostics };
  }

  // 型推論(best-effort): エラーは診断として出すが、staging が最終判定
  diagnostics.push(...inferProgram(parsed.program, src));

  const staged = stageProgram(parsed.program, src, glsl);
  // staging のエラーは重複しがちなので、同一 span の推論エラーがあれば後者を残す
  for (const d of staged.diagnostics) {
    if (!diagnostics.some((x) => x.message === d.message && x.span.start === d.span.start)) {
      diagnostics.push(d);
    }
  }
  if (!staged.program) {
    return { program: null, diagnostics };
  }
  const program = generateWGSL(staged.program);
  return { program, diagnostics };
}

/** ソースに glsl / shadertoy ブロックが含まれるか(変換器の遅延ロード判定に使う) */
export function needsGlslFrontend(src: string): boolean {
  return /\b(glsl|shadertoy)\s*(\(|""")/.test(src) || /\b(glsl|shadertoy)\b[\s\S]{0,80}"""/.test(src);
}
