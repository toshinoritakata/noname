// FFI(ADR-0011)。元 stdlib.ts 623-750行。
// stageWgslBlock はメインの stdlib.ts から re-export される(worker.ts/stage.ts 等の
// 既存 import 経路を変えないため)。

import { CompileError, type Span } from "../diag.ts";
import { fnv1a, type IRType } from "../ir.ts";
import { num, timeNode, vecV } from "../ops.ts";
import type { Ctx, Value, VField } from "../value.ts";
import type { Expr } from "../ast.ts";

export type GlslFrontend = (src: string, kind: "glsl" | "shadertoy", fnName: string) => string;

interface FfiType {
  kind: "field";
  dim: 2 | 3;
  result: IRType;
}

export function parseFfiType(e: Expr, span: Span): FfiType {
  // 受け付ける形: Image / Field Float / Field Vec2|Vec3|Color / Field 2 Float / Field 3 Float ...
  const parts: string[] = [];
  let cur: Expr = e;
  const flat = (x: Expr): void => {
    if (x.k === "app") {
      flat(x.fn);
      flat(x.arg);
    } else if (x.k === "var") parts.push(x.name);
    else if (x.k === "num") parts.push(String(x.value));
    else {
      throw new CompileError("FFI の型注釈が解釈できません(例: Field Float / Field 3 Float / Image)", span);
    }
  };
  flat(cur);
  if (parts.length === 1 && parts[0] === "Image") return { kind: "field", dim: 2, result: "vec4" };
  if (parts[0] !== "Field") {
    throw new CompileError(`FFI の型注釈は Field か Image で始まります(\`${parts[0]}\` は不明)`, span);
  }
  let dim: 2 | 3 = 2;
  let idx = 1;
  if (parts[1] === "2" || parts[1] === "3") {
    dim = parts[1] === "3" ? 3 : 2;
    idx = 2;
  }
  const resName = parts[idx] ?? "Float";
  const result: IRType =
    resName === "Float"
      ? "f32"
      : resName === "Vec2"
        ? "vec2"
        : resName === "Vec3" || resName === "Vec"
          ? "vec3"
          : resName === "Color" || resName === "Vec4"
            ? "vec4"
            : (() => {
                throw new CompileError(`FFI の結果型 \`${resName}\` は不明です(Float / Vec2 / Vec3 / Color)`, span);
              })();
  return { kind: "field", dim, result };
}

/** ブロック内の最初の `fn 名(` を一意な名前にリネームする */
export function renameFfiFn(src: string, newName: string): { src: string; ok: boolean } {
  const m = src.match(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!m) return { src, ok: false };
  const orig = m[1];
  const renamed = src.replaceAll(new RegExp(`\\b${orig}\\b`, "g"), newName);
  return { src: renamed, ok: true };
}

export function stageWgslBlock(
  ctx: Ctx & { glsl?: GlslFrontend },
  kind: "wgsl" | "glsl" | "shadertoy",
  spine: Expr[],
  span: Span,
): Value {
  let typeSpec: FfiType;
  let srcExpr: Expr;
  if (kind === "shadertoy") {
    if (spine.length !== 1) throw new CompileError("shadertoy ブロックは shadertoy \"\"\"...\"\"\" の形です", span);
    typeSpec = { kind: "field", dim: 2, result: "vec4" };
    srcExpr = spine[0];
  } else {
    if (spine.length !== 2) {
      throw new CompileError(`${kind} ブロックは ${kind} (型) \"\"\"...\"\"\" の形です`, span);
    }
    typeSpec = parseFfiType(spine[0], spine[0].span);
    srcExpr = spine[1];
  }
  if (srcExpr.k !== "str") {
    throw new CompileError("FFI ブロックの本体は \"\"\"...\"\"\" の文字列が必要です", srcExpr.span);
  }
  const rawSrc = srcExpr.text;
  const srcHash = fnv1a(kind + ":" + rawSrc);
  const fnName = `ffi_${srcHash}`;

  let wgslSrc: string;
  if (kind === "wgsl") {
    const r = renameFfiFn(rawSrc, fnName);
    if (!r.ok) {
      throw new CompileError("wgsl ブロックに `fn 名(...)` が見つかりません", srcExpr.span);
    }
    wgslSrc = r.src;
  } else {
    if (!ctx.glsl) {
      throw new CompileError(
        `${kind} ブロックの変換器がまだ読み込まれていません(もう一度評価してください)`,
        span,
      );
    }
    wgslSrc = ctx.glsl(rawSrc, kind, fnName);
  }

  if (!ctx.ffiFns.some((f) => f.name === fnName)) {
    ctx.ffiFns.push({ name: fnName, src: wgslSrc, srcHash, span });
  }

  const { dim, result } = typeSpec;
  return {
    v: "field",
    dim,
    fn: (c, p, s) => {
      void s;
      const t = timeNode(c);
      // 宣言次元と実際の座標次元が違う場合は適応する(2D 場を 3D 面で使う等。
      // 「壊れても絵になる」方向: vec3 → xy 射影、vec2 → z=0 拡張)
      const pt = c.arena.typeOf(p.ir);
      let pir = p.ir;
      if (dim === 2 && pt === "vec3") {
        pir = c.arena.node({ k: "swiz", a: p.ir, sel: "xy", t: "vec2" });
      } else if (dim === 3 && pt === "vec2") {
        const zero = c.arena.node({ k: "const", v: 0, t: "f32" });
        pir = c.arena.node({ k: "vec", parts: [p.ir, zero], t: "vec3" });
      }
      const node = c.arena.node({ k: "ffi", name: fnName, srcHash, args: [pir, t], t: result });
      if (result === "f32") return num(node);
      return vecV((result === "vec2" ? 2 : result === "vec3" ? 3 : 4) as 2 | 3 | 4, node);
    },
  } as VField;
}
