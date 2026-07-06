// Staging(部分評価)— この処理系の心臓部(implementation.md 3章、ADR-0007)。
// 型付き Core(ここでは AST)を評価し、すべての関数適用を β 簡約して
// 一階の Field IR に落とす。値は value.ts、リフト規則は ops.ts。
//
// 評価は具体値に対する動的ディスパッチで行う。次元多相はここで単相化され、
// クロージャは必ず展開される(全域言語の制限により停止が保証される)。

import type { Bind, Expr, Program } from "./ast.ts";
import { CompileError, type Diagnostic, type Span } from "./diag.ts";
import { IRArena, vecType, type NodeId } from "./ir.ts";
import {
  asVec,
  binValue,
  describe,
  fail,
  negValue,
  num,
  selectValue,
  simToField,
  toImage,
  vecV,
} from "./ops.ts";
import { getBuiltin, stageWgslBlock, type GlslFrontend } from "./stdlib.ts";
import {
  lookupEnv,
  type Ctx,
  type Env,
  type SimPassSpec,
  type RaymarchPassSpec,
  type BloomPassSpec,
  type StripBatchSpec,
  type Value,
  type VVec,
} from "./value.ts";

export interface StagedProgram {
  arena: IRArena;
  /** 最終 2D 画像の vec4 ルート(coord = vec2 ワールド座標) */
  imageRoot: NodeId;
  sims: SimPassSpec[];
  raymarches: RaymarchPassSpec[];
  blooms: BloomPassSpec[];
  /** 2D の line/bezier ストリップバッチ(ADR-0016)。最終画像に加算ではなく上描きされる */
  stripBatches: StripBatchSpec[];
  usesPrev: boolean;
  derivedInputs: { name: string; source: string; kind: "lag"; k: number }[];
  ffiFns: { name: string; src: string; srcHash: string; span: Span }[];
  /** `<> dur` の静的値。null = 即時切替 */
  fade: { value: number; unit: "s" | "beat" } | null;
}

export interface StageResult {
  program: StagedProgram | null;
  diagnostics: Diagnostic[];
}

export function stageProgram(ast: Program, src: string, glsl?: GlslFrontend): StageResult {
  const diagnostics: Diagnostic[] = [];
  const arena = new IRArena();
  let idCounter = 0;
  const ctx: Ctx & { glsl?: GlslFrontend } = {
    arena,
    diags: diagnostics,
    src,
    apply: applyValue,
    bindingName: null,
    sims: [],
    raymarches: [],
    blooms: [],
    usesPrev: false,
    derivedInputs: [],
    ffiFns: [],
    timeStack: [],
    freshId: () => idCounter++,
    glsl,
  };

  try {
    const env: Env = { vars: new Map(), parent: null };
    for (const b of ast.binds) {
      ctx.bindingName = b.name;
      env.vars.set(b.name, evalBind(ctx, env, b));
      ctx.bindingName = null;
    }
    if (!ast.out) {
      throw new CompileError(
        "出力がありません。`out 式` を書くか、最後の行に式を置いてください",
        { start: src.length, end: src.length },
      );
    }
    const outVal = evalExpr(ctx, env, ast.out);
    const image = toImage(ctx, outVal, ast.out.span);
    const coord = arena.node({ k: "coord", t: "vec2" });
    const colour = image.fn(ctx, vecV(2, coord), ast.out.span);
    const imageRoot = asColor4(ctx, colour, ast.out.span);

    // フェード時間は静的に決まる必要がある(ランタイムが CPU 側で使う)
    let fade: StagedProgram["fade"] = null;
    if (ast.fade) {
      const fv = evalExpr(ctx, env, ast.fade);
      if (fv.v === "dur" && fv.sval !== undefined) fade = { value: fv.sval, unit: fv.unit };
      else if (fv.v === "num" && fv.sval !== undefined) fade = { value: fv.sval, unit: "s" };
      else {
        throw new CompileError(
          "`<>` のクロスフェード時間は静的に決まる必要があります(例: 0.5s)",
          ast.fade.span,
        );
      }
    }

    return {
      program: {
        arena,
        imageRoot,
        sims: ctx.sims,
        raymarches: ctx.raymarches,
        blooms: ctx.blooms,
        stripBatches: image.stripBatches ?? [],
        usesPrev: ctx.usesPrev,
        derivedInputs: ctx.derivedInputs,
        ffiFns: ctx.ffiFns,
        fade,
      },
      diagnostics,
    };
  } catch (e) {
    if (e instanceof CompileError) {
      diagnostics.push(e.diagnostic);
      return { program: null, diagnostics };
    }
    throw e;
  }
}

function asColor4(ctx: Ctx, v: Value, span: Span): NodeId {
  if (v.v === "vec" && v.n === 4) return v.ir;
  fail(`内部エラー: 画像のルートが色(vec4)になりません(${describe(v)})`, span);
}

function evalBind(ctx: Ctx, env: Env, b: Bind): Value {
  if (b.params.length > 0) {
    return { v: "clo", params: b.params, body: b.expr, env };
  }
  return evalExpr(ctx, env, b.expr);
}

// ---- 評価器 -------------------------------------------------------------------

function evalExpr(ctx: Ctx, env: Env, e: Expr): Value {
  switch (e.k) {
    case "num":
      // 数値リテラルは uniform に昇格(ADR-0008)。sval は構造定数用に保持
      return num(ctx.arena.literal(e.value, e.span), e.value);

    case "time": {
      const lit = ctx.arena.literal(e.value, e.span);
      if (e.unit === "s") return { v: "dur", ir: lit, sval: e.value, unit: "s" };
      // beat は spb(1拍の秒数)を掛けて秒に換算
      const spb = ctx.arena.node({ k: "input", name: "spb", t: "f32" });
      return {
        v: "dur",
        ir: ctx.arena.node({ k: "bin", op: "*", a: lit, b: spb, t: "f32" }),
        sval: e.value,
        unit: "beat",
      };
    }

    case "str":
      return { v: "str", text: e.text };

    case "var": {
      const v = lookupEnv(env, e.name);
      if (v !== undefined) return v;
      const bi = getBuiltin(ctx, e.name, e.span);
      if (bi !== undefined) return bi;
      fail(`\`${e.name}\` は定義されていません`, e.span);
      break;
    }

    case "lam":
      return { v: "clo", params: e.params, body: e.body, env };

    case "app": {
      // FFI ブロックは型注釈の AST を特別扱いする(ADR-0011)
      const ffi = tryStageFfi(ctx, env, e);
      if (ffi) return ffi;
      const fn = evalExpr(ctx, env, e.fn);
      const arg = evalExpr(ctx, env, e.arg);
      return applyValue(ctx, fn, arg, e.span);
    }

    case "bin": {
      const a = evalExpr(ctx, env, e.left);
      const b = evalExpr(ctx, env, e.right);
      return binValue(ctx, e.op, a, b, e.opSpan);
    }

    case "neg":
      return negValue(ctx, evalExpr(ctx, env, e.expr), e.span);

    case "if": {
      const c = evalExpr(ctx, env, e.cond);
      const t = evalExpr(ctx, env, e.then);
      const f = evalExpr(ctx, env, e.else_);
      return selectValue(ctx, c, t, f, e.span);
    }

    case "let": {
      const scope: Env = { vars: new Map(), parent: env };
      const saved = ctx.bindingName;
      for (const b of e.binds) {
        ctx.bindingName = b.name;
        scope.vars.set(b.name, evalBind(ctx, scope, b));
      }
      ctx.bindingName = saved;
      return evalExpr(ctx, scope, e.body);
    }

    case "list":
      return { v: "list", items: e.items.map((it) => evalExpr(ctx, env, it)) };

    case "record": {
      const fields = new Map<string, Value>();
      for (const f of e.fields) fields.set(f.name, evalExpr(ctx, env, f.expr));
      return { v: "rec", fields };
    }

    case "field":
      return accessField(ctx, evalExpr(ctx, env, e.target), e.name, e.span);

    case "error":
      fail("解析エラーのため、この部分は評価できません", e.span);
      break;
  }
}

/** `wgsl (型) """..."""` / `glsl` / `shadertoy` の適用スパインを検出する */
function tryStageFfi(ctx: Ctx, env: Env, e: Expr & { k: "app" }): Value | null {
  // spine: app(app(wgsl, typeExpr), strExpr) または app(shadertoy, strExpr)
  const spine: Expr[] = [];
  let head: Expr = e;
  while (head.k === "app") {
    spine.unshift(head.arg);
    head = head.fn;
  }
  if (head.k !== "var") return null;
  const name = head.name;
  if (name !== "wgsl" && name !== "glsl" && name !== "shadertoy") return null;
  if (lookupEnv(env, name) !== undefined) return null; // ユーザーが同名を定義していたら譲る
  return stageWgslBlock(ctx, name, spine, e.span);
}

// ---- 適用 --------------------------------------------------------------------

function applyValue(ctx: Ctx, fn: Value, arg: Value, span: Span): Value {
  switch (fn.v) {
    case "clo": {
      const [p, ...rest] = fn.params;
      const scope: Env = { vars: new Map([[p.name, arg]]), parent: fn.env };
      if (rest.length > 0) {
        return { v: "clo", params: rest, body: fn.body, env: scope };
      }
      return evalExpr(ctx, scope, fn.body);
    }
    case "bi": {
      const args = [...fn.args, arg];
      if (args.length < fn.arity) {
        return { ...fn, args };
      }
      return fn.impl(ctx, args, span);
    }
    case "field":
      return sampleField(ctx, fn, arg, span);
    case "sim":
      return sampleField(ctx, simToField(ctx, fn.handle), arg, span);
    default:
      fail(`${describe(fn)} は関数ではないので適用できません`, span);
  }
}

/** 場を座標(またはインデックス)でサンプルする */
function sampleField(ctx: Ctx, f: { dim: number; fn: (c: Ctx, p: VVec, s: Span) => Value }, arg: Value, span: Span): Value {
  if (arg.v === "vec") return f.fn(ctx, arg, span);
  if (arg.v === "list") return f.fn(ctx, asVec(ctx, arg, span), span);
  if (arg.v === "num") {
    // 1D の場(パーティクル配列・fft)はスカラーでインデックスする
    const zero = ctx.arena.node({ k: "const", v: 0, t: "f32" });
    const p2 = ctx.arena.node({ k: "vec", parts: [arg.ir, zero], t: "vec2" });
    return f.fn(ctx, vecV(2, p2), span);
  }
  fail(`場のサンプルには座標かインデックスが必要ですが、${describe(arg)} が渡されました`, span);
}

// ---- フィールドアクセス ----------------------------------------------------------

const SWIZ_OK = new Set(["x", "y", "z", "w"]);

function accessField(ctx: Ctx, target: Value, name: string, span: Span): Value {
  switch (target.v) {
    case "rec": {
      const v = target.fields.get(name);
      if (v === undefined) {
        const keys = [...target.fields.keys()].join(", ");
        fail(`レコードに \`${name}\` はありません(あるのは: ${keys})`, span);
      }
      return v;
    }
    case "vec": {
      if ([...name].every((c) => SWIZ_OK.has(c)) && name.length >= 1 && name.length <= 4) {
        const idx = { x: 0, y: 1, z: 2, w: 3 } as const;
        for (const c of name) {
          if (idx[c as "x"] >= target.n) {
            fail(`${target.n}次元ベクトルに \`.${c}\` はありません`, span);
          }
        }
        const t = name.length === 1 ? "f32" : vecType(name.length);
        const ir = ctx.arena.node({ k: "swiz", a: target.ir, sel: name, t });
        return name.length === 1 ? num(ir) : vecV(name.length as 2 | 3 | 4, ir);
      }
      fail(`ベクトルの成分は .x .y .z .w です(\`.${name}\` は不明)`, span);
      break;
    }
    case "field": {
      // 場の射影: rd.y は「rd の y 成分の場」
      const f = target;
      let state = f.state;
      if (state && state.handle.channels.length > 1) {
        const ch = state.handle.channels.find((c) => c.path[0] === name);
        if (ch) state = { handle: state.handle, offset: ch.offset, len: ch.len };
      } else if (state && state.len > 1) {
        const idx = { x: 0, y: 1, z: 2, w: 3 }[name as "x"];
        if (idx !== undefined && idx < state.len) {
          state = { handle: state.handle, offset: state.offset + idx, len: 1 };
        }
      }
      return {
        v: "field",
        dim: f.dim,
        fn: (c, p, s) => accessField(c, f.fn(c, p, s), name, s),
        state,
      } as Value;
    }
    case "sim":
      return accessField(ctx, simToField(ctx, target.handle), name, span);
    case "cam": {
      if (name === "eye") return target.eye;
      if (name === "target") return target.target;
      if (name === "fov") return target.fov;
      fail(`カメラに \`${name}\` はありません(eye / target / fov)`, span);
      break;
    }
    default:
      fail(`${describe(target)} に \`.${name}\` はありません`, span);
  }
}

/** IR の time 入力ノードを別の式に置換した DAG を作る(slow / loop 用) */
export function substTime(ctx: Ctx, root: NodeId, newTime: NodeId): NodeId {
  const memo = new Map<NodeId, NodeId>();
  const a = ctx.arena;
  const go = (id: NodeId): NodeId => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const n = a.get(id);
    let out: NodeId;
    switch (n.k) {
      case "input":
        out = n.name === "time" ? newTime : id;
        break;
      case "bin":
        out = a.node({ ...n, a: go(n.a), b: go(n.b) });
        break;
      case "un":
        out = a.node({ ...n, a: go(n.a) });
        break;
      case "call":
        out = a.node({ ...n, args: n.args.map(go) });
        break;
      case "vec":
        out = a.node({ ...n, parts: n.parts.map(go) });
        break;
      case "swiz":
        out = a.node({ ...n, a: go(n.a) });
        break;
      case "select":
        out = a.node({ ...n, c: go(n.c), a: go(n.a), b: go(n.b) });
        break;
      case "sample":
        out = a.node({ ...n, p: go(n.p) });
        break;
      case "fetch":
        out = a.node({ ...n, i: go(n.i) });
        break;
      case "loop":
        out = a.node({ ...n, init: go(n.init), body: go(n.body) });
        break;
      case "ffi":
        out = a.node({ ...n, args: n.args.map(go) });
        break;
      default:
        out = id;
    }
    memo.set(id, out);
    return out;
  };
  return go(root);
}

/**
 * テスト・インスペクタ用: 式(図形)を評価して dist の IR ルートを得る。
 * SDF 性質テスト(境界 ≈ 0 / Lipschitz)は CPU インタプリタでこれを評価する。
 */
export function stageShapeDist(
  exprSrc: string,
  dim: 2 | 3 = 2,
): { arena: IRArena; root: NodeId } | { error: string } {
  // 式だけのプログラムとしてパースし、out に来た図形の dist を取り出す
  const parsed = parseForTest(exprSrc);
  if ("error" in parsed) return parsed;
  const diagnostics: Diagnostic[] = [];
  const arena = new IRArena();
  let idCounter = 0;
  const ctx: Ctx = {
    arena,
    diags: diagnostics,
    src: exprSrc,
    apply: applyValue,
    bindingName: null,
    sims: [],
    raymarches: [],
    blooms: [],
    usesPrev: false,
    derivedInputs: [],
    ffiFns: [],
    timeStack: [],
    freshId: () => idCounter++,
  };
  try {
    const env: Env = { vars: new Map(), parent: null };
    for (const b of parsed.ast.binds) {
      ctx.bindingName = b.name;
      env.vars.set(b.name, evalBind(ctx, env, b));
      ctx.bindingName = null;
    }
    if (!parsed.ast.out) return { error: "式がありません" };
    const v = evalExpr(ctx, env, parsed.ast.out);
    if (v.v !== "shape") return { error: `図形ではありません(${v.v})` };
    const coord = arena.node({ k: "coord", t: dim === 3 ? "vec3" : "vec2" });
    const d = v.dist(ctx, { v: "vec", n: dim, ir: coord }, parsed.ast.out.span);
    return { arena, root: d.ir };
  } catch (e) {
    if (e instanceof CompileError) return { error: e.diagnostic.message };
    throw e;
  }
}

function parseForTest(src: string): { ast: Program } | { error: string } {
  // 循環 import を避けるため動的 require はせず、parser を直接使う
  const { parse } = parserModule();
  const r = parse(src);
  if (r.diagnostics.some((d: Diagnostic) => d.severity === "error")) {
    return { error: r.diagnostics[0].message };
  }
  return { ast: r.program };
}

// parser.ts は stage.ts に依存しないため、静的 import で問題ない
import { parse as parseSrc } from "./parser.ts";
function parserModule(): { parse: typeof parseSrc } {
  return { parse: parseSrc };
}
