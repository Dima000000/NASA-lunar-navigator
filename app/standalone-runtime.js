/* Compatibility adapter for the PR's x-dc template. Keeps its DOM, styles and Component methods. */
class DCLogic {
  setState(patch, callback) {
    Object.assign(
      this.state,
      typeof patch === "function" ? patch(this.state) : patch,
    );
    if (callback) (this._callbacks ??= []).push(callback);
    this._schedule?.();
  }
}
window.DCLogic = DCLogic;
window.mountNASAL = (Component, root) => {
  const app = new Component();
  window.NASAL = app;
  let scope = {},
    pending = false,
    mounted = false;
  const read = (expr, s) => {
    const p = expr.trim();
    if (p === "true") return true;
    if (p === "false") return false;
    return p.split(".").reduce((v, k) => v?.[k], s);
  };
  const expression = (t) => t.replace(/^\s*\{\{\s*|\s*\}\}\s*$/g, "");
  const value = (t, s) => {
    const m = t.match(/^\s*\{\{(.*?)\}\}\s*$/);
    return m
      ? read(m[1], s)
      : t.replace(/\{\{(.*?)\}\}/g, (_, p) => read(p, s) ?? "");
  };
  function compile(node) {
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      if (!t.includes("{{")) return () => {};
      let last;
      return (s) => {
        const v = String(value(t, s) ?? "");
        if (v !== last) {
          node.nodeValue = v;
          last = v;
        }
      };
    }
    if (node.nodeType !== 1) return () => {};
    const tag = node.tagName.toLowerCase();
    if (tag === "sc-if" || tag === "sc-for") {
      const key = tag === "sc-if" ? "value" : "list",
        expr = expression(
          node.getAttribute("data-bind-" + key) || node.getAttribute(key),
        ),
        alias = node.getAttribute("as"),
        templates = [...node.childNodes].map((n) => n.cloneNode(true));
      const start = document.createComment(tag),
        end = document.createComment("/" + tag);
      node.replaceWith(start, end);
      let blocks = [];
      const drop = (b) => {
        b.update.dispose?.();
        for (let n = b.start.nextSibling; n && n !== b.end;) {
          const next = n.nextSibling;
          n.remove();
          n = next;
        }
        b.start.remove();
        b.end.remove();
      };
      const create = () => {
        const a = document.createComment("item"),
          b = document.createComment("/item");
        end.before(a, b);
        const frag = document.createDocumentFragment();
        templates.forEach((n) => frag.append(n.cloneNode(true)));
        b.before(frag);
        const up = [];
        for (let n = a.nextSibling; n && n !== b;) {
          const next = n.nextSibling;
          up.push(compile(n));
          n = next;
        }
        const update = (s) => up.forEach((f) => f(s));
        update.dispose = () => up.forEach((f) => f.dispose?.());
        return { start: a, end: b, update };
      };
      const update = (s) => {
        const result = read(expr, s),
          items = tag === "sc-if" ? (result ? [s] : []) : result || [];
        while (blocks.length > items.length) drop(blocks.pop());
        while (blocks.length < items.length) blocks.push(create());
        blocks.forEach((b, i) =>
          b.update(
            tag === "sc-if"
              ? s
              : Object.assign(Object.create(s), { [alias]: items[i] }),
          ),
        );
      };
      update.dispose = () => blocks.forEach(drop);
      return update;
    }
    const attrs = [...node.attributes]
        .filter((a) => a.value.includes("{{"))
        .map((a) => ({
          name: (()=>{const name=a.name.replace(/^data-bind-/, "");return node.namespaceURI==="http://www.w3.org/2000/svg"&&name==="viewbox"?"viewBox":name;})(),
          value: a.value,
        })),
      children = [...node.childNodes].map(compile),
      clean = [];
    let currentScope, lastRef;
    for (const a of attrs) {
      if (/^on/i.test(a.name)) {
        const event = a.name.slice(2).toLowerCase(),
          actual =
            event === "change" &&
            node.tagName === "INPUT" &&
            node.type === "range"
              ? "input"
              : event;
        const handler = (e) => {
          const f = value(a.value, currentScope);
          if (typeof f === "function") f(e);
        };
        node.removeAttribute(a.name);
        node.addEventListener(actual, handler);
        clean.push(() => node.removeEventListener(actual, handler));
      }
    }
    const update = (s) => {
      currentScope = s;
      for (const a of attrs) {
        if (/^on/i.test(a.name)) continue;
        const v = value(a.value, s);
        if (a.name === "ref") {
          if (v !== lastRef) {
            lastRef?.(null);
            lastRef = v;
            if (typeof v === "function") v(node);
          }
          continue;
        }
        if (
          a.name === "disabled" ||
          a.name === "checked" ||
          a.name === "selected"
        ) {
          node[a.name] = !!v;
          if (v) node.setAttribute(a.name, "");
          else node.removeAttribute(a.name);
        } else if (a.name === "value") {
          if (!(node.hasAttribute("data-preserve-editing")&&document.activeElement===node)&&node.value !== String(v ?? "")) node.value = String(v ?? "");
        } else {
          const str = String(v ?? "");
          if (node.getAttribute(a.name) !== str) node.setAttribute(a.name, str);
        }
      }
      children.forEach((f) => f(s));
    };
    update.dispose = () => {
      lastRef?.(null);
      clean.forEach((f) => f());
      children.forEach((f) => f.dispose?.());
    };
    return update;
  }
  const update = compile(root);
  const render = () => {
    pending = false;
    try {
      scope = app.renderVals();
      update(scope);
      if (mounted) app.componentDidUpdate?.();
      const callbacks = app._callbacks || [];
      app._callbacks = [];
      callbacks.forEach((f) => f());
    } catch (e) {
      console.error("NASAL render:", e);
      window.NASALRuntimeError = e.message;
    }
  };
  app._schedule = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(render);
    }
  };
  render();
  if (!root.isConnected) document.body.prepend(root);
  mounted = true;
  app.componentDidMount?.();
  app._schedule();
  window.addEventListener(
    "beforeunload",
    () => {
      app.componentWillUnmount?.();
      update.dispose?.();
    },
    { once: true },
  );
  return app;
};
