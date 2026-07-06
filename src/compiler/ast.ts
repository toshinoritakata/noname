// AST。全ノードがソース位置(span)を保持する(implementation.md 1.1)。

import type { Span } from "./diag.ts";

export type Expr =
  | { k: "num"; value: number; span: Span }
  | { k: "time"; value: number; unit: "s" | "beat"; span: Span }
  | { k: "str"; text: string; span: Span }
  | { k: "var"; name: string; span: Span }
  | { k: "lam"; params: Param[]; body: Expr; span: Span }
  | { k: "app"; fn: Expr; arg: Expr; span: Span }
  | { k: "bin"; op: BinOp; left: Expr; right: Expr; span: Span; opSpan: Span }
  | { k: "neg"; expr: Expr; span: Span }
  | { k: "if"; cond: Expr; then: Expr; else_: Expr; span: Span }
  | { k: "let"; binds: Bind[]; body: Expr; span: Span }
  | { k: "list"; items: Expr[]; span: Span }
  | { k: "record"; fields: { name: string; expr: Expr; span: Span }[]; span: Span }
  | { k: "field"; target: Expr; name: string; span: Span }
  | { k: "error"; span: Span };

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "<+>"
  | "<over>"
  | "|>"
  | "<>";

export interface Param {
  name: string;
  span: Span;
}

export interface Bind {
  name: string;
  params: Param[];
  expr: Expr;
  span: Span;
}

export interface Program {
  binds: Bind[];
  /** out 対象の式(明示 out or 最後の裸の式 = 暗黙 out) */
  out: Expr | null;
  /** `<> dur` のクロスフェード時間式(省略時 null = 即時切替) */
  fade: Expr | null;
  outSpan: Span | null;
}
