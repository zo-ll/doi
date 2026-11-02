// Injected into each design iframe. The iframe is sandboxed without same-origin access,
// so this script talks to the app only through postMessage.
//
// Frame → app: doi:ready, doi:select { oid }, doi:clear, doi:rects { selected, hover, pins },
// doi:wheel { deltaY, x, y } (a pinch or Ctrl/⌘ + wheel), doi:key { key, down, shift, mod }.
// App → frame: doi:track { oid, pins } names the selected element (or null) and the elements
// with open comments; doi:vars { vars } sets CSS variables on the page for a live tweak
// (a null value removes one); doi:style { oid, style } shows a canvas edit on the element
// before it is saved (style null takes the preview away); doi:move { oid, target, position }
// moves the element next to a sibling, until the page loads again.
// Rects are in the coordinates of this frame's viewport. doi:rects has the `layout` of the
// selected element: its parent's layout, its margins and box extras, and its siblings.
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

  const MAX_SIBLINGS = 200;
  const px = (v) => Number.parseFloat(v) || 0;
  /** What a canvas edit of the element needs: how its parent lays it out, and where the siblings are. */
  const layoutOf = (el) => {
    const parent = el.parentElement;
    const ps = parent ? getComputedStyle(parent) : null;
    const display = ps?.display ?? "block";
    const kind = display.endsWith("flex") ? "flex" : display.endsWith("grid") ? "grid" : "flow";
    const direction = kind === "flex" && ps.flexDirection.startsWith("column") ? "column" : kind === "flex" ? "row" : kind === "grid" ? "grid" : "column";
    const cs = getComputedStyle(el);
    const content = cs.boxSizing !== "border-box";
    const siblings = [];
    let index = 0; // the siblings before the element, in DOM order
    for (const child of parent?.children ?? []) {
      if (child === el) index = siblings.length;
      if (child === el || !child.hasAttribute("data-oid") || siblings.length >= MAX_SIBLINGS) continue;
      const rect = rectOf(child);
      if (rect) siblings.push({ oid: child.getAttribute("data-oid"), rect });
    }
    return {
      kind,
      direction,
      margins: { top: px(cs.marginTop), right: px(cs.marginRight), bottom: px(cs.marginBottom), left: px(cs.marginLeft) },
      // Padding and border that a CSS width or height does not count (content-box).
      extra: content
        ? { x: px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth), y: px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) }
        : { x: 0, y: 0 },
      siblings,
      index,
    };
  };

  // Sends the rects when they changed. Runs on each animation frame while something is shown,
  // so the overlay follows scrolling, resizing, layout changes and animations.
  let scheduled = false;
  const report = () => {
    scheduled = false;
    const hoverOid = hovered?.getAttribute("data-oid") ?? null;
    const selected = find(selectedOid);
    const selectedRect = rectOf(selected);
    const message = {
      type: "doi:rects",
      selected: selectedRect,
      layout: selectedRect ? layoutOf(selected) : null,
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

  // The iframe has the keyboard focus after a click, so the app does not see these keys.
  // Canvas keys (zoom, pan, tools) and the app's own shortcuts go to the app too, except
  // while the user types in a field of the page.
  const CANVAS_KEYS = new Set([" ", "=", "+", "-", "0", "!", "1", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "v", "c", "h", "f", "n", "t"]);
  const APP_KEYS = new Set(["p", "[", "]", "d", "e", ",", "z"]);
  const typing = (t) => t instanceof Element && (t.closest("input, textarea, select, [contenteditable]") !== null);
  const onKey = (event, down) => {
    if (down && event.key === "Escape") send({ type: "doi:clear" });
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const forward = mod ? APP_KEYS.has(key) || (event.shiftKey && key === "h") : CANVAS_KEYS.has(key);
    if (!forward || typing(event.target)) return;
    if (event.key === " " || mod) event.preventDefault(); // no page scroll, no browser shortcut (print)
    send({ type: "doi:key", key: event.key, down, shift: event.shiftKey, mod });
  };
  document.addEventListener("keydown", (event) => onKey(event, true));
  document.addEventListener("keyup", (event) => onKey(event, false));

  // A pinch on a trackpad comes as a wheel event with ctrlKey. It zooms the canvas, not the page.
  addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      send({ type: "doi:wheel", deltaY: event.deltaY, x: event.clientX, y: event.clientY });
    },
    { passive: false },
  );

  // A file dropped on a frame must not replace the page (the browser opens it). The page's own
  // drop zones run first; this frame cannot hand the file to the app, so a .zip does not import here.
  const blockFileDrop = (event) => {
    if (event.defaultPrevented || !event.dataTransfer || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (event.type === "dragover") event.dataTransfer.dropEffect = "none";
  };
  addEventListener("dragover", blockFileDrop);
  addEventListener("drop", blockFileDrop);

  // A canvas edit before it is saved: inline styles on the element, with the old ones kept.
  const STYLE_PROPS = new Set(["width", "height", "margin-top", "margin-right", "margin-bottom", "margin-left", "align-self", "justify-self"]);
  let previewed = null; // { el, old: { prop: [value, priority] } }
  const preview = (oid, style) => {
    if (previewed) {
      for (const [prop, [value, priority]] of Object.entries(previewed.old)) {
        if (value) previewed.el.style.setProperty(prop, value, priority);
        else previewed.el.style.removeProperty(prop);
      }
      previewed = null;
    }
    const el = find(oid);
    if (style && el) {
      previewed = { el, old: {} };
      for (const [prop, value] of Object.entries(style)) {
        if (!STYLE_PROPS.has(prop) || (value !== null && (typeof value !== "string" || value.length > 100))) continue;
        previewed.old[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
        // Important, so the preview shows over the page's own rules, as the saved rule should.
        if (value === null) el.style.removeProperty(prop);
        else el.style.setProperty(prop, value, "important");
      }
    }
    schedule();
  };

  const VAR = /^--[A-Za-z0-9_-]{1,60}$/;
  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const d = event.data;
    if (d?.type === "doi:vars" && d.vars && typeof d.vars === "object") {
      for (const [name, value] of Object.entries(d.vars)) {
        if (!VAR.test(name)) continue;
        if (value === null) document.documentElement.style.removeProperty(name);
        else if (typeof value === "string" && value.length <= 200) document.documentElement.style.setProperty(name, value);
      }
      schedule(); // the boxes move when sizes change
      return;
    }
    if (d?.type === "doi:style" && typeof d.oid === "string") {
      preview(d.oid, d.style && typeof d.style === "object" ? d.style : null);
      return;
    }
    if (d?.type === "doi:move" && typeof d.oid === "string" && typeof d.target === "string") {
      const el = find(d.oid);
      const target = find(d.target);
      if (el && target && el !== target && el.parentElement === target.parentElement) {
        target.insertAdjacentElement(d.position === "after" ? "afterend" : "beforebegin", el);
        schedule();
      }
      return;
    }
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
