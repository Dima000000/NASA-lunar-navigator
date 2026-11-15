import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  out = fileURLToPath(new URL("../work/drive-review/", import.meta.url));
fs.mkdirSync(out, { recursive: true });
const server = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4174",
    "--strictPort",
  ],
  { cwd: root, windowsHide: true },
);
try {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (v) => {
      if (String(v).includes("127.0.0.1")) resolve();
    });
    server.on("error", reject);
    server.on("exit", (code) => {
      if (code) reject(Error("Preview exited " + code));
    });
    setTimeout(() => reject(Error("Preview did not start")), 30000).unref();
  });
  for (const script of [
    "drive-review.mjs",
    "drive-occlusion-review.mjs",
    "ui-touch-review.mjs",
  ])
    await new Promise((resolve, reject) => {
      const log = fs.createWriteStream(out + "/" + script + ".txt"),
        p = spawn(
          process.execPath,
          [fileURLToPath(new URL(script, import.meta.url))],
          {
            cwd: root,
            windowsHide: true,
            env: {
              ...process.env,
              BASE_URL: "http://127.0.0.1:4174/",
              UI_REVIEW_OUT: out,
            },
          },
        );
      p.stdout.on("data", (v) => {
        process.stdout.write(v);
        log.write(v);
      });
      p.stderr.on("data", (v) => {
        process.stderr.write(v);
        log.write(v);
      });
      p.on("error", reject);
      p.on("exit", (code) => {
        log.end();
        code === 0 ? resolve() : reject(Error(script + " failed: " + code));
      });
    });
} finally {
  server.kill();
}
