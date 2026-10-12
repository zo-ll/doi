// Injected into each design iframe. The iframe is sandboxed without same-origin access,
// so this script talks to the app only through postMessage.
(() => {
  document.addEventListener(
    "click",
    (event) => {
      const el = event.target instanceof Element ? event.target.closest("[data-oid]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      const r = el.getBoundingClientRect();
      parent.postMessage(
        { type: "doi:select", oid: el.getAttribute("data-oid"), rect: { x: r.x, y: r.y, width: r.width, height: r.height } },
        "*",
      );
    },
    true,
  );
})();
