// noname を実ブラウザ(システムの Google Chrome、実 WebGPU アダプタ)で起動して
// 検証するドライバ。`npm run dev` が http://localhost:8787/ で動いている前提。
//
// 使い方:
//   node verify.mjs                  # 起動確認 + スクリーンショットのみ
//   node verify.mjs --scrub          # Alt+ドラッグの数値スクラブも検証
//   node verify.mjs --url http://localhost:8787/ --out /tmp/noname.png
import { chromium } from "playwright";

const args = process.argv.slice(2);
const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:8787/";
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "/tmp/noname-verify.png";
const doScrub = args.includes("--scrub");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const consoleErrors = [];
// ブラウザの汎用「リソース読み込み失敗」ログは URL を含まないので、実際の
// URL は response イベント側で見て、favicon.ico の 404(既知・無害。この
// プロジェクトは favicon を用意していない)だけを除外する
const unexpectedFailedUrls = [];
page.on("response", (r) => {
  if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) unexpectedFailedUrls.push(`${r.status()} ${r.url()}`);
});
page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
});

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#boot.ready", { timeout: 15000 });

const gpu = await page.evaluate(async () => {
  if (!("gpu" in navigator)) return { hasGpu: false };
  const adapter = await navigator.gpu.requestAdapter();
  return { hasGpu: true, hasAdapter: !!adapter };
});
console.log("gpu:", gpu);
if (!gpu.hasAdapter) {
  console.error("WebGPU アダプタが取得できませんでした(headless の GPU フラグ/ドライバを確認)");
}

if (doScrub) {
  // エディタ内の最初の数値リテラルにキャレットを置き、Alt を押しながら
  // 高速に pointermove を連射する(scrub の流量制御・coalescing の検証、ADR-0028)
  await page.evaluate(() => {
    const editor = document.getElementById("editor");
    const m = /\d+(\.\d+)?/.exec(editor.value);
    if (!m) throw new Error("エディタ内に数値リテラルが見つかりません");
    editor.focus();
    editor.selectionStart = editor.selectionEnd = m.index + 1;
  });
  const box = await page.locator("#editor").boundingBox();
  const x0 = box.x + 50;
  const y0 = box.y + 20;
  await page.mouse.move(x0, y0);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(x0 + i * 3, y0, { steps: 1 });
  }
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(500); // coalesced な後追いが収束するのを待つ
  const src = await page.locator("#editor").inputValue();
  console.log("source after scrub (first line):", src.split("\n")[0]);
}

await page.waitForTimeout(1200); // #fps は1秒に1回しか更新されないので、確実に1回は挟む
console.log("fps:", await page.locator("#fps").textContent().catch(() => null));
console.log("status:", await page.locator("#status").textContent().catch(() => null));

await page.screenshot({ path: out });
console.log("screenshot:", out);

console.log("console errors:", consoleErrors.length > 0 ? consoleErrors.join("\n") : "(none)");
console.log("unexpected failed requests:", unexpectedFailedUrls.length > 0 ? unexpectedFailedUrls.join("\n") : "(none)");

await browser.close();
process.exit(consoleErrors.length > 0 || unexpectedFailedUrls.length > 0 || !gpu.hasAdapter ? 1 : 0);
