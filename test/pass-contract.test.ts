// pass-contract.ts(compiler↔runtime パス契約)の検査。
// - uniform layout / binding 規約の整合
// - 各構築子のハッシュ完全性(ミューテーションテスト): ADR-0041 の教訓
//   (「IRグラフの外にある数値がパスの見た目に影響するのにハッシュに含まれて
//   いない」バグは新設パスごとに再発しうる)の一般化。hash に影響すべき引数を
//   1つずつ変えて hash が必ず変わることを、全構築子について機械的に検査する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BINDING_SAMPLER,
  BINDING_UNIFORM,
  HEADER_FLOATS,
  finalizePassHashes,
  inputOffset,
  literalOffset,
  makeBloomDownPass,
  makeBloomExtractPass,
  makeBloomUpPass,
  makeDataPass,
  makeImagePass,
  makeRaymarchPass,
  makeSimPass,
  makeSpritePass,
  makeStrip3dPass,
  makeStripPass,
  programHashOf,
  pxOf,
  textureBinding,
  textureWgslDecls,
  uniformFloatCount,
  uniformWgslDecl,
  type CompiledPass,
  type UniformLayout,
} from "../src/compiler/pass-contract.ts";

// ---- uniform layout / binding 契約 --------------------------------------------------

test("uniform layout: header・inputs・literals のオフセットが整合する", () => {
  const layout: UniformLayout = { inputs: ["time", "etime", "px"], literalBase: 3, literalCount: 5, slotCount: 2 };
  // 入力スロット 0 は header の直後
  assert.equal(inputOffset(0), HEADER_FLOATS);
  assert.equal(inputOffset(2), HEADER_FLOATS + 2);
  // リテラルは inputs の直後(literalBase = inputs.length)から始まる
  assert.equal(literalOffset(layout, 0), inputOffset(layout.inputs.length));
  assert.equal(literalOffset(layout, 4), HEADER_FLOATS + 3 + 4);
  // バッファ全体 = header + slotCount 個の vec4
  assert.equal(uniformFloatCount(layout), HEADER_FLOATS + 2 * 4);
  // 全リテラルがバッファに収まるレイアウトである
  assert.ok(literalOffset(layout, layout.literalCount - 1) < uniformFloatCount(layout));
});

test("pxOf: 短辺基準で 2/短辺、ゼロ除算なし", () => {
  assert.equal(pxOf(800, 600), 2 / 600);
  assert.equal(pxOf(600, 800), 2 / 600);
  assert.equal(pxOf(0, 0), 2); // Math.max(1, ...) ガード
});

test("uniformWgslDecl: binding 0/1 と array<vec4f, N> を宣言する", () => {
  const decl = uniformWgslDecl(3);
  assert.ok(decl.includes(`@binding(${BINDING_UNIFORM})`));
  assert.ok(decl.includes(`@binding(${BINDING_SAMPLER})`));
  assert.ok(decl.includes("array<vec4f, 3>"));
  // slotCount 0 でも最低 1 は確保する(WGSL の array<_, 0> は不正)
  assert.ok(uniformWgslDecl(0).includes("array<vec4f, 1>"));
});

test("textureWgslDecls: テクスチャは binding 2 から順に並ぶ", () => {
  assert.equal(textureBinding(0), 2);
  const decls = textureWgslDecls(["a", "b"]);
  assert.ok(decls.includes("@binding(2) var tex0"));
  assert.ok(decls.includes("@binding(3) var tex1"));
});

// ---- ハッシュ完全性(ミューテーションテスト) ----------------------------------------
//
// 各構築子について: 基準引数で2回構築すると hash が一致し(決定性)、
// hash に影響すべき引数を1つずつ変えると hash が必ず変わることを検査する。

const core = { code: "code", targets: 1, textures: ["t0"], lineSpans: [] as null[] };

/** base で2回構築 → 一致、mutations の各差分適用 → 不一致、を機械的に検査 */
function checkHash<A extends object>(
  label: string,
  make: (args: A) => CompiledPass,
  base: A,
  mutations: Partial<A>[],
): void {
  const h0 = make(base).hash;
  assert.equal(make(base).hash, h0, `${label}: 同一引数で hash が決定的でない`);
  for (const m of mutations) {
    const h = make({ ...base, ...m }).hash;
    assert.notEqual(h, h0, `${label}: ${JSON.stringify(m)} が hash に影響していない`);
  }
}

test("makeSimPass: sig/kind(phase)/structuralHash/inputs が hash に効く", () => {
  checkHash(
    "sim",
    makeSimPass,
    { ...core, kind: "sim-init" as const, simName: "s", sig: "sig1", structuralHash: "aa", inputs: ["time"] },
    [{ kind: "sim-update" as const }, { sig: "sig2" }, { structuralHash: "bb" }, { inputs: ["etime"] }],
  );
});

test("makeDataPass: label/dataCount(instanced のみ)/structuralHash/inputs が hash に効く", () => {
  // instanced 系ラベル: count が hash に効く(ADR-0041 の本丸)
  checkHash(
    "sprite-data",
    makeDataPass,
    { ...core, dataKey: "sprite:1", dataCount: 5, label: "sprite-data" as const, structuralHash: "aa", inputs: ["time"] },
    [
      { dataCount: 50 },
      { label: "strip-data" as const },
      { label: "strip3-data" as const },
      { structuralHash: "bb" },
      { inputs: [] },
    ],
  );
  // 巻き上げ data: count は roots(structuralHash)から導出されるので hash には直接入らない
  // (現行 wgsl.ts の式と同一)。structuralHash と inputs は効く
  checkHash(
    "data",
    makeDataPass,
    { ...core, dataKey: "data:1", dataCount: 5, label: "data" as const, structuralHash: "aa", inputs: ["time"] },
    [{ structuralHash: "bb" }, { inputs: [] }],
  );
});

test("makeRaymarchPass: structuralHash/inputs が hash に効く", () => {
  // halfRes は dist の IR 構造(loopWorkOf)から導出されるため hash に直接は入らない
  // (dist が structuralHash に含まれているので安全 — 構築子の doc コメント参照)
  checkHash(
    "raymarch",
    makeRaymarchPass,
    { ...core, rmId: 0, halfRes: false, structuralHash: "aa", inputs: ["time"] },
    [{ structuralHash: "bb" }, { inputs: [] }],
  );
});

test("makeSpritePass: loopId/count/structuralHash/inputs が hash に効く", () => {
  checkHash(
    "sprite",
    makeSpritePass,
    { ...core, rmId: 0, count: 5, loopId: 1, structuralHash: "aa", inputs: ["time"] },
    [{ count: 50 }, { loopId: 2 }, { structuralHash: "bb" }, { inputs: [] }],
  );
});

test("makeStrip3dPass: loopId/count/segs/structuralHash/inputs が hash に効く", () => {
  checkHash(
    "strip3d",
    makeStrip3dPass,
    { ...core, rmId: 0, count: 5, vertexCount: 34, loopId: 1, segs: 16, structuralHash: "aa", inputs: ["time"] },
    [{ count: 50 }, { loopId: 2 }, { segs: 8 }, { structuralHash: "bb" }, { inputs: [] }],
  );
});

test("makeStripPass: loopId/count/segs/inputs が hash に効く", () => {
  checkHash(
    "strip",
    makeStripPass,
    { ...core, count: 5, vertexCount: 34, loopId: 1, segs: 16, inputs: ["time"] },
    [{ count: 50 }, { loopId: 2 }, { segs: 8 }, { inputs: [] }],
  );
});

test("makeBloomExtractPass: bloomId/structuralHash/inputs が hash に効く", () => {
  checkHash(
    "bloom-extract",
    makeBloomExtractPass,
    { ...core, bloomId: 0, outKey: "bloom:0:n", resDivisor: 1, structuralHash: "aa", inputs: ["time"] },
    [{ bloomId: 1 }, { structuralHash: "bb" }, { inputs: [] }],
  );
});

test("makeBloomDownPass: bloomId/srcKey/dstKey が hash に効く", () => {
  checkHash(
    "bloom-down",
    makeBloomDownPass,
    { ...core, bloomId: 0, outKey: "bloom:0:e", resDivisor: 2, srcKey: "bloom:0:n", dstKey: "bloom:0:e" },
    [{ bloomId: 1 }, { srcKey: "bloom:0:d1" }, { dstKey: "bloom:0:d2" }],
  );
});

test("makeBloomUpPass: bloomId/smallKey/skipKey/dstKey が hash に効く", () => {
  checkHash(
    "bloom-up",
    makeBloomUpPass,
    { ...core, bloomId: 0, outKey: "bloom:0:u0", resDivisor: 2, smallKey: "bloom:0:u1", skipKey: "bloom:0:e", dstKey: "bloom:0:u0" },
    [{ bloomId: 1 }, { smallKey: "bloom:0:d2" }, { skipKey: "bloom:0:d1" }, { dstKey: "bloom:0:u1" }],
  );
});

test("makeImagePass: structuralHash/inputs が hash に効く", () => {
  checkHash(
    "image",
    makeImagePass,
    { ...core, structuralHash: "aa", inputs: ["time"] },
    [{ structuralHash: "bb" }, { inputs: [] }],
  );
});

// ---- finalize / programHash ---------------------------------------------------------

test("finalizePassHashes: slotCount とテクスチャ構成が hash に効く(パイプライン誤共有防止)", () => {
  const mk = (): CompiledPass =>
    makeImagePass({ ...core, structuralHash: "aa", inputs: ["time"] });
  const a = [mk()];
  const b = [mk()];
  const c = [mk()];
  finalizePassHashes(a, 1);
  finalizePassHashes(b, 2); // slotCount 違い
  c[0].textures = ["t0", "t1"];
  finalizePassHashes(c, 1); // テクスチャ構成違い
  assert.notEqual(a[0].hash, b[0].hash);
  assert.notEqual(a[0].hash, c[0].hash);
  // 同条件なら一致
  const a2 = [mk()];
  finalizePassHashes(a2, 1);
  assert.equal(a[0].hash, a2[0].hash);
});

test("programHashOf: パス hash の列と usesPrev が効く", () => {
  const mk = (sh: string): CompiledPass => makeImagePass({ ...core, structuralHash: sh, inputs: [] });
  const h1 = programHashOf([mk("aa")], false);
  assert.equal(programHashOf([mk("aa")], false), h1);
  assert.notEqual(programHashOf([mk("bb")], false), h1);
  assert.notEqual(programHashOf([mk("aa")], true), h1);
  assert.notEqual(programHashOf([mk("aa"), mk("aa")], false), h1);
});
