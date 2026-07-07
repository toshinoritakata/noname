// Staging(部分評価)の値表現。
// Field/Shape はクロージャ(座標 → IR 式)として保持され、合成子はクロージャ合成、
// 最後に座標ノードを適用して IR DAG が出る(implementation.md 3章)。
// 時間はグローバル入力ノードとして式に混ざるだけ(暗黙の第4座標、ADR-0002)。

import type { Expr, Param } from "./ast.ts";
import type { Diagnostic, Span } from "./diag.ts";
import type { IRArena, NodeId } from "./ir.ts";

/** 次元。0 = 未確定(次元多相、適用時に単相化) */
export type Dim = 0 | 1 | 2 | 3;

export interface Env {
  vars: Map<string, Value>;
  parent: Env | null;
}

export function lookupEnv(env: Env | null, name: string): Value | undefined {
  for (let e = env; e; e = e.parent) {
    const v = e.vars.get(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

// ---- 値 ----------------------------------------------------------------------

export type Value =
  | VNum
  | VBool
  | VVec
  | VDur
  | VStr
  | VClosure
  | VBuiltin
  | VField
  | VShape
  | VCam
  | VLight
  | VList
  | VRecord
  | VSim
  | VPattern;

export interface VNum {
  v: "num";
  ir: NodeId;
  /** 静的に決まる値(リテラル・その定数演算)。構造定数(grid の要素数など)に使う */
  sval?: number;
}
export interface VBool {
  v: "bool";
  ir: NodeId;
  sval?: boolean;
}
export interface VVec {
  v: "vec";
  n: 2 | 3 | 4;
  ir: NodeId;
  sval?: number[];
}
export interface VDur {
  v: "dur";
  ir: NodeId; // 秒に換算した IR(beat は spb 入力を掛ける)
  sval?: number; // 静的な値(単位はそのまま)
  unit: "s" | "beat";
}
export interface VStr {
  v: "str";
  text: string;
}
export interface VClosure {
  v: "clo";
  params: Param[];
  body: Expr;
  env: Env;
}
export interface VBuiltin {
  v: "bi";
  name: string;
  arity: number;
  args: Value[];
  impl: (ctx: Ctx, args: Value[], span: Span) => Value;
}
/** 空間場。fn は「座標値 → 値」。state は simulate 由来の場に付くマーカー */
export interface VField {
  v: "field";
  dim: Dim;
  fn: (ctx: Ctx, p: VVec, span: Span) => Value;
  state?: StateRef;
  /** toImage/imageOver 経由で伝播する line/bezier ストリップバッチ(ADR-0016) */
  stripBatches?: StripBatchSpec[];
}
export interface VShape {
  v: "shape";
  dim: Dim;
  dist: (ctx: Ctx, p: VVec, span: Span) => VNum;
  colour: (ctx: Ctx, p: VVec, span: Span) => VVec; // vec4
  /**
   * スプライト最適化の単項descriptor(`point |> move |> fill/glow` の連鎖でのみ伝播)。
   * 「中心・半径・色が座標 p に依存しない(loop 索引と time にのみ依存する)」ことを
   * 型ではなく合成子側で保証する軽量マーカー。move/fill/glow 以外の合成子は
   * このフィールドを引き継がない(= 安全にフォールバックする)。scatter の
   * loopShape がこれを見つけたら、CSG ループではなくインスタンス化描画に切り替える
   */
  sprite?: { center: VVec; radius: VNum; colour: VVec };
  /**
   * 集約後(loopShape/shapeUnion 後)のスプライトバッチ群。render() がこれを見つけたら
   * レイマーチの dist/colour には算入しない(dist は定数 +∞ にすり替え済み)代わりに、
   * 専用の instanced sprite パスで描画する(implementation.md への追加: ADR-0014)
   */
  spriteBatches?: SpriteBatchSpec[];
  /**
   * 2D の line/bezier 用マーカー(`line`/`bezier` が起点を置き、`outline` が幅、
   * `fill` が色を積む。それ以外の合成子は引き継がない=安全に SDF へフォールバック)。
   * p0/p1/p2 は2次ベジエの制御点(line は p1=中点の退化ベジエとして扱う)。ADR-0016
   */
  strip2D?: { p0: VVec; p1: VVec; p2: VVec; width: VNum; colour: VVec };
  /**
   * 集約後(loopShape 後)のストリップバッチ群。line/bezier は dist=+∞ にすり替え済みで
   * レイマーチ/フラット化には算入されず、専用の instanced strip パスが三角形ストリップ
   * として直接ラスタライズする(march 不要。ADR-0016)
   */
  stripBatches?: StripBatchSpec[];
}

/** scatter が生成する1バッチぶんのインスタンス記述(implementation.md 追加、ADR-0014) */
export interface SpriteBatchSpec {
  count: number;
  loopId: number;
  /** vec4(center.xyz, radius)。loopi(loopId) のみに依存する */
  centerRadiusIR: NodeId;
  /** vec4(rgb, glow強度)。loopi(loopId) のみに依存する */
  colourIR: NodeId;
}

/** scatter が生成する1バッチぶんの line/bezier インスタンス記述(ADR-0016) */
export interface StripBatchSpec {
  count: number;
  loopId: number;
  p0IR: NodeId; // vec2
  p1IR: NodeId; // vec2(制御点。line は中点)
  p2IR: NodeId; // vec2
  widthIR: NodeId; // f32
  colourIR: NodeId; // vec4
}
export interface VCam {
  v: "cam";
  eye: VVec; // vec3
  target: VVec; // vec3
  fov: VNum;
}
export interface VLight {
  v: "light";
  kind: "sun";
  dir: VVec; // vec3
}
export interface VList {
  v: "list";
  items: Value[];
  /** `range n` が付ける印。`map` が大きな N を検知するのに使う(ADR-0017) */
  rangeOf?: number;
  /**
   * `range n |> map f` が N>64 のときに `map` が付ける「まだ展開していない」記述。
   * `items` は(互換のため)通常通り展開済みだが、`blendAll` はこちらを見つけたら
   * JS 側で N 回展開する代わりに WGSL の for ループ1個に畳み込む(ADR-0017、
   * ADR-0014/0016 と同じ「大きな N は構造で殴らずループにする」方針)
   */
  symbolicLoop?: { loopId: number; count: number; proto: Value };
}
export interface VRecord {
  v: "rec";
  fields: Map<string, Value>;
}
export interface VSim {
  v: "sim";
  handle: SimHandle;
}
/** cycle の結果。図形/値の列を時間で巡回するパターン。morph で補間幅を持つ */
export interface VPattern {
  v: "pat";
  durSec: NodeId; // 1周期の秒数(IR)
  durSval?: number;
  items: Value[];
  morph: NodeId | null; // 補間幅 0..1(IR)。null = 即時切替
}

// ---- simulate ---------------------------------------------------------------

/** 状態レイアウト: レコードをチャネル列に平坦化したもの(implementation.md 4.2) */
export interface StateChannel {
  /** レコードのフィールドパス(トップが vec/num なら []) */
  path: string[];
  len: 1 | 2 | 3 | 4;
  /** 先頭からの float オフセット */
  offset: number;
}

export interface SimHandle {
  name: string;
  kind: "grid" | "array";
  width: number;
  height: number;
  channels: StateChannel[];
  totalFloats: number;
  texCount: number;
  /** 型シグネチャ(BufferRegistry の照合キーの一部。ADR-0004) */
  sig: string;
  texKey(i: number): string;
}

export interface StateRef {
  handle: SimHandle;
  /** チャネル平坦列の中での [開始float, 長さ] */
  offset: number;
  len: number;
}

// ---- パス --------------------------------------------------------------------

export interface SimPassSpec {
  kind: "sim";
  handle: SimHandle;
  /** texCount 本ぶんの vec4 ルート */
  initRoots: NodeId[];
  updateRoots: NodeId[];
  span: Span;
}

export interface RaymarchPassSpec {
  kind: "raymarch";
  id: number;
  dist: NodeId; // f32(coord=vec3)
  colour: NodeId; // vec4(coord=vec3、rmctx 参照可)
  eye: NodeId; // vec3
  target: NodeId; // vec3
  fov: NodeId; // f32
  span: Span;
  /** scatter 由来のスプライトバッチ(あれば instanced pass で別描画。ADR-0014) */
  spriteBatches?: SpriteBatchSpec[];
}

/**
 * bloom のダウンサンプル+ブラー多パス連鎖(ADR-0019)。
 * 明るい部分の抽出(extract)だけが呼び出しごとに違う式(ユーザーの画像式)で、
 * ダウンサンプル/アップサンプル自体は固定の(IRに依存しない)テンプレートshader。
 */
export interface BloomPassSpec {
  kind: "bloom";
  id: number;
  /** brightPass(元画像(coord=vec2 ワールド座標)) の式 */
  extract: NodeId;
  /** ダウンサンプル段数。多いほど滲みの実効半径が広がる。k から適応的に決める(ADR-0024) */
  levels: number;
  span: Span;
}

// ---- staging コンテキスト ------------------------------------------------------

export interface DerivedInput {
  name: string; // 入力スロット名(lag:audio.lo:0.15 など)
  source: string; // 元の入力名
  kind: "lag";
  k: number;
}

export interface FfiFn {
  name: string; // 生成シェーダ内の(リネーム済み)関数名
  src: string; // WGSL 関数本体(ユーザー記述)
  srcHash: string;
  span: Span;
}

/**
 * `text`(ADR-0032)がラスタライズを要求する文字列。実際の描画(Canvas2D→GPUテクスチャ)
 * は GPU を持つメインスレッド側でのみ行う(コンパイラは Worker で動くため)。
 * key は "text:" + fnv1a(text) で、sample のテクスチャキーにも
 * `${key}:aspect` という入力名(実測アスペクト比、ランタイム供給)にも使う
 */
export interface TextTextureSpec {
  key: string;
  text: string;
}

export interface Ctx {
  arena: IRArena;
  diags: Diagnostic[];
  src: string;
  /** 評価器のコールバック(stdlib から関数値を適用するのに使う) */
  apply: (ctx: Ctx, fn: Value, arg: Value, span: Span) => Value;
  /** 現在評価中の束縛名(simulate の Registry キーになる) */
  bindingName: string | null;
  sims: SimPassSpec[];
  raymarches: RaymarchPassSpec[];
  blooms: BloomPassSpec[];
  usesPrev: boolean;
  derivedInputs: DerivedInput[];
  ffiFns: FfiFn[];
  textTextures: TextTextureSpec[];
  /** slow/loop の時間再マップ用スタック。空なら input('time') */
  timeStack: NodeId[];
  freshId: () => number;
}
