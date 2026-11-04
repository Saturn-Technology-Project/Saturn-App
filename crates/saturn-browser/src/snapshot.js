
const limit = arguments[0];
const lines = [];
let next = 1;
document.querySelectorAll("[data-saturn-ref]").forEach((el) => el.removeAttribute("data-saturn-ref"));
const implicit = (el) => {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type))) return "button";
  if (tag === "input" && type === "checkbox") return "checkbox";
  if (tag === "input" && type === "radio") return "radio";
  if (tag === "input" && type === "search") return "searchbox";
  if (tag === "input" && type === "range") return "slider";
  if (tag === "input" && type !== "hidden") return "textbox";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return "image";
  if (tag === "summary") return "button";
  return "";
};
const visible = (el) => {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
};
const nameOf = (el) => {
  const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
  if (label) return label;
  if (el.id) { const forLabel = document.querySelector("label[for='" + CSS.escape(el.id) + "']"); if (forLabel) return forLabel.innerText; }
  if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return el.getAttribute("placeholder") || "";
  return (el.innerText || "").replace(/\s+/g, " ");
};
const walk = (el, depth) => {
  if (lines.length >= limit || el.id === "__saturn_cursor" || el.getAttribute("aria-hidden") === "true") return;
  if (!visible(el)) return;
  const role = el.getAttribute("role") || implicit(el);
  let shown = false;
  if (role) {
    const id = next++;
    el.setAttribute("data-saturn-ref", String(id));
    const parts = ["[" + id + "] " + role];
    const name = nameOf(el).trim();
    if (name) parts.push("name=" + JSON.stringify(name.slice(0, 120)));
    if ("value" in el && el.value !== undefined && el.value !== "" && role !== "button" && role !== "option") parts.push("value=" + JSON.stringify(String(el.value).slice(0, 120)));
    if (el.checked) parts.push("checked=true");
    if (el.disabled) parts.push("disabled=true");
    if (document.activeElement === el) parts.push("focused=true");
    lines.push("  ".repeat(Math.min(depth, 12)) + parts.join(" "));
    shown = true;
    if (["link", "button", "heading", "option"].includes(role)) return;
  } else {
    const own = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent.trim()).join(" ").trim();
    if (own && ["P", "LI", "TD", "TH", "SPAN", "DIV", "LABEL", "DT", "DD", "PRE", "CODE", "STRONG", "EM", "B"].includes(el.tagName)) {
      lines.push("  ".repeat(Math.min(depth, 12)) + "text " + JSON.stringify(own.slice(0, 160)));
    }
  }
  for (const child of el.children) walk(child, shown ? depth + 1 : depth);
};
if (document.body) walk(document.body, 0);
if (lines.length >= limit) lines.push("… (more elements; scroll or navigate to see the rest)");
return lines.join("\n") || "(empty page)";
