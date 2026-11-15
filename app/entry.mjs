import "./standalone-runtime.js";
import "./ui-pass.css";
import {withUIPass} from "./ui-pass.mjs";
import "./component.js";
import { loadRealMoon } from "./real-moon.js";
import { loadScience, enhancedComponent } from "./science-runtime.mjs";
import { configureDelivery, fetchJSON } from "./data-loader.mjs";
const status = document.getElementById("loadStatus");
const failure = (e) => {
  console.error(e);
  const message = String(e?.message || e);
  const text = message.includes("Please reload")
    ? message
    : "Could not load lunar data: " + message + ". Please reload to retry.";
  if (status?.isConnected) status.textContent = text;
  else if (window.NASAL) {
    window.NASAL._dataError = text;
    window.NASAL.setState({ windowStatus: text, routeStatus: text });
  }
};
window.addEventListener("unhandledrejection", (e) => failure(e.reason));
try {
  const manifest = await fetchJSON("data/delivery-manifest.json");
  let lastProgress = 0;
  configureDelivery(manifest.files, (p) => {
    window.NASALDataProgress = p;
    if (status?.isConnected)
      status.textContent =
        "Loading measured lunar overview… " +
        (p.loaded / 1e6).toFixed(1) +
        " / " +
        (p.total / 1e6).toFixed(1) +
        " MB";
    else if (
      (window.NASAL?._dataLoading || window.NASAL?._detailLoading) &&
      performance.now() - lastProgress > 150
    ) {
      lastProgress = performance.now();
      window.NASAL.setState({});
    }
  });
  const moonJob = loadRealMoon(),
    scienceJob = loadScience({});
  [window.RealMoon, window.SCIENCE] = await Promise.all([moonJob, scienceJob]);
  // Science's terrain adapter attaches only after the quick overview is available.
  window.SCIENCE.attachMoon(window.RealMoon);
  window.mountNASAL(
    withUIPass(enhancedComponent(window.NASALComponent, window.SCIENCE), window.SCIENCE),
    document
      .getElementById("app-template")
      .content.firstElementChild.cloneNode(true),
  );
  document.getElementById("realMoonLoading").remove();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      window.NASALInitialReadyMs = performance.now();
      setTimeout(
        () =>
          window.SCIENCE.loadTerrain(window.SCIENCE.catalog[0].key).catch(
            failure,
          ),
        0,
      );
    }),
  );
} catch (e) {
  failure(e);
}
