// Field IR — 一階・純粋・静的単一代入の式 DAG(implementation.md 3章、ADR-0007)。
// ノードは構造的ハッシュで共有(hash-consing)され、CSE・パス差分・スナップショット
// テストがこの1機構から出る。数値リテラルは uniform に昇格する(ADR-0008)。

import type { Span } from "./diag.ts";

export type IRType = "f32" | "bool" | "vec2" | "vec3" | "vec4";

export type NodeId = number;

export type IRNode =
  // パスの座標引数(image/sim: vec2 ワールド座標、raymarch: vec3)
  | { k: "coord"; t: IRType }
  // ランタイムが毎フレーム書く入力スカラー(time / etime / dt / mouse.x / audio.lo / midi.cc0 ...)
  | { k: "input"; name: string; t: "f32" }
  // 昇格された数値リテラル(idx = uniform 表の位置)
  | { k: "uniform"; idx: number; t: "f32" }
  // 構造定数(グリッド数など。畳み込み済み)
  | { k: "const"; v: number; t: "f32" | "bool" }
  | { k: "bin"; op: BinIROp; a: NodeId; b: NodeId; t: IRType }
  | { k: "un"; op: "neg" | "not"; a: NodeId; t: IRType }
  // 組み込み関数呼び出し(WGSL 組み込み or ライブラリ関数)
  | { k: "call"; fn: string; args: NodeId[]; t: IRType }
  | { k: "vec"; parts: NodeId[]; t: "vec2" | "vec3" | "vec4" }
  | { k: "swiz"; a: NodeId; sel: string; t: IRType }
  | { k: "select"; c: NodeId; a: NodeId; b: NodeId; t: IRType }
  // テクスチャ参照。tex はシンボリックなキー("prev" / "sim:rd:0" / "rm:1" / "fft")
  | { k: "sample"; tex: string; p: NodeId; t: "vec4" } // UV [0,1]² バイリニア
  | { k: "fetch"; tex: string; i: NodeId; t: "vec4" } // 整数インデックスで1テクセル
  // レイマーチパスの文脈値(法線・レイ方向・ヒット距離)。RaymarchPass 内でのみ有効
  | { k: "rmctx"; which: "normal" | "raydir" | "raydist" | "hitpos"; t: IRType }
  // 大きな N の畳み込みループ(implementation.md 3.2-2)。
  // body は loopi(id)/loopacc(id) を参照する部分 DAG
  | { k: "loop"; id: number; count: number; init: NodeId; body: NodeId; t: IRType }
  | { k: "loopi"; id: number; t: "f32" }
  | { k: "loopacc"; id: number; t: IRType }
  // FFI 不透明呼び出し(ADR-0011)。srcHash でハッシュ共有に参加
  | { k: "ffi"; name: string; srcHash: string; args: NodeId[]; t: IRType };

export type BinIROp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<"
  | ">"
  | "<="
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||";

export interface UniformSlot {
  value: number;
  span: Span; // 元コードの数値リテラル位置(スクラブ UI 用)
}

export function vecType(n: number): IRType {
  if (n === 2) return "vec2";
  if (n === 3) return "vec3";
  if (n === 4) return "vec4";
  return "f32";
}

export function vecLen(t: IRType): number {
  switch (t) {
    case "vec2":
      return 2;
    case "vec3":
      return 3;
    case "vec4":
      return 4;
    default:
      return 1;
  }
}

/** hash-consing 付き IR アリーナ。ノード追加は構造キーで共有される */
export class IRArena {
  nodes: IRNode[] = [];
  private memo = new Map<string, NodeId>();
  uniforms: UniformSlot[] = [];
  private loopCounter = 0;

  node(n: IRNode): NodeId {
    const key = this.keyOf(n);
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const id = this.nodes.length;
    this.nodes.push(n);
    this.memo.set(key, id);
    return id;
  }

  get(id: NodeId): IRNode {
    return this.nodes[id];
  }

  typeOf(id: NodeId): IRType {
    return this.nodes[id].t;
  }

  freshLoopId(): number {
    return this.loopCounter++;
  }

  /** 数値リテラルを uniform に昇格してノード化する */
  literal(value: number, span: Span): NodeId {
    const idx = this.uniforms.length;
    this.uniforms.push({ value, span });
    // idx が異なれば別ノード(同値のリテラルでも独立に編集できる)
    return this.node({ k: "uniform", idx, t: "f32" });
  }

  private keyOf(n: IRNode): string {
    switch (n.k) {
      case "coord":
        return `coord:${n.t}`;
      case "input":
        return `input:${n.name}`;
      case "uniform":
        return `uni:${n.idx}`;
      case "const":
        return `const:${n.t}:${n.v}`;
      case "bin":
        return `bin:${n.op}:${n.a}:${n.b}`;
      case "un":
        return `un:${n.op}:${n.a}`;
      case "call":
        return `call:${n.fn}:${n.args.join(",")}`;
      case "vec":
        return `vec:${n.t}:${n.parts.join(",")}`;
      case "swiz":
        return `swiz:${n.sel}:${n.a}`;
      case "select":
        return `sel:${n.c}:${n.a}:${n.b}`;
      case "sample":
        return `smp:${n.tex}:${n.p}`;
      case "fetch":
        return `fetch:${n.tex}:${n.i}`;
      case "rmctx":
        return `rm:${n.which}`;
      case "loop":
        return `loop:${n.id}:${n.count}:${n.init}:${n.body}`;
      case "loopi":
        return `loopi:${n.id}`;
      case "loopacc":
        return `loopacc:${n.id}`;
      case "ffi":
        return `ffi:${n.name}:${n.srcHash}:${n.args.join(",")}`;
    }
  }

  /**
   * パス単位の構造ハッシュ(implementation.md 3.4)。
   * uniform の「値」はハッシュに入らない(値だけの変更は形が同じ = 再コンパイル不要)。
   */
  structuralHash(roots: NodeId[]): string {
    const seen = new Map<NodeId, number>();
    const parts: string[] = [];
    const visit = (id: NodeId): number => {
      const hit = seen.get(id);
      if (hit !== undefined) return hit;
      const n = this.nodes[id];
      let desc: string;
      switch (n.k) {
        case "bin":
          desc = `bin:${n.op}:${visit(n.a)}:${visit(n.b)}`;
          break;
        case "un":
          desc = `un:${n.op}:${visit(n.a)}`;
          break;
        case "call":
          desc = `call:${n.fn}:${n.args.map(visit).join(",")}`;
          break;
        case "vec":
          desc = `vec:${n.parts.map(visit).join(",")}`;
          break;
        case "swiz":
          desc = `swiz:${n.sel}:${visit(n.a)}`;
          break;
        case "select":
          desc = `sel:${visit(n.c)}:${visit(n.a)}:${visit(n.b)}`;
          break;
        case "sample":
          desc = `smp:${n.tex}:${visit(n.p)}`;
          break;
        case "fetch":
          desc = `fetch:${n.tex}:${visit(n.i)}`;
          break;
        case "loop":
          desc = `loop:${n.count}:${visit(n.init)}:${visit(n.body)}`;
          break;
        case "ffi":
          desc = `ffi:${n.srcHash}:${n.args.map(visit).join(",")}`;
          break;
        case "uniform":
          desc = `uni:${n.idx}`; // 値は含めない(ADR-0008 の肝)
          break;
        default:
          desc = this.keyOf(n);
      }
      const idx = parts.length;
      parts.push(desc);
      seen.set(id, idx);
      return idx;
    };
    for (const r of roots) visit(r);
    return fnv1a(parts.join(";"));
  }

  /** デバッグ・スナップショットテスト用の文字列化 */
  dump(root: NodeId): string {
    const n = this.nodes[root];
    const rec = (id: NodeId): string => this.dump(id);
    switch (n.k) {
      case "coord":
        return "p";
      case "input":
        return n.name;
      case "uniform":
        return `u${n.idx}(${this.uniforms[n.idx]?.value ?? "?"})`;
      case "const":
        return `#${n.v}`;
      case "bin":
        return `(${rec(n.a)} ${n.op} ${rec(n.b)})`;
      case "un":
        return `(${n.op} ${rec(n.a)})`;
      case "call":
        return `${n.fn}(${n.args.map(rec).join(", ")})`;
      case "vec":
        return `${n.t}(${n.parts.map(rec).join(", ")})`;
      case "swiz":
        return `${rec(n.a)}.${n.sel}`;
      case "select":
        return `select(${rec(n.c)}, ${rec(n.a)}, ${rec(n.b)})`;
      case "sample":
        return `sample[${n.tex}](${rec(n.p)})`;
      case "fetch":
        return `fetch[${n.tex}](${rec(n.i)})`;
      case "rmctx":
        return `@${n.which}`;
      case "loop":
        return `loop#${n.id}[${n.count}](init=${rec(n.init)}, body=${rec(n.body)})`;
      case "loopi":
        return `i#${n.id}`;
      case "loopacc":
        return `acc#${n.id}`;
      case "ffi":
        return `ffi:${n.name}(${n.args.map(rec).join(", ")})`;
    }
  }
}

// ---- IR ノードの子を辿る唯一の再帰(hash-consing を跨ぐ書き換えの土台) --------
//
// IRNode の「子 NodeId をすべて別の id に写す」操作は、DAG 書き換え(rewriteDag /
// transformLoops、wgsl.ts)・子の収集(childrenOf)・time 置換(substTime、stage.ts)
// で必要になる。以前はそれぞれが独立に switch(n.k) を持ち、ノード種を足すたびに
// 更新漏れが起きやすかった(ループ生成バグの遠因になった)。ここに1箇所へ統一し、
// 各利用側はこの mapChildren を経由する。scalar ペイロード(op/fn/sel/tex/name…)は
// 触らず、子の位置(NodeId)だけを rw で写した新しいノードを返す。子を持たない
// 葉(coord/input/uniform/const/rmctx/loopi/loopacc)は元のノードをそのまま返す
// (呼び出し側は `rebuilt === n` で「変化なし」を判定できる)。

/** n の全ての子 NodeId を rw で写した新しいノードを返す。葉は n をそのまま返す */
export function mapChildren(n: IRNode, rw: (id: NodeId) => NodeId): IRNode {
  switch (n.k) {
    case "bin":
      return { ...n, a: rw(n.a), b: rw(n.b) };
    case "un":
    case "swiz":
      return { ...n, a: rw(n.a) };
    case "call":
      return { ...n, args: n.args.map(rw) };
    case "vec":
      return { ...n, parts: n.parts.map(rw) };
    case "select":
      return { ...n, c: rw(n.c), a: rw(n.a), b: rw(n.b) };
    case "sample":
      return { ...n, p: rw(n.p) };
    case "fetch":
      return { ...n, i: rw(n.i) };
    case "loop":
      return { ...n, init: rw(n.init), body: rw(n.body) };
    case "ffi":
      return { ...n, args: n.args.map(rw) };
    default:
      return n;
  }
}

/** n の直接の子 NodeId を(出現順に)列挙する */
export function childrenOf(n: IRNode): NodeId[] {
  const ids: NodeId[] = [];
  mapChildren(n, (id) => {
    ids.push(id);
    return id;
  });
  return ids;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---- vec4 テクスチャルートへのパッキング ----------------------------------
// simulate の状態パッキング(stdlib.ts の packChannels/packRoots)と、
// ループ不変式の巻き上げ(wgsl.ts の hoistLoopBody)は、どちらも
// 「複数の値を vec4 境界を跨がないよう詰めて、テクスチャの列(vec4 の配列)を
// 組み立てる」という同じ処理を別々に実装していた。ここに1箇所へ統一する。

/** offset に長さ len の値を詰めるとき、vec4 境界を跨がないようパディングした
 * 新しい offset を返す(跨ぐ場合は次の vec4 境界まで進める) */
export function padOffset(offset: number, len: number): number {
  return (offset % 4) + len > 4 ? offset + (4 - (offset % 4)) : offset;
}

/** comps(NodeId | null の平坦配列、要素数は texCount*4 ぴったり)から
 * vec4 ルート列を組み立てる。null の位置は 0 で埋める */
export function buildVec4Roots(arena: IRArena, comps: (NodeId | null)[], texCount: number): NodeId[] {
  const zero = arena.node({ k: "const", v: 0, t: "f32" });
  const roots: NodeId[] = [];
  for (let ti = 0; ti < texCount; ti++) {
    const parts = [0, 1, 2, 3].map((i) => comps[ti * 4 + i] ?? zero);
    roots.push(arena.node({ k: "vec", parts, t: "vec4" }));
  }
  return roots;
}
