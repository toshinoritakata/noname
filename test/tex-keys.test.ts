// テクスチャキー protocol の round-trip テスト(候補3: compiler が発行し program.ts が
// 正規表現で再解析していたキー文字列を tex-keys.ts に集約したもの)。
// ビルダーが作った文字列を parseTexKey が正しく読み戻せることを検査する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { bloomKeys, parseTexKey, texKeyData, texKeyDataOut, texKeyPrev, texKeyRm, texKeyScene, texKeySim, texKeySprite, texKeyStrip, texKeyStrip3 } from "../src/compiler/tex-keys.ts";

test("prev/scene は固定キーとして解決できる", () => {
  assert.deepEqual(parseTexKey(texKeyPrev), { kind: "prev" });
  assert.deepEqual(parseTexKey(texKeyScene), { kind: "scene" });
});

test("sim キーは name/index を保って round-trip する", () => {
  assert.deepEqual(parseTexKey(texKeySim("rd", 2)), { kind: "sim", name: "rd", index: 2 });
  // sim 名自体に ':' を含む可能性は考慮しない(non-greedy な (.+) が末尾の数字を index として拾う)
  assert.deepEqual(parseTexKey(texKeySim("a:b", 0)), { kind: "sim", name: "a:b", index: 0 });
});

test("rm キーは id を保って round-trip する", () => {
  assert.deepEqual(parseTexKey(texKeyRm(7)), { kind: "rm", id: 7 });
});

test("bloom キー各種は bloom kind として解決できる", () => {
  for (const key of [bloomKeys.native(1), bloomKeys.extract(1), bloomKeys.down(1, 2), bloomKeys.up(1, 0), bloomKeys.up(1, 3)]) {
    assert.deepEqual(parseTexKey(key), { kind: "bloom" });
  }
});

test("data/sprite/strip3/strip の出力テクスチャキーは dataKey/index を保って round-trip する", () => {
  assert.deepEqual(parseTexKey(texKeyDataOut(texKeyData(5), 1)), { kind: "data", dataKey: "data:5", index: 1 });
  assert.deepEqual(parseTexKey(texKeyDataOut(texKeySprite(5), 0)), { kind: "data", dataKey: "sprite:5", index: 0 });
  assert.deepEqual(parseTexKey(texKeyDataOut(texKeyStrip3(5), 3)), { kind: "data", dataKey: "strip3:5", index: 3 });
  assert.deepEqual(parseTexKey(texKeyDataOut(texKeyStrip(5), 2)), { kind: "data", dataKey: "strip:5", index: 2 });
});

test("未知のキーは other になる", () => {
  assert.deepEqual(parseTexKey("fft"), { kind: "other" });
});
