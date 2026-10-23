// icit bridge content script: DOM-level tools. Injected on demand by background.js.
(() => {
  if (window.__icitInjected) return;
  window.__icitInjected = true;

  let refs = new Map(); // ref number -> element

  const INTERACTIVE =
    'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], ' +
    '[role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], ' +
    '[role="combobox"], [contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && clean(l.innerText)) return clean(l.innerText);
    }
    const parentLabel = el.closest("label");
    if (parentLabel && clean(parentLabel.innerText)) return clean(parentLabel.innerText);
    if (el.matches("input[type=submit], input[type=button]") && el.value) return clean(el.value);
    if (el.matches("img") && el.alt) return clean(el.alt);
    const text = clean(el.innerText || el.textContent);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    if (img) return clean(img.alt);
    return clean(el.title || el.placeholder || el.name || "");
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return `input[${el.type || "text"}]`;
    if (tag === "a") return "link";
    if (tag === "button" || el.getAttribute("role") === "button") return "button";
    if (el.isContentEditable) return "editable";
    const role = el.getAttribute("role");
    return role ? role : tag;
  }

  function describe(ref, el) {
    const kind = kindOf(el);
    const parts = [`[${ref}] ${kind}`];
    const label = trunc(labelOf(el), 80);
    if (label) parts.push(JSON.stringify(label));
    if (el.tagName === "A" && el.getAttribute("href")) parts.push(`href=${trunc(el.getAttribute("href"), 80)}`);
    if (el.name && !label.includes(el.name)) parts.push(`name=${el.name}`);
    if (el.placeholder) parts.push(`placeholder=${JSON.stringify(trunc(el.placeholder, 40))}`);
    if ("value" in el && el.tagName !== "BUTTON" && el.type !== "password" && el.value)
      parts.push(`value=${JSON.stringify(trunc(String(el.value), 60))}`);
    if (el.tagName === "SELECT") {
      const opts = [...el.options].slice(0, 12).map((o) => o.text);
      parts.push(`options=${JSON.stringify(opts)}`);
    }
    if (el.type === "checkbox" || el.type === "radio" || el.getAttribute("role") === "checkbox")
      parts.push(el.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    return parts.join(" ");
  }

  function snapshot({ maxChars = 6000, viewportOnly = false } = {}) {
    refs = new Map();
    const lines = [];
    let n = 0;
    const seen = new Set();
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (n >= 200) break;
      if (!isVisible(el)) continue;
      if (viewportOnly && !inViewport(el)) continue;
      // skip wrappers whose only purpose is to contain another interactive element
      if (el.matches("[tabindex]") && !el.matches("a, button, input, textarea, select, [role]") && el.querySelector(INTERACTIVE)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      n++;
      refs.set(n, el);
      lines.push(describe(n, el) + (inViewport(el) ? "" : " (offscreen)"));
    }
    const text = clean(document.body?.innerText || "");
    const scrollInfo = `scroll ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px`;
    return [
      `URL: ${location.href}`,
      `TITLE: ${document.title}`,
      `VIEWPORT: ${innerWidth}x${innerHeight}, ${scrollInfo}`,
      ``,
      `--- interactive elements (${n}) ---`,
      ...lines,
      ``,
      `--- visible text (${text.length} chars${text.length > maxChars ? ", truncated" : ""}) ---`,
      trunc(text, maxChars),
    ].join("\n");
  }

  function getRef(ref) {
    const el = refs.get(Number(ref));
    if (!el || !el.isConnected) throw new Error(`ref ${ref} not found; take a new page_snapshot`);
    return el;
  }

  function fire(el, type, init = {}) {
    const Ctor = type.startsWith("key") ? KeyboardEvent : type.startsWith("mouse") || type === "click" ? MouseEvent : Event;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  function click(ref) {
    const el = getRef(ref);
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const init = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    fire(el, "mousedown", init);
    fire(el, "mouseup", init);
    if (typeof el.focus === "function") el.focus();
    el.click();
    return { ok: true, clicked: describe(Number(ref), el) };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function type(ref, text, { append = false, submit = false } = {}) {
    const el = getRef(ref);
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      if (!append) el.textContent = "";
      document.execCommand("insertText", false, text) || (el.textContent += text);
      fire(el, "input", { inputType: "insertText", data: text });
    } else if ("value" in el) {
      const next = append ? String(el.value) + text : text;
      setNativeValue(el, next);
      fire(el, "input", { inputType: "insertText", data: text });
      fire(el, "change");
    } else {
      throw new Error(`ref ${ref} is not an editable element`);
    }
    if (submit) press("Enter", el);
    return { ok: true, value: el.isContentEditable ? clean(el.textContent) : el.value };
  }

  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, " ": 32 };
  function press(key, target) {
    const el = target || document.activeElement || document.body;
    const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: KEYCODES[key] || key.charCodeAt(0), which: KEYCODES[key] || key.charCodeAt(0) };
    const notCancelled = el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    el.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, ...init }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...init }));
    if (key === "Enter" && notCancelled) {
      const form = el.form || el.closest?.("form");
      if (form && el.tagName !== "TEXTAREA") {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      }
    }
    return { ok: true, key };
  }

  function scroll({ direction, amount }) {
    const step = amount || Math.round(innerHeight * 0.9);
    if (direction === "top") scrollTo({ top: 0 });
    else if (direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight });
    else scrollBy({ top: direction === "up" ? -step : step });
    return { ok: true, scrollY: Math.round(scrollY), maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
  }

  function read({ ref, maxChars = 20000 } = {}) {
    const el = ref != null ? getRef(ref) : document.body;
    const text = clean(el.innerText || el.textContent || "");
    return trunc(text, maxChars);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.icit) return;
    try {
      const a = msg.args || {};
      switch (msg.tool) {
        case "__ping":
          return sendResponse({ result: "pong" });
        case "page_snapshot":
          return sendResponse({ result: snapshot(a) });
        case "page_click":
          return sendResponse({ result: click(a.ref) });
        case "page_type":
          return sendResponse({ result: type(a.ref, String(a.text ?? ""), a) });
        case "page_press":
          return sendResponse({ result: press(String(a.key || "Enter")) });
        case "page_scroll":
          return sendResponse({ result: scroll(a) });
        case "page_read":
          return sendResponse({ result: read(a) });
        default:
          return sendResponse({ error: `unknown tool ${msg.tool}` });
      }
    } catch (e) {
      sendResponse({ error: String(e?.message || e) });
    }
  });
})();
