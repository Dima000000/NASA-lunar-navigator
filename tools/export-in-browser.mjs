import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const server = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4173",
  ],
  { cwd: root, windowsHide: true },
);
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => {
    if (String(d).includes("127.0.0.1")) resolve();
  });
  server.on("error", reject);
  setTimeout(
    () => reject(Error("Preview server startup timed out")),
    30000,
  ).unref();
});
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-proxy-server", "--enable-unsafe-swiftshader"],
});
try {
  const p = await browser.newPage(),
    errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("http://127.0.0.1:4173/");
  await p.waitForFunction(() => window.NASAL, null, { timeout: 120000 });
  await p.evaluate(() =>
    NASAL.setRange(Date.parse("2026-11-14"), Date.parse("2026-12-14")),
  );
  await p.waitForFunction(() => NASAL._ser?.n === 721);
  await p.evaluate(() => NASAL.csv());
  await p.waitForFunction(() => NASAL.state.csvUrl);
  const csv = await p.evaluate(
    async () => await (await fetch(NASAL.state.csvUrl)).text(),
  );
  fs.writeFileSync(path.join(root, "public/research/browser-export.csv"), csv);
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Exported actual browser component CSV:",
    csv.split("\n").length,
    "rows",
  );
} finally {
  await browser.close();
  server.kill();
}
