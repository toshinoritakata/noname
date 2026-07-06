// 再帰下降+Pratt パーサ(implementation.md 1.1)。
// - `|>` `<+>` `<over>` `<>` を優先順位表で管理
// - 行頭 `|>` の省略: 前の行が式として完結し、次の行がインデントされ式が始まるなら暗黙のパイプ
// - パースエラーでも AST を返す(エラーノード挿入、複数診断。ADR-0010)

import { type Bind, type Expr, type Param, type Program, type BinOp } from "./ast.ts";
import { CompileError, merge, type Diagnostic, type Span } from "./diag.ts";
import { isKeyword, lex, type Tok } from "./lexer.ts";

// 優先順位(大きいほど強く結合)。
// `a |> f <over> b` = `(a |> f) <over> b` となるよう、<over> / <+> はパイプより弱い
const PREC: Record<string, number> = {
  "<>": 1,
  "<over>": 2,
  "<+>": 3,
  "|>": 4,
  "==": 5,
  "!=": 5,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};
const RIGHT_ASSOC = new Set(["<over>"]);

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
}

export function parse(src: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  let toks: Tok[];
  try {
    toks = lex(src);
  } catch (e) {
    if (e instanceof CompileError) {
      return {
        program: { binds: [], out: null, fade: null, outSpan: null },
        diagnostics: [e.diagnostic],
      };
    }
    throw e;
  }
  const p = new Parser(toks, diagnostics);
  const program = p.parseProgram();
  return { program, diagnostics };
}

class Parser {
  private pos = 0;
  /** 現在の文(トップレベル束縛など)が始まった行のインデント */
  private stmtIndent = 0;
  /** 括弧の深さ。0 より大きい間は改行を無視する(暗黙の行結合) */
  private parenDepth = 0;
  /** ラムダ開始行のインデントのスタック。それ以下のインデントの行でラムダ本体を終える */
  private lamAnchors: number[] = [];

  private toks: Tok[];
  private diags: Diagnostic[];

  constructor(toks: Tok[], diags: Diagnostic[]) {
    this.toks = toks;
    this.diags = diags;
  }

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)];
  }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (t.kind !== "eof") this.pos++;
    return t;
  }
  private at(text: string): boolean {
    const t = this.peek();
    return (t.kind === "op" || t.kind === "ident") && t.text === text;
  }
  private eat(text: string): Tok {
    if (!this.at(text)) {
      const t = this.peek();
      throw new CompileError(`\`${text}\` が必要ですが \`${t.text || t.kind}\` があります`, t.span);
    }
    return this.next();
  }
  private skipNewlines(): void {
    while (this.peek().kind === "newline") this.next();
  }

  // ---- プログラム ----------------------------------------------------------

  parseProgram(): Program {
    const binds: Bind[] = [];
    let out: Expr | null = null;
    let fade: Expr | null = null;
    let outSpan: Span | null = null;

    this.skipNewlines();
    while (this.peek().kind !== "eof") {
      const start = this.peek();
      try {
        this.stmtIndent = 0;
        if (this.at("out")) {
          const kw = this.next();
          let e = this.parseExpr(0);
          ({ expr: e, fade } = this.splitFade(e, fade));
          out = e;
          outSpan = merge(kw.span, e.span);
        } else if (this.isBindingAhead()) {
          binds.push(this.parseBinding());
        } else {
          // 裸の式 = 暗黙 out(最後のものが有効)
          let e = this.parseExpr(0);
          ({ expr: e, fade } = this.splitFade(e, fade));
          out = e;
          outSpan = e.span;
        }
        // 文の区切り
        if (this.peek().kind === "newline") this.skipNewlines();
        else if (this.peek().kind !== "eof") {
          const t = this.peek();
          throw new CompileError(`文の区切り(改行)が必要ですが \`${t.text || t.kind}\` があります`, t.span);
        }
      } catch (e) {
        if (e instanceof CompileError) {
          this.diags.push(e.diagnostic);
          this.parenDepth = 0;
          this.lamAnchors.length = 0;
          this.recoverToNextStatement(start);
        } else throw e;
      }
    }
    return { binds, out, fade, outSpan };
  }

  /** トップレベルの `expr <> dur` を out+fade に分解する */
  private splitFade(e: Expr, prevFade: Expr | null): { expr: Expr; fade: Expr | null } {
    if (e.k === "bin" && e.op === "<>") {
      return { expr: e.left, fade: e.right };
    }
    return { expr: e, fade: prevFade };
  }

  private recoverToNextStatement(from: Tok): void {
    // 次の「インデント 0 の行頭」までスキップ
    if (this.peek() === from && from.kind !== "eof") this.next();
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.kind === "newline" && (t.indent ?? 0) === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  /** IDENT (IDENT)* `=` の並びか(束縛の先読み) */
  private isBindingAhead(): boolean {
    if (this.peek().kind !== "ident" || isKeyword(this.peek())) return false;
    let k = 1;
    while (this.peek(k).kind === "ident" && !isKeyword(this.peek(k))) k++;
    const t = this.peek(k);
    return t.kind === "op" && t.text === "=";
  }

  private parseBinding(): Bind {
    const nameTok = this.next();
    const params: Param[] = [];
    while (this.peek().kind === "ident" && !isKeyword(this.peek())) {
      const p = this.next();
      params.push({ name: p.text, span: p.span });
    }
    this.eat("=");
    this.maybeSkipIndentedNewline();
    const expr = this.parseExpr(0);
    return { name: nameTok.text, params, expr, span: merge(nameTok.span, expr.span) };
  }

  /** 式の先頭位置で、次行がより深いインデントなら改行を読み飛ばす */
  private maybeSkipIndentedNewline(): void {
    while (this.peek().kind === "newline" && (this.peek().indent ?? 0) > this.stmtIndent) {
      this.next();
    }
  }

  // ---- 式 ------------------------------------------------------------------

  parseExpr(minPrec: number): Expr {
    let left = this.parseUnary();

    for (;;) {
      const t = this.peek();

      // 改行をまたぐ継続の判定
      if (t.kind === "newline") {
        if (this.parenDepth > 0) {
          // 括弧内は行結合。ただし次トークンが式継続でなければ呼び出し元に返す
          const after = this.peek(1);
          const contOp = after.kind === "op" && PREC[after.text] !== undefined;
          if (contOp && PREC[after.text] >= minPrec) {
            this.next();
            continue;
          }
          break;
        }
        const indent = t.indent ?? 0;
        if (indent <= this.stmtIndent) break;
        // ラムダ本体は、ラムダ開始行以下のインデントの行が来たら終わる
        if (this.lamAnchors.length > 0 && indent <= this.lamAnchors[this.lamAnchors.length - 1]) {
          break;
        }
        const after = this.peek(1);
        if (after.kind === "op" && PREC[after.text] !== undefined) {
          // 行頭演算子(`|> rot ...` など)→ 改行を飛ばして継続
          if (PREC[after.text] < minPrec) break;
          this.next(); // newline
          continue;
        }
        // 暗黙のパイプ: 次行が式の先頭で、束縛でも in/then/else でもない
        if (this.startsAtomAt(1) && !this.isBindingAheadAt(1) && PREC["|>"] >= minPrec) {
          this.next(); // newline
          const opSpan = this.peek().span;
          const right = this.parseExpr(PREC["|>"] + 1);
          left = { k: "app", fn: right, arg: left, span: merge(left.span, right.span) };
          void opSpan;
          continue;
        }
        break;
      }

      if (t.kind !== "op" || PREC[t.text] === undefined) break;
      const prec = PREC[t.text];
      if (prec < minPrec) break;
      const opTok = this.next();
      this.maybeSkipIndentedNewline();
      const nextMin = RIGHT_ASSOC.has(opTok.text) ? prec : prec + 1;
      const right = this.parseExpr(nextMin);
      const op = opTok.text as BinOp;
      if (op === "|>") {
        // 糖衣の展開: x |> f = f x(Desugar 相当をここで行う)
        left = { k: "app", fn: right, arg: left, span: merge(left.span, right.span) };
      } else {
        left = {
          k: "bin",
          op,
          left,
          right,
          span: merge(left.span, right.span),
          opSpan: opTok.span,
        };
      }
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === "op" && t.text === "neg") {
      this.next();
      const e = this.parseUnary();
      return { k: "neg", expr: e, span: merge(t.span, e.span) };
    }
    return this.parseApplication();
  }

  private parseApplication(): Expr {
    let e = this.parsePostfix();
    for (;;) {
      if (this.startsAtomAt(0)) {
        const arg = this.parsePostfix();
        e = { k: "app", fn: e, arg, span: merge(e.span, arg.span) };
        continue;
      }
      // 括弧内では、次の行が引数の続きなら行結合して適用を継続する
      if (
        this.parenDepth > 0 &&
        this.peek().kind === "newline" &&
        this.startsAtomAt(1) &&
        !this.isBindingAheadAt(1)
      ) {
        this.next();
        continue;
      }
      break;
    }
    // 末尾のラムダ引数(`grid [8,8] \i -> ...`)は極大に読む
    if (this.peek().kind === "op" && this.peek().text === "\\") {
      const lam = this.parseLambda();
      e = { k: "app", fn: e, arg: lam, span: merge(e.span, lam.span) };
    }
    return e;
  }

  /** offset 位置のトークンが式(atom)の先頭になり得るか */
  private startsAtomAt(offset: number): boolean {
    const t = this.peek(offset);
    if (t.kind === "num" || t.kind === "time" || t.kind === "str") return true;
    if (t.kind === "ident") return !isKeyword(t) || t.text === "let" || t.text === "if";
    if (t.kind === "op") return t.text === "(" || t.text === "[" || t.text === "{";
    return false;
  }

  private isBindingAheadAt(offset: number): boolean {
    if (this.peek(offset).kind !== "ident" || isKeyword(this.peek(offset))) return false;
    let k = offset + 1;
    while (this.peek(k).kind === "ident" && !isKeyword(this.peek(k))) k++;
    const t = this.peek(k);
    return t.kind === "op" && t.text === "=";
  }

  private parsePostfix(): Expr {
    let e = this.parseAtom();
    for (;;) {
      if (this.peek().kind === "op" && this.peek().text === ".") {
        const dot = this.next();
        const nameTok = this.peek();
        if (nameTok.kind !== "ident") {
          throw new CompileError("`.` の後にはフィールド名が必要です", dot.span);
        }
        this.next();
        e = { k: "field", target: e, name: nameTok.text, span: merge(e.span, nameTok.span) };
        continue;
      }
      break;
    }
    return e;
  }

  private parseLambda(): Expr {
    const start = this.eat("\\");
    const params: Param[] = [];
    while (this.peek().kind === "ident" && !isKeyword(this.peek())) {
      const p = this.next();
      params.push({ name: p.text, span: p.span });
    }
    if (params.length === 0) {
      throw new CompileError("ラムダには少なくとも1つの引数が必要です(例: \\i -> ...)", start.span);
    }
    this.eat("->");
    this.maybeSkipIndentedNewline();
    // ラムダ本体はパイプ以降も含めて極大に読むが、括弧の外では
    // ラムダ開始行以下のインデントの行が来たら終わる(例4 の |> blendAll)
    this.lamAnchors.push(this.parenDepth > 0 ? -1 : (start.lineIndent ?? 0));
    let body: Expr;
    try {
      body = this.parseExpr(PREC["|>"]);
    } finally {
      this.lamAnchors.pop();
    }
    return { k: "lam", params, body, span: merge(start.span, body.span) };
  }

  private parseAtom(): Expr {
    const t = this.peek();

    if (t.kind === "num") {
      this.next();
      return { k: "num", value: t.value!, span: t.span };
    }
    if (t.kind === "time") {
      this.next();
      return { k: "time", value: t.value!, unit: t.unit as "s" | "beat", span: t.span };
    }
    if (t.kind === "str") {
      this.next();
      return { k: "str", text: t.text, span: t.span };
    }

    if (t.kind === "ident") {
      if (t.text === "let") return this.parseLet();
      if (t.text === "if") return this.parseIf();
      if (isKeyword(t)) {
        throw new CompileError(`ここに \`${t.text}\` は書けません`, t.span);
      }
      this.next();
      return { k: "var", name: t.text, span: t.span };
    }

    if (t.kind === "op") {
      if (t.text === "(") {
        this.next();
        this.parenDepth++;
        this.skipNewlines();
        const e = this.parseExpr(0);
        this.skipNewlines();
        this.parenDepth--;
        this.eat(")");
        return { ...e, span: merge(t.span, this.toks[this.pos - 1].span) };
      }
      if (t.text === "[") {
        this.next();
        this.parenDepth++;
        const items: Expr[] = [];
        this.skipNewlines();
        if (!this.at("]")) {
          for (;;) {
            items.push(this.parseExpr(0));
            this.skipNewlines();
            if (this.at(",")) {
              this.next();
              this.skipNewlines();
              continue;
            }
            break;
          }
        }
        this.parenDepth--;
        const close = this.eat("]");
        return { k: "list", items, span: merge(t.span, close.span) };
      }
      if (t.text === "{") {
        this.next();
        this.parenDepth++;
        const fields: { name: string; expr: Expr; span: Span }[] = [];
        this.skipNewlines();
        if (!this.at("}")) {
          for (;;) {
            const nameTok = this.peek();
            if (nameTok.kind !== "ident") {
              throw new CompileError("レコードのフィールド名が必要です", nameTok.span);
            }
            this.next();
            this.eat(":");
            this.skipNewlines();
            const e = this.parseExpr(0);
            fields.push({ name: nameTok.text, expr: e, span: merge(nameTok.span, e.span) });
            this.skipNewlines();
            if (this.at(",")) {
              this.next();
              this.skipNewlines();
              continue;
            }
            break;
          }
        }
        this.parenDepth--;
        const close = this.eat("}");
        return { k: "record", fields, span: merge(t.span, close.span) };
      }
      if (t.text === "\\") {
        return this.parseLambda();
      }
    }

    throw new CompileError(`式が必要ですが \`${t.text || t.kind}\` があります`, t.span);
  }

  private parseLet(): Expr {
    const kw = this.eat("let");
    this.maybeSkipIndentedNewline();
    const binds: Bind[] = [];
    for (;;) {
      if (this.at("in")) break;
      if (!this.isBindingAhead()) {
        const t = this.peek();
        throw new CompileError(
          `let には \`名前 = 式\` の束縛が必要ですが \`${t.text || t.kind}\` があります`,
          t.span,
        );
      }
      binds.push(this.parseLetBinding());
      // 束縛の区切り: 改行 or `;`
      if (this.at(";")) {
        this.next();
        this.maybeSkipIndentedNewline();
        continue;
      }
      if (this.peek().kind === "newline") {
        // `in` は浅いインデントでも良いので無条件に読み飛ばして判定
        this.next();
        continue;
      }
      break;
    }
    this.eat("in");
    this.maybeSkipIndentedNewline();
    const body = this.parseExpr(0);
    return { k: "let", binds, body, span: merge(kw.span, body.span) };
  }

  /** let 内の束縛。式は `in` / 改行(次が束縛 or in)で止まる */
  private parseLetBinding(): Bind {
    const nameTok = this.next();
    const params: Param[] = [];
    while (this.peek().kind === "ident" && !isKeyword(this.peek())) {
      const p = this.next();
      params.push({ name: p.text, span: p.span });
    }
    this.eat("=");
    this.maybeSkipIndentedNewline();
    const expr = this.parseExpr(0);
    return { name: nameTok.text, params, expr, span: merge(nameTok.span, expr.span) };
  }

  private parseIf(): Expr {
    const kw = this.eat("if");
    this.maybeSkipIndentedNewline();
    const cond = this.parseExpr(0);
    this.skipNewlines();
    this.eat("then");
    this.maybeSkipIndentedNewline();
    const then = this.parseExpr(0);
    this.skipNewlines();
    this.eat("else");
    this.maybeSkipIndentedNewline();
    const else_ = this.parseExpr(0);
    return { k: "if", cond, then, else_, span: merge(kw.span, else_.span) };
  }
}
