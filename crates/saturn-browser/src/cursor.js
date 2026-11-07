(() => {
  if (window.__saturnCursor) return;
  const make = () => {
    if (document.getElementById("__saturn_cursor")) return document.getElementById("__saturn_cursor");
    const cursor = document.createElement("div");
    cursor.id = "__saturn_cursor";
    cursor.setAttribute("aria-hidden", "true");
    // A black pointer with a white edge, and Saturn beside it, so whoever watches knows whose cursor it is.
    cursor.style.cssText = "position:fixed;left:0;top:0;width:40px;height:32px;z-index:2147483647;pointer-events:none;transition:transform .28s cubic-bezier(.2,.8,.2,1);transform:translate(-60px,-60px);";
    cursor.innerHTML = '<svg width="40" height="32" viewBox="0 0 40 32"><path d="M3 2l15 8-6.5 1.6L8.6 18z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><g transform="rotate(-18 28 22)"><ellipse cx="28" cy="22" rx="10" ry="3.2" fill="none" stroke="#fff" stroke-width="3"/><ellipse cx="28" cy="22" rx="10" ry="3.2" fill="none" stroke="#111" stroke-width="1.4"/><circle cx="28" cy="22" r="5.6" fill="#111" stroke="#fff" stroke-width="1.4"/><path d="M18 22a10 3.2 0 0 0 20 0" fill="none" stroke="#fff" stroke-width="3"/><path d="M18 22a10 3.2 0 0 0 20 0" fill="none" stroke="#111" stroke-width="1.4"/></g></svg>';
    (document.body || document.documentElement).appendChild(cursor);
    return cursor;
  };
  window.__saturnCursor = {
    move(x, y) { make().style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)"; },
    click(x, y) {
      this.move(x, y);
      const ring = document.createElement("div");
      ring.setAttribute("aria-hidden", "true");
      ring.style.cssText = "position:fixed;left:" + (x - 14) + "px;top:" + (y - 14) + "px;width:28px;height:28px;border-radius:50%;border:2px solid #4f8cff;z-index:2147483646;pointer-events:none;opacity:.9;transition:transform .45s ease-out,opacity .45s ease-out;";
      (document.body || document.documentElement).appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = "scale(1.8)"; ring.style.opacity = "0"; });
      setTimeout(() => ring.remove(), 500);
    },
  };
})();