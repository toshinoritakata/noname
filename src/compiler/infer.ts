// 型推論 — HM 制限版+次元多相(implementation.md 2章、ADR-0009)。
// let 多相あり・高階の型変数なし・一般再帰なし。W アルゴリズム。
//
// 位置づけ: 診断品質のための層。スカラー昇格や Shape→Image などの暗黙変換を
// 含む最終的な意味判定は Staging(stage.ts)が具体値で行うため、ここは
// 「早く・分かりやすく」誤りを指摘する best-effort 層として動く。
// (単一化失敗時は期待側と実際側の両方の由来 span を示す)

import type { Bind, Expr, Program } from "./ast.ts";
import type { Diagnostic, Span } from "./diag.ts";

// ---- 型 ----------------------------------------------------------------------

type Dm = { d: "var"; id: number } | { d: "lit"; n: 2 | 3 | 4 };

type Ty =
  | { t: "var"; id: number }
  | { t: "con"; name: "Float" | "Bool" | "Dur" | "Str" | "Cam" | "Light" }
  | { t: "vec"; n: Dm }
  | { t: "field"; d: Dm; a: Ty }
  | { t: "shape"; d: Dm }
  | { t: "fun"; a: Ty; b: Ty }
  | { t: "list"; a: Ty }
  | { t: "rec"; fields: Map<string, Ty> | null } // null = 中身を追わない
  | { t: "pat"; a: Ty };

interface Scheme {
  vars: number[];
  dims: number[];
  ty: Ty;
}

const FLOAT: Ty = { t: "con", name: "Float" };
const BOOL: Ty = { t: "con", name: "Bool" };
const DUR: Ty = { t: "con", name: "Dur" };
const CAM: Ty = { t: "con", name: "Cam" };
const LIGHT: Ty = { t: "con", name: "Light" };
const COLOR: Ty = { t: "vec", n: { d: "lit", n: 4 } };

function fun(...ts: Ty[]): Ty {
  let r = ts[ts.length - 1];
  for (let i = ts.length - 2; i >= 0; i--) r = { t: "fun", a: ts[i], b: r };
  return r;
}

// ---- 推論器 -------------------------------------------------------------------

class Infer {
  diags: Diagnostic[] = [];
  private tv = new Map<number, Ty>(); // 型変数の束縛
  private dv = new Map<number, Dm>(); // 次元変数の束縛
  private counter = 0;
  /** span の由来: 型変数 id → その型が生まれた場所 */
  private origins = new Map<string, Span>();

  fresh(): Ty {
    return { t: "var", id: this.counter++ };
  }
  freshDim(): Dm {
    return { d: "var", id: this.counter++ };
  }

  resolve(ty: Ty): Ty {
    if (ty.t === "var") {
      const b = this.tv.get(ty.id);
      if (b) {
        const r = this.resolve(b);
        this.tv.set(ty.id, r);
        return r;
      }
    }
    return ty;
  }
  resolveDim(d: Dm): Dm {
    if (d.d === "var") {
      const b = this.dv.get(d.id);
      if (b) return this.resolveDim(b);
    }
    return d;
  }

  private snapshot(): [Map<number, Ty>, Map<number, Dm>] {
    return [new Map(this.tv), new Map(this.dv)];
  }
  private restore(s: [Map<number, Ty>, Map<number, Dm>]): void {
    this.tv = s[0];
    this.dv = s[1];
  }

  /** 単一化。失敗時 false(例外は投げない)。lift = 暗黙変換を許す */
  unify(a0: Ty, b0: Ty): boolean {
    const a = this.resolve(a0);
    const b = this.resolve(b0);
    if (a.t === "var") {
      if (b.t === "var" && b.id === a.id) return true;
      if (this.occurs(a.id, b)) return false;
      this.tv.set(a.id, b);
      return true;
    }
    if (b.t === "var") return this.unify(b, a);

    // 暗黙変換(スカラー昇格・flatten)を単一化として受け入れる
    if (this.liftOk(a, b) || this.liftOk(b, a)) return true;

    if (a.t === "con" && b.t === "con") return a.name === b.name || (a.name === "Dur" && b.name === "Float") || (a.name === "Float" && b.name === "Dur");
    if (a.t === "vec" && b.t === "vec") return this.unifyDim(a.n, b.n);
    if (a.t === "field" && b.t === "field") return this.unifyDim(a.d, b.d) && this.unify(a.a, b.a);
    if (a.t === "shape" && b.t === "shape") return this.unifyDim(a.d, b.d);
    if (a.t === "fun" && b.t === "fun") return this.unify(a.a, b.a) && this.unify(a.b, b.b);
    if (a.t === "list" && b.t === "list") return this.unify(a.a, b.a);
    if (a.t === "pat" && b.t === "pat") return this.unify(a.a, b.a);
    if (a.t === "rec" && b.t === "rec") {
      if (!a.fields || !b.fields) return true;
      for (const [k, ta] of a.fields) {
        const tb = b.fields.get(k);
        if (!tb) return false;
        if (!this.unify(ta, tb)) return false;
      }
      return true;
    }
    return false;
  }

  /** a が期待されるところに b が来たときの暗黙変換(片方向) */
  private liftOk(expected: Ty, actual: Ty): boolean {
    // Float → Field d Float(定数場)/ Color → Field d Color / vec → field of vec
    if (expected.t === "field") {
      const inner = this.resolve(expected.a);
      const s = this.snapshot();
      if (this.unify(inner, actual)) return true;
      this.restore(s);
      // Shape d → Field 2 Color(flatten)
      if (actual.t === "shape" && this.unify(expected.a, COLOR)) return true;
      // Pattern a → Field(cycle の値をそのまま場に)
      if (actual.t === "pat") return true;
    }
    // Shape → Image を関数側で受ける(<over> の左辺など)
    if (expected.t === "shape" && actual.t === "pat") return true;
    // リスト → ベクトル
    if (expected.t === "vec" && actual.t === "list") {
      return this.unify(actual.a, FLOAT);
    }
    // Dur → Float
    return false;
  }

  unifyDim(a0: Dm, b0: Dm): boolean {
    const a = this.resolveDim(a0);
    const b = this.resolveDim(b0);
    if (a.d === "var") {
      if (b.d === "var" && b.id === a.id) return true;
      this.dv.set(a.id, b);
      return true;
    }
    if (b.d === "var") return this.unifyDim(b, a);
    return a.n === b.n;
  }

  private occurs(id: number, ty0: Ty): boolean {
    const ty = this.resolve(ty0);
    switch (ty.t) {
      case "var":
        return ty.id === id;
      case "fun":
        return this.occurs(id, ty.a) || this.occurs(id, ty.b);
      case "field":
      case "list":
      case "pat":
        return this.occurs(id, ty.a);
      case "rec":
        if (ty.fields) {
          for (const v of ty.fields.values()) if (this.occurs(id, v)) return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** ドメイン語彙での型表示(ADR-0009) */
  show(ty0: Ty): string {
    const ty = this.resolve(ty0);
    switch (ty.t) {
      case "var":
        return "不明";
      case "con":
        switch (ty.name) {
          case "Float":
            return "数";
          case "Bool":
            return "真偽値";
          case "Dur":
            return "時間の長さ";
          case "Str":
            return "文字列";
          case "Cam":
            return "カメラ";
          case "Light":
            return "ライト";
        }
        break;
      case "vec": {
        const n = this.resolveDim(ty.n);
        if (n.d === "lit" && n.n === 4) return "色";
        return n.d === "lit" ? `${n.n}次元ベクトル` : "ベクトル";
      }
      case "field": {
        const d = this.resolveDim(ty.d);
        const a = this.resolve(ty.a);
        if (d.d === "lit" && d.n === 2 && a.t === "vec") {
          const an = this.resolveDim(a.n);
          if (an.d === "lit" && an.n === 4) return "画像(2Dの色場)";
        }
        return `${d.d === "lit" ? d.n + "D" : ""}の場`.replace(/^の/, "");
      }
      case "shape": {
        const d = this.resolveDim(ty.d);
        return d.d === "lit" ? `${d.n}D図形(SDF)` : "図形(SDF)";
      }
      case "fun":
        return `関数(${this.show(ty.a)} → ${this.show(ty.b)})`;
      case "list":
        return `リスト(${this.show(ty.a)})`;
      case "rec":
        return "レコード";
      case "pat":
        return `時間パターン(${this.show(ty.a)})`;
    }
    return "不明";
  }

  error(msg: string, span: Span, related?: { message: string; span: Span }[]): void {
    this.diags.push({ severity: "error", message: msg, span, related });
  }

  instantiate(s: Scheme): Ty {
    const tmap = new Map<number, Ty>();
    const dmap = new Map<number, Dm>();
    for (const v of s.vars) tmap.set(v, this.fresh());
    for (const d of s.dims) dmap.set(d, this.freshDim());
    const go = (ty: Ty): Ty => {
      switch (ty.t) {
        case "var":
          return tmap.get(ty.id) ?? ty;
        case "fun":
          return { t: "fun", a: go(ty.a), b: go(ty.b) };
        case "field":
          return { t: "field", d: goD(ty.d), a: go(ty.a) };
        case "shape":
          return { t: "shape", d: goD(ty.d) };
        case "vec":
          return { t: "vec", n: goD(ty.n) };
        case "list":
          return { t: "list", a: go(ty.a) };
        case "pat":
          return { t: "pat", a: go(ty.a) };
        case "rec":
          return ty.fields ? { t: "rec", fields: new Map([...ty.fields].map(([k, v]) => [k, go(v)])) } : ty;
        default:
          return ty;
      }
    };
    const goD = (d: Dm): Dm => (d.d === "var" ? (dmap.get(d.id) ?? d) : d);
    return go(s.ty);
  }

  generalize(ty: Ty, envVars: Set<number>): Scheme {
    const vars = new Set<number>();
    const dims = new Set<number>();
    const go = (t0: Ty): void => {
      const t = this.resolve(t0);
      switch (t.t) {
        case "var":
          if (!envVars.has(t.id)) vars.add(t.id);
          break;
        case "fun":
          go(t.a);
          go(t.b);
          break;
        case "field":
          goD(t.d);
          go(t.a);
          break;
        case "shape":
          goD(t.d);
          break;
        case "vec":
          goD(t.n);
          break;
        case "list":
        case "pat":
          go(t.a);
          break;
        case "rec":
          if (t.fields) for (const v of t.fields.values()) go(v);
          break;
      }
    };
    const goD = (d0: Dm): void => {
      const d = this.resolveDim(d0);
      if (d.d === "var") dims.add(d.id);
    };
    go(ty);
    return { vars: [...vars], dims: [...dims], ty };
  }
}

// ---- builtin シグネチャ表 --------------------------------------------------------

function builtinSchemes(): Map<string, (inf: Infer) => Ty> {
  const m = new Map<string, (inf: Infer) => Ty>();
  const poly = (mk: (inf: Infer, v: () => Ty, d: () => Dm) => Ty) => (inf: Infer) =>
    mk(inf, () => inf.fresh(), () => inf.freshDim());

  const shapeD = (d: Dm): Ty => ({ t: "shape", d });
  const fieldD = (d: Dm, a: Ty): Ty => ({ t: "field", d, a });
  const vecD = (d: Dm): Ty => ({ t: "vec", n: d });
  const D2: Dm = { d: "lit", n: 2 };
  const D3: Dm = { d: "lit", n: 3 };
  const IMAGE: Ty = fieldD(D2, COLOR);

  m.set("time", () => FLOAT);
  m.set("etime", () => FLOAT);
  m.set("etime'", () => FLOAT);
  m.set("dt", () => FLOAT);
  m.set("cps", () => FLOAT);
  m.set("pi", () => FLOAT);
  m.set("tau", () => FLOAT);
  m.set("gravity", () => ({ t: "vec", n: D3 }));

  for (const c of ["white", "black", "red", "green", "blue", "coral", "midnight", "teal", "ivory", "indigo", "skyblue", "orange", "magenta", "gray"]) {
    m.set(c, () => COLOR);
  }

  // 数学(1引数・場リフトは unify 側で吸収)
  for (const f of ["sin", "cos", "tan", "abs", "floor", "ceil", "fract", "sqrt", "exp", "log", "sign"]) {
    m.set(f, () => fun(FLOAT, FLOAT));
  }
  m.set("atan2", () => fun(FLOAT, FLOAT, FLOAT));
  m.set("pow", () => fun(FLOAT, FLOAT, FLOAT));
  m.set("wrap", () => fun(FLOAT, FLOAT, FLOAT));
  for (const f of ["min", "max"]) m.set(f, poly((inf, v) => { const a = v(); return fun(a, a, a); }));
  m.set("clamp", poly((inf, v) => { const a = v(); return fun(a, a, a, a); }));
  m.set("mix", poly((inf, v) => { const a = v(); return fun(a, a, FLOAT, a); }));
  m.set("step", () => fun(FLOAT, FLOAT, FLOAT));
  m.set("smoothstep", () => fun(FLOAT, FLOAT, FLOAT, FLOAT));
  m.set("length", poly((inf, v, d) => fun(vecD(d()), FLOAT)));
  m.set("normalize", poly((inf, v, d) => { const dd = d(); return fun(vecD(dd), vecD(dd)); }));
  m.set("dot", poly((inf, v, d) => { const dd = d(); return fun(vecD(dd), vecD(dd), FLOAT); }));
  m.set("cross", () => fun(vecD(D3), vecD(D3), vecD(D3)));
  m.set("reflect", poly((inf, v, d) => { const dd = d(); return fun(vecD(dd), vecD(dd), vecD(dd)); }));

  // 形状
  m.set("circle", () => fun(FLOAT, shapeD(D2)));
  m.set("box", poly((inf, v, d) => fun(inf.fresh(), shapeD(d()))));
  m.set("tri", () => fun(FLOAT, shapeD(D2)));
  m.set("line", poly((inf, v, d) => { const dd = d(); return fun(vecD(dd), vecD(dd), shapeD(dd)); }));
  m.set("bezier", poly((inf, v, d) => { const dd = d(); return fun(vecD(dd), vecD(dd), vecD(dd), shapeD(dd)); }));
  m.set("sphere", () => fun(FLOAT, shapeD(D3)));
  m.set("point", poly((inf, v, d) => fun(FLOAT, shapeD(d()))));
  m.set("heightfield", () => fun(fun(vecD(D2), FLOAT), shapeD(D3)));
  m.set("stripes", () => fun(FLOAT, fieldD(D2, FLOAT)));

  // warp 族(図形にも場にも効くため、対象は自由変数で受ける)
  m.set("move", poly((inf, v, d) => { const a = v(); return fun(vecD(d()), a, a); }));
  m.set("rot", poly((inf, v) => { const a = v(); return fun(FLOAT, a, a); }));
  m.set("rotX", poly((inf, v) => { const a = v(); return fun(FLOAT, a, a); }));
  m.set("rotY", poly((inf, v) => { const a = v(); return fun(FLOAT, a, a); }));
  m.set("rotZ", poly((inf, v) => { const a = v(); return fun(FLOAT, a, a); }));
  m.set("scale", poly((inf, v) => { const a = v(); return fun(FLOAT, a, a); }));
  m.set("repeat", poly((inf, v, d) => { const a = v(); return fun(vecD(d()), a, a); }));
  m.set("mirror", poly((inf, v) => { const a = v(); return fun(a, a); }));
  m.set("twist", () => fun(FLOAT, { t: "shape", d: D3 }, { t: "shape", d: D3 }));
  m.set("warp", poly((inf, v, d) => { const a = v(); const dd = d(); return fun(fun(vecD(dd), vecD(dd)), a, a); }));
  m.set("distort", poly((inf, v, d) => { const dd = d(); return fun(fieldD(dd, FLOAT), shapeD(dd), shapeD(dd)); }));

  // 合成
  m.set("cut", poly((inf, v, d) => { const dd = d(); return fun(shapeD(dd), shapeD(dd), shapeD(dd)); }));
  m.set("inter", poly((inf, v, d) => { const dd = d(); return fun(shapeD(dd), shapeD(dd), shapeD(dd)); }));
  m.set("morph", poly((inf, v) => fun(FLOAT, v())));
  m.set("blendAll", poly((inf, v, d) => { const dd = d(); return fun(FLOAT, { t: "list", a: shapeD(dd) }, shapeD(dd)); }));
  m.set("outline", poly((inf, v, d) => { const dd = d(); return fun(FLOAT, shapeD(dd), shapeD(dd)); }));

  // 彩色
  m.set("fill", poly((inf, v, d) => { const dd = d(); return fun(inf.fresh(), shapeD(dd), shapeD(dd)); }));
  m.set("hsv", () => fun(FLOAT, FLOAT, FLOAT, COLOR));
  m.set("ramp", poly((inf, v, d) => { const dd = d(); return fun({ t: "list", a: COLOR }, fieldD(dd, FLOAT), fieldD(dd, COLOR)); }));
  m.set("glow", poly((inf, v, d) => { const dd = d(); return fun(FLOAT, shapeD(dd), shapeD(dd)); }));
  m.set("bg", () => fun(COLOR, IMAGE));
  m.set("sun", () => fun(vecD(D3), LIGHT));
  m.set("sunlight", () => LIGHT);
  m.set("shade", () => fun(LIGHT, shapeD(D3), shapeD(D3)));
  m.set("fog", () => fun(FLOAT, COLOR, shapeD(D3), shapeD(D3)));

  // 画像・ポスト
  for (const f of ["fade", "zoom", "bloom", "chromatic", "grain", "vignette"]) {
    m.set(f, () => fun(FLOAT, IMAGE, IMAGE));
  }

  // 時間族
  m.set("lag", () => fun(FLOAT, FLOAT, FLOAT));
  m.set("smooth", () => fun(FLOAT, FLOAT, FLOAT));
  m.set("slow", poly((inf, v) => { const a = v(); return fun(FLOAT, a, a); }));
  m.set("loop", poly((inf, v) => { const a = v(); return fun(FLOAT, a, a); }));
  m.set("cycle", poly((inf, v) => { const a = v(); return fun(DUR, { t: "list", a }, { t: "pat", a }); }));
  m.set("every", poly((inf, v) => { const a = v(); return fun(FLOAT, fun(a, a), a, a); }));

  // 状態
  m.set("prev", () => IMAGE);
  m.set("laplacian", poly((inf, v) => { const a = v(); return fun(a, a); }));
  m.set("sample", poly((inf, v, d) => { const a = v(); const dd = d(); return fun(fieldD(dd, a), vecD(dd), a); }));

  // 物理
  m.set("dist", poly((inf, v, d) => { const dd = d(); return fun(shapeD(dd), vecD(dd), FLOAT); }));
  m.set("grad", poly((inf, v, d) => { const dd = d(); return fun(shapeD(dd), vecD(dd), vecD(dd)); }));

  // 反復
  m.set("range", () => fun(FLOAT, { t: "list", a: FLOAT }));
  m.set("map", poly((inf, v) => { const a = v(); const b = v(); return fun(fun(a, b), { t: "list", a }, { t: "list", a: b }); }));
  m.set("grid", poly((inf, v) => fun({ t: "list", a: FLOAT }, fun(FLOAT, shapeD(D2)), shapeD(D2))));
  m.set("scatter", poly((inf, v, d) => { const dd = d(); return fun(FLOAT, fun(FLOAT, shapeD(dd)), shapeD(dd)); }));

  // 乱数・場
  m.set("hash", () => fun(FLOAT, FLOAT));
  m.set("hash2", () => fun(FLOAT, vecD(D2)));
  m.set("onSphere", () => fun(vecD(D2), vecD(D3)));
  m.set("noise", poly((inf, v, d) => { const dd = d(); return fieldD(dd, FLOAT); }));
  m.set("noise2", () => fieldD(D2, vecD(D2)));
  m.set("fbm", poly((inf, v, d) => fieldD(d(), FLOAT)));
  m.set("fbm2", () => fieldD(D2, FLOAT));
  m.set("fbm3", () => fieldD(D3, FLOAT));
  m.set("curl", poly((inf, v, d) => { const dd = d(); return fieldD(dd, vecD(D2)); }));

  // 3D
  m.set("orbit", () => fun(FLOAT, FLOAT, CAM));
  m.set("camera", () => fun(vecD(D3), vecD(D3), CAM));
  m.set("render", () => fun(CAM, shapeD(D3), IMAGE));

  // 入力
  m.set("audio", (inf) => ({
    t: "rec",
    fields: new Map<string, Ty>([
      ["low", FLOAT],
      ["lo", FLOAT],
      ["mid", FLOAT],
      ["high", FLOAT],
      ["hi", FLOAT],
      ["level", FLOAT],
      ["fft", fun(FLOAT, FLOAT)],
    ]),
  }));
  m.set("fft", () => fun(FLOAT, FLOAT));
  m.set("mouse", () => ({
    t: "rec",
    fields: new Map<string, Ty>([
      ["x", FLOAT],
      ["y", FLOAT],
      ["pos", vecD(D2)],
      ["down", FLOAT],
    ]),
  }));
  m.set("midi", () => ({ t: "rec", fields: new Map<string, Ty>([["cc", fun(FLOAT, FLOAT)]]) }));
  m.set("tuio", () => ({ t: "rec", fields: null }));
  m.set("plane", () => ({
    t: "rec",
    fields: new Map<string, Ty>([
      ["x", fun(FLOAT, { t: "shape", d: D3 })],
      ["y", fun(FLOAT, { t: "shape", d: D3 })],
      ["z", fun(FLOAT, { t: "shape", d: D3 })],
    ]),
  }));
  m.set("simulate", (inf) => inf.fresh()); // 形が多相的すぎるので staging に委ねる
  m.set("wgsl", (inf) => inf.fresh());
  m.set("glsl", (inf) => inf.fresh());
  m.set("shadertoy", (inf) => inf.fresh());

  return m;
}

// ---- プログラムの推論 ------------------------------------------------------------

type TyEnv = Map<string, Scheme>;

export function inferProgram(ast: Program, _src: string): Diagnostic[] {
  const inf = new Infer();
  const builtins = builtinSchemes();
  const env: TyEnv = new Map();

  const envVarIds = (): Set<number> => {
    // 環境中の自由変数(let 多相の一般化から除外する)
    const s = new Set<number>();
    for (const sch of env.values()) {
      const collect = (t0: Ty): void => {
        const t = inf.resolve(t0);
        if (t.t === "var" && !sch.vars.includes(t.id)) s.add(t.id);
        else if (t.t === "fun") {
          collect(t.a);
          collect(t.b);
        } else if (t.t === "field" || t.t === "list" || t.t === "pat") collect(t.a);
      };
      collect(sch.ty);
    }
    return s;
  };

  const lookupVar = (name: string, span: Span): Ty => {
    const sch = env.get(name);
    if (sch) return inf.instantiate(sch);
    const b = builtins.get(name);
    if (b) return b(inf);
    // 未定義は staging 側が正確な位置で報告するので、ここでは黙って var
    return inf.fresh();
  };

  const infer = (e: Expr, scope: TyEnv): Ty => {
    switch (e.k) {
      case "num":
        return FLOAT;
      case "time":
        return DUR;
      case "str":
        return { t: "con", name: "Str" };
      case "var": {
        const sch = scope.get(e.name);
        if (sch) return inf.instantiate(sch);
        return lookupVar(e.name, e.span);
      }
      case "lam": {
        const inner: TyEnv = new Map(scope);
        const paramTys: Ty[] = [];
        for (const p of e.params) {
          const tv = inf.fresh();
          paramTys.push(tv);
          inner.set(p.name, { vars: [], dims: [], ty: tv });
        }
        const bodyTy = infer(e.body, inner);
        return fun(...paramTys, bodyTy);
      }
      case "app": {
        const fnTy = infer(e.fn, scope);
        const argTy = infer(e.arg, scope);
        const resTy = inf.fresh();
        const rf = inf.resolve(fnTy);
        // 場をインデックス/座標でサンプルする適用は許す(引数は座標ベクトル)
        if (rf.t === "field") {
          const ra = inf.resolve(argTy);
          if (ra.t === "var") inf.unify(argTy, { t: "vec", n: rf.d });
          return rf.a;
        }
        // line/bezier(strip2D/strip3D持ち)への Float 適用は outline と同じ意味に
        // なる(`line a b w`、ADR-0038)。infer はどの Shape が strip 持ちかを
        // 追跡しない best-effort 層なので、ここでは形だけ許可し、対象外の Shape
        // (circle 等)への誤用は staging 側の実行時チェックに委ねる
        if (rf.t === "shape") {
          const ra = inf.resolve(argTy);
          if (ra.t === "var") inf.unify(argTy, FLOAT);
          return rf;
        }
        if (!inf.unify(fnTy, { t: "fun", a: argTy, b: resTy })) {
          const rff = inf.resolve(fnTy);
          if (rff.t === "fun") {
            inf.error(
              `この引数は ${inf.show(rff.a)} が必要ですが、${inf.show(argTy)} が渡されています`,
              e.arg.span,
              [{ message: `関数の由来はここ`, span: e.fn.span }],
            );
          } else if (rff.t !== "var") {
            inf.error(`${inf.show(fnTy)} は関数ではないので適用できません`, e.fn.span);
          }
          return inf.fresh();
        }
        return resTy;
      }
      case "bin": {
        const lt = infer(e.left, scope);
        const rt = infer(e.right, scope);
        switch (e.op) {
          case "==":
          case "!=":
          case "<":
          case ">":
          case "<=":
          case ">=":
            return BOOL;
          case "<+>": {
            const d = inf.freshDim();
            if (!inf.unify(lt, { t: "shape", d }) || !inf.unify(rt, { t: "shape", d })) {
              inf.error(
                `\`<+>\` は図形同士の合成です(左: ${inf.show(lt)}、右: ${inf.show(rt)})`,
                e.opSpan,
                [
                  { message: `左辺の由来`, span: e.left.span },
                  { message: `右辺の由来`, span: e.right.span },
                ],
              );
            }
            return { t: "shape", d };
          }
          case "<over>": {
            const img: Ty = { t: "field", d: { d: "lit", n: 2 }, a: COLOR };
            inf.unify(lt, img);
            inf.unify(rt, img);
            return img;
          }
          case "<>":
            inf.unify(rt, DUR);
            return lt;
          default: {
            // 算術。ラムダ引数などの未確定変数は束縛しない(サンプル位置の座標が
            // 後から vec に決まる例3・例9を壊さないため)。スカラー×ベクトルは許す
            const l = inf.resolve(lt);
            const r = inf.resolve(rt);
            if (l.t === "var" && r.t === "var") return l;
            if (l.t === "var") return r;
            if (r.t === "var") return l;
            const isF = (t: Ty): boolean => t.t === "con" && (t.name === "Float" || t.name === "Dur");
            // ベクトルリテラル([x,y] など。AST 上は list)へのスカラー乗算も同様に許す
            if (isF(l) && (r.t === "vec" || r.t === "list")) return r;
            if (isF(r) && (l.t === "vec" || l.t === "list")) return l;
            // vec 同士・list 同士(次元は staging が検査)も許容
            if ((l.t === "vec" || l.t === "list") && (r.t === "vec" || r.t === "list")) return l;
            if (l.t === "field" || r.t === "field") {
              return l.t === "field" ? l : r;
            }
            if (!inf.unify(lt, rt)) {
              inf.error(
                `\`${e.op}\` の両辺の型が合いません(左: ${inf.show(lt)}、右: ${inf.show(rt)})`,
                e.opSpan,
                [
                  { message: `左辺の由来`, span: e.left.span },
                  { message: `右辺の由来`, span: e.right.span },
                ],
              );
              return inf.fresh();
            }
            return lt;
          }
        }
      }
      case "neg":
        return infer(e.expr, scope);
      case "if": {
        const ct = infer(e.cond, scope);
        inf.unify(ct, BOOL);
        const tt = infer(e.then, scope);
        const et = infer(e.else_, scope);
        if (!inf.unify(tt, et)) {
          inf.error(
            `then と else の型が合いません(then: ${inf.show(tt)}、else: ${inf.show(et)})`,
            e.span,
            [
              { message: `then の由来`, span: e.then.span },
              { message: `else の由来`, span: e.else_.span },
            ],
          );
        }
        return tt;
      }
      case "let": {
        const inner: TyEnv = new Map(scope);
        for (const b of e.binds) {
          inner.set(b.name, inferBind(b, inner));
        }
        return infer(e.body, inner);
      }
      case "list": {
        const a = inf.fresh();
        for (const it of e.items) {
          const t = infer(it, scope);
          inf.unify(a, t);
        }
        return { t: "list", a };
      }
      case "record": {
        const fields = new Map<string, Ty>();
        for (const f of e.fields) fields.set(f.name, infer(f.expr, scope));
        return { t: "rec", fields };
      }
      case "field": {
        const t = inf.resolve(infer(e.target, scope));
        if (t.t === "rec" && t.fields) {
          const ft = t.fields.get(e.name);
          if (!ft) {
            inf.error(`レコードに \`${e.name}\` はありません`, e.span);
            return inf.fresh();
          }
          return ft;
        }
        if (t.t === "vec") {
          if (e.name.length === 1) return FLOAT;
          return { t: "vec", n: { d: "lit", n: Math.min(4, Math.max(2, e.name.length)) as 2 | 3 | 4 } };
        }
        if (t.t === "field") {
          // 場の射影
          return { t: "field", d: t.d, a: inf.fresh() };
        }
        // 変数のままなら追わない(best-effort)
        return inf.fresh();
      }
      case "error":
        return inf.fresh();
    }
  };

  const inferBind = (b: Bind, scope: TyEnv): Scheme => {
    let ty: Ty;
    if (b.params.length > 0) {
      const inner: TyEnv = new Map(scope);
      const paramTys: Ty[] = [];
      for (const p of b.params) {
        const tv = inf.fresh();
        paramTys.push(tv);
        inner.set(p.name, { vars: [], dims: [], ty: tv });
      }
      ty = fun(...paramTys, infer(b.expr, inner));
    } else {
      ty = infer(b.expr, scope);
    }
    return inf.generalize(ty, envVarIds());
  };

  for (const b of ast.binds) {
    env.set(b.name, inferBind(b, env));
  }
  if (ast.out) infer(ast.out, env);

  return inf.diags;
}
