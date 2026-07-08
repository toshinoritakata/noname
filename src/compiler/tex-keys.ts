// テクスチャキーの命名規約(候補3: compiler が発行し runtime(program.ts)が正規表現で
// 再解析していた文字列プロトコルを1つの module に集約する)。
// compiler 側(stage/stdlib/wgsl)はここのビルダーで「fetch/sample の tex 名」や
// CompiledPass.dataKey/bloomOutKey を作り、runtime 側(program.ts)は parseTexKey() で
// 同じ規約を読み戻す。キー形式を変えるときはこのファイルだけを直せばよい。

export const texKeyPrev = "prev";
export const texKeyScene = "scene";

export const texKeySim = (name: string, index: number): string => `sim:${name}:${index}`;
export const texKeyRm = (id: number): string => `rm:${id}`;

export const texKeyData = (loopId: number): string => `data:${loopId}`;
export const texKeySprite = (loopId: number): string => `sprite:${loopId}`;
export const texKeyStrip3 = (loopId: number): string => `strip3:${loopId}`;
export const texKeyStrip = (loopId: number): string => `strip:${loopId}`;
/** data/sprite/strip3 データパスの出力テクスチャ(dataKey に MRT の out index を付けたもの) */
export const texKeyDataOut = (dataKey: string, outIndex: number): string => `${dataKey}:${outIndex}`;

export const bloomKeys = {
  native: (id: number): string => `bloom:${id}:n`,
  extract: (id: number): string => `bloom:${id}:e`,
  down: (id: number, i: number): string => `bloom:${id}:d${i}`,
  up: (id: number, i: number): string => (i === 0 ? `bloom:${id}:u0` : `bloom:${id}:u${i}`),
};

export type ParsedTexKey =
  | { kind: "prev" }
  | { kind: "scene" }
  | { kind: "sim"; name: string; index: number }
  | { kind: "rm"; id: number }
  | { kind: "bloom" }
  | { kind: "data"; dataKey: string; index: number }
  | { kind: "other" };

/** runtime(program.ts)側の解決窓口。compiler 側のビルダーと1対1で対応する */
export function parseTexKey(key: string): ParsedTexKey {
  if (key === texKeyPrev) return { kind: "prev" };
  if (key === texKeyScene) return { kind: "scene" };
  const sim = key.match(/^sim:(.+):(\d+)$/);
  if (sim) return { kind: "sim", name: sim[1], index: Number(sim[2]) };
  const rm = key.match(/^rm:(\d+)$/);
  if (rm) return { kind: "rm", id: Number(rm[1]) };
  if (key.startsWith("bloom:")) return { kind: "bloom" };
  const data = key.match(/^((?:data|sprite|strip3?):\d+):(\d+)$/);
  if (data) return { kind: "data", dataKey: data[1], index: Number(data[2]) };
  return { kind: "other" };
}
