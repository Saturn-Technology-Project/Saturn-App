(() => {
  if (window.__saturnCursor) return;
  const make = () => {
    if (document.getElementById("__saturn_cursor")) return document.getElementById("__saturn_cursor");
    const cursor = document.createElement("div");
    cursor.id = "__saturn_cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .28s cubic-bezier(.2,.8,.2,1);transform:translate(-40px,-40px);";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-6.5 1.6L8.6 18z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
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