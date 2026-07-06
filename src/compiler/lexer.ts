// 手書き字句解析器(implementation.md 1.1)。
// - 単項マイナスは字句レベルで解決: 「`-` の直前がリテラル/識別子/閉じ括弧なら二項、それ以外は単項」
// - 時間リテラル `0.5s` `1beat` を一体で読む
// - 改行は常に NEWLINE トークン(インデント付き)として発行し、括弧内の行結合はパーサが行う
//   (閉じ忘れ括弧があってもエラー回復で次の文へ進めるようにするため)
// - `--` は行コメント、`"""..."""` は生文字列(FFI ブロック用)

import { CompileError, span, type Span } from "./diag.ts";

export type TokKind =
  | "num" // 数値リテラル
  | "time" // 時間リテラル(unit: "s" | "beat")
  | "ident"
  | "str" // """...""" 生文字列
  | "op" // 演算子・区切り(text で識別)
  | "newline" // 行区切り(indent = 次行のインデント)
  | "eof";

export interface Tok {
  kind: TokKind;
  text: string;
  value?: number; // num / time
  unit?: string; // time: "s" | "beat"
  indent?: number; // newline: 次の行のインデント幅
  /** このトークンがある行のインデント幅(ラムダ本体の終端判定に使う) */
  lineIndent?: number;
  span: Span;
}

const KEYWORDS = new Set(["let", "in", "if", "then", "else", "out"]);
export function isKeyword(t: Tok): boolean {
  return t.kind === "ident" && KEYWORDS.has(t.text);
}

// 長いものから照合する演算子表
const OPERATORS = [
  "<over>",
  "<+>",
  "|>",
  "->",
  "<>",
  "<=",
  ">=",
  "==",
  "!=",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  ";",
  "\\",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  ".",
];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_']/.test(c);
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  let curLineIndent = 0;
  {
    // 先頭行のインデント
    let j = 0;
    while (j < n && (src[j] === " " || src[j] === "\t")) {
      curLineIndent += src[j] === "\t" ? 4 : 1;
      j++;
    }
  }
  const push = (t: Tok): void => {
    if (t.kind !== "newline") t.lineIndent = curLineIndent;
    toks.push(t);
  };

  const prevMeaningful = (): Tok | undefined => {
    for (let k = toks.length - 1; k >= 0; k--) {
      if (toks[k].kind !== "newline") return toks[k];
    }
    return undefined;
  };

  while (i < n) {
    const c = src[i];

    // 行コメント
    if (c === "-" && src[i + 1] === "-") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // 空白
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    // 改行: 括弧内なら無視。次行のインデントを測る
    if (c === "\n") {
      let j = i + 1;
      // 連続する空行・コメント行を飛ばして「次に意味のある行」のインデントを得る
      let indent = 0;
      while (j < n) {
        indent = 0;
        while (j < n && (src[j] === " " || src[j] === "\t")) {
          indent += src[j] === "\t" ? 4 : 1;
          j++;
        }
        if (j < n && src[j] === "\n") {
          j++;
          continue;
        }
        if (j < n && src[j] === "-" && src[j + 1] === "-") {
          while (j < n && src[j] !== "\n") j++;
          continue;
        }
        break;
      }
      // 直前が newline なら重複させない(indent は更新)
      {
        const last = toks[toks.length - 1];
        if (last && last.kind === "newline") {
          last.indent = indent;
          last.span = span(last.span.start, j);
        } else if (toks.length > 0) {
          push({ kind: "newline", text: "\n", indent, span: span(i, j) });
        }
      }
      curLineIndent = indent;
      i = j;
      continue;
    }

    // 生文字列 """..."""
    if (src.startsWith('"""', i)) {
      const start = i;
      i += 3;
      const end = src.indexOf('"""', i);
      if (end < 0) throw new CompileError("閉じられていない文字列ブロック(\"\"\" が必要)", span(start, n));
      push({ kind: "str", text: src.slice(i, end), span: span(start, end + 3) });
      i = end + 3;
      continue;
    }

    // 数値・時間リテラル
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === "." && isDigit(src[i + 1] ?? "")) {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      const numText = src.slice(start, i);
      const value = Number(numText);
      // 直後に単位が続くか(空白なし)
      if (i < n && isIdentStart(src[i])) {
        const us = i;
        while (i < n && isIdentPart(src[i])) i++;
        const unit = src.slice(us, i);
        if (unit === "s") {
          push({ kind: "time", text: src.slice(start, i), value, unit: "s", span: span(start, i) });
        } else if (unit === "beat" || unit === "beats" || unit === "b") {
          push({ kind: "time", text: src.slice(start, i), value, unit: "beat", span: span(start, i) });
        } else {
          throw new CompileError(
            `数値の単位 \`${unit}\` は知りません(使えるのは s / beat)`,
            span(us, i),
          );
        }
      } else {
        push({ kind: "num", text: numText, value, span: span(start, i) });
      }
      continue;
    }

    // 識別子・キーワード
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(src[i])) i++;
      push({ kind: "ident", text: src.slice(start, i), span: span(start, i) });
      continue;
    }

    // 演算子
    let matched: string | null = null;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      // 単項マイナスの字句レベル解決
      if (matched === "-") {
        const prev = prevMeaningful();
        const binary =
          prev &&
          (prev.kind === "num" ||
            prev.kind === "time" ||
            (prev.kind === "ident" && !KEYWORDS.has(prev.text)) ||
            (prev.kind === "op" && (prev.text === ")" || prev.text === "]" || prev.text === "}")));
        push({ kind: "op", text: binary ? "-" : "neg", span: span(i, i + 1) });
        i += 1;
        continue;
      }
      push({ kind: "op", text: matched, span: span(i, i + matched.length) });
      i += matched.length;
      continue;
    }

    throw new CompileError(`解釈できない文字: \`${c}\``, span(i, i + 1));
  }

  toks.push({ kind: "eof", text: "", span: span(n, n) });
  return toks;
}
