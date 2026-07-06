// 数学(場へ自動リフト)。元 stdlib.ts 802-827行。

import { mathFn } from "./shared.ts";
import type { AddFn, AddVFn } from "./shared.ts";

export function installMath(add: AddFn, addV: AddVFn): void {
  addV("sin", mathFn("sin", "sin", 1));
  addV("cos", mathFn("cos", "cos", 1));
  addV("tan", mathFn("tan", "tan", 1));
  addV("atan2", mathFn("atan2", "atan2", 2));
  addV("abs", mathFn("abs", "abs", 1));
  addV("floor", mathFn("floor", "floor", 1));
  addV("ceil", mathFn("ceil", "ceil", 1));
  addV("fract", mathFn("fract", "fract", 1));
  addV("sqrt", mathFn("sqrt", "sqrt", 1));
  addV("pow", mathFn("pow", "pow", 2));
  addV("exp", mathFn("exp", "exp", 1));
  addV("log", mathFn("log", "log", 1));
  addV("sign", mathFn("sign", "sign", 1));
  addV("min", mathFn("min", "min", 2));
  addV("max", mathFn("max", "max", 2));
  addV("clamp", mathFn("clamp", "clamp", 3));
  addV("mix", mathFn("mix", "mix", 3));
  addV("step", mathFn("step", "step", 2));
  addV("smoothstep", mathFn("smoothstep", "smoothstep", 3));
  addV("length", mathFn("length", "length", 1, "f32"));
  addV("normalize", mathFn("normalize", "normalize", 1));
  addV("dot", mathFn("dot", "dot", 2, "f32"));
  addV("cross", mathFn("cross", "cross", 2, "vec3"));
  addV("reflect", mathFn("reflect", "reflect", 2));
  addV("wrap", mathFn("wrap", "fmod", 2));
}
