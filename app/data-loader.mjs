// Measured delivery progress and bounded retries; failed promises never poison the cache.
const cache = new Map();
let manifest = {},
  loaded = 0,
  total = 0,
  onProgress = () => {};
export function configureDelivery(files, report) {
  manifest = files;
  loaded = 0;
  total = 0;
  onProgress = report || (() => {});
}
export function deliveryProgress() {
  return { loaded, total };
}
export async function fetchBytes(url, { gzip = false, tries = 3 } = {}) {
  const key = url + "|" + gzip;
  if (cache.has(key)) return cache.get(key);
  const task = (async () => {
    const expected = manifest[url.replace(/^data\//, "")]?.bytes || 0;
    total += expected;
    let credited = 0;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const abort = new AbortController();
      let timer = setTimeout(() => abort.abort(), 45000);
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) throw Error("HTTP " + response.status);
        const alreadyDecoded =
          gzip && /gzip/i.test(response.headers.get("Content-Encoding") || "");
        const decodedSize = manifest[url.replace(/^data\//, "")]?.decodedBytes,
          ratio = alreadyDecoded && decodedSize ? expected / decodedSize : 1;
        const parts = [];
        let size = 0;
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(timer);
          timer = setTimeout(() => abort.abort(), 45000);
          parts.push(value);
          size += value.length;
          loaded += value.length * ratio;
          credited += value.length * ratio;
          if (!expected) total += value.length * ratio;
          onProgress({ loaded, total, url });
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const p of parts) {
          bytes.set(p, offset);
          offset += p.length;
        }
        if (expected && size !== (alreadyDecoded ? decodedSize : expected))
          throw Error("Incomplete download");
        const item = manifest[url.replace(/^data\//, "")],
          hash = alreadyDecoded ? item?.decodedSha256 : item?.sha256;
        if (hash && globalThis.crypto?.subtle) {
          const digest = await crypto.subtle.digest("SHA-256", bytes),
            actual = Array.from(new Uint8Array(digest), (x) =>
              x.toString(16).padStart(2, "0"),
            ).join("");
          if (actual !== hash) throw Error("Data checksum mismatch");
        }
        if (gzip && !alreadyDecoded) {
          if (typeof DecompressionStream === "undefined")
            throw Error("This browser needs gzip decompression support");
          return await new Response(
            new Blob([bytes])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer();
        }
        return bytes.buffer;
      } catch (e) {
        loaded -= credited;
        if (!expected) total -= credited;
        credited = 0;
        if (attempt === tries) {
          total -= expected;
          throw Error(
            "Could not load " +
              url +
              " (" +
              e.message +
              "). Please reload to retry.",
          );
        }
        await new Promise((r) => setTimeout(r, 300 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
  })();
  cache.set(key, task);
  task.catch(() => cache.delete(key));
  return task;
}
export async function fetchJSON(url) {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url)));
}
export async function fetchImage(url) {
  const bytes = await fetchBytes(url),
    image = new Image(),
    objectURL = URL.createObjectURL(new Blob([bytes]));
  try {
    image.src = objectURL;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}
