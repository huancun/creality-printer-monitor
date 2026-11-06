// Lazy-loads the standalone 3D viewer from the Vite public directory
// (/viewer.js). It is a plain ES module that sets `window.PMViewer`,
// so a <script type="module"> tag works in dev and in production.
let pending = null;

export function loadViewer() {
  if (window.PMViewer) return Promise.resolve(window.PMViewer);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    if (!document.getElementById("pm-viewer-css")) {
      const link = document.createElement("link");
      link.id = "pm-viewer-css";
      link.rel = "stylesheet";
      link.href = "/viewer.css";
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/viewer.js";
    script.onload = () => {
      if (window.PMViewer) resolve(window.PMViewer);
      else {
        pending = null;
        reject(new Error("3D 预览不可用"));
      }
    };
    script.onerror = () => {
      pending = null;
      reject(new Error("无法加载 3D 预览模块"));
    };
    document.head.appendChild(script);
  });
  return pending;
}
