// Injected into each design iframe. The iframe is sandboxed without same-origin access,
// so this script talks to the app only through postMessage.
//
// Frame → app: doi:ready, doi:select { oid }, doi:clear, doi:rects { selected, hover, pins }.
// App → frame: doi:track { oid, pins } names the selected element (or null) and the elements
// with open comments.
// Rects are in the coordinates of this frame's viewport.
(() => {
  let selectedOid = null;
  let pinOids = [];
  let hovered = null; // element under the pointer
  let last = "";

  const send = (message) => parent.postMessage(message, "*");
  const owner = (node) => (node instanceof Element ? node.closest("[data-oid]") : null);
  const find = (oid) => (oid === null ? null : document.querySelector(`[data-oid="${CSS.escape(oid)}"]`));
  const rectOf = (el) => {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    // A hidden element (display: none) has no box; draw nothing for it.
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  // Sends the rects when they changed. Runs on each animation frame while something is shown,
  // so the overlay follows scrolling, resizing, layout changes and animations.
  let scheduled = false;
  const report = () => {
    scheduled = false;
    const hoverOid = hovered?.getAttribute("data-oid") ?? null;
    const message = {
      type: "doi:rects",
      selected: rectOf(find(selectedOid)),
      hover: hovered && hoverOid !== selectedOid ? { oid: hoverOid, rect: rectOf(hovered) } : null,
      // No prototype: an element may have the id "__proto__".
      pins: Object.create(null),
    };
    for (const oid of pinOids) {
      const rect = rectOf(find(oid));
      if (rect) message.pins[oid] = rect;
    }
    if (message.hover && !message.hover.rect) message.hover = null;
    const json = JSON.stringify(message);
    if (json !== last) {
      last = json;
      send(message);
    }
    if (selectedOid !== null || hovered || pinOids.length) schedule();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(report);
  };

  document.addEventListener(
    "click",
    (event) => {
      const el = owner(event.target);
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      let target = el;
      if (event.shiftKey) {
        // Shift-click selects the parent: of the current selection when the click is inside it,
        // else of the clicked element.
        const current = find(selectedOid);
        const from = current && current.contains(el) ? current : el;
        target = owner(from.parentElement) ?? from;
      }
      send({ type: "doi:select", oid: target.getAttribute("data-oid") });
    },
    true,
  );

  // Hover outline before a click.
  document.addEventListener("mouseover", (event) => {
    hovered = owner(event.target);
    schedule();
  });
  document.documentElement.addEventListener("mouseleave", () => {
    hovered = null;
    schedule();
  });

  // The iframe has the keyboard focus after a click, so the app does not see this key.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send({ type: "doi:clear" });
  });

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const d = event.data;
    if (d?.type !== "doi:track" || (d.oid !== null && typeof d.oid !== "string")) return;
    selectedOid = d.oid;
    pinOids = Array.isArray(d.pins) ? d.pins.filter((p) => typeof p === "string") : [];
    last = ""; // the app may have dropped the old rects, so send them again
    schedule();
  });

  // The rects can change without an animation frame request: report on these too.
  addEventListener("scroll", schedule, { capture: true, passive: true });
  addEventListener("resize", schedule);
  addEventListener("load", schedule);
  send({ type: "doi:ready" });
})();
