function run(argv) {
    const p = JSON.parse(argv[0]);
    const started = Date.now();
    const late = () => Date.now() - started > p.budget;
    const proc = Application('System Events').processes.whose({ unixId: p.pid })[0];
    if (!proc.windows().length) throw new Error('The app has no open window');
    const pick = (proc) => { const all = proc.windows(); for (let i = 0; i < all.length; i++) { try { if (all[i].name() !== 'Saturn pointer') return proc.windows[i]; } catch (e) { return proc.windows[i]; } } return proc.windows[0]; };
    let root = pick(proc);
    for (const i of p.root) root = root.uiElements[i];
    const settableRoles = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXSecureTextField', 'AXSlider', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton'];
    const safe = (f, fallback) => { try { const v = f(); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; } };
    const text = (v) => typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '';
    const out = [];
    let truncated = false;
    const add = (parent, i, role, name, title, desc, value, actions) => {
      const node = { path: parent.path.concat([i]), depth: parent.depth + 1, role: role || 'AXUnknown',
        name: text(name) || text(title) || text(desc), value: text(value).slice(0, 200),
        actions: (actions || []).filter((a) => a !== 'AXPress' && a !== 'AXShowDefaultUI'),
        settable: settableRoles.indexOf(role) >= 0, omitted: 0 };
      out.push(node);
      return node;
    };
    let level = [{ el: root, path: p.root, depth: 0, node: null }];
    while (level.length && out.length < p.limit && !truncated) {
      const next = [];
      for (const parent of level) {
        if (out.length >= p.limit || parent.depth >= p.depth) break;
        if (late()) { truncated = true; break; }
        const kids = parent.el.uiElements;
        const count = safe(() => kids.length, 0);
        if (!count) continue;
        if (count > p.wide) {
          if (parent.node) { parent.node.omitted += count; continue; }
          // The element being expanded is itself huge: its first children, one at a time, within the budget.
          for (let i = 0; i < Math.min(count, p.wide); i++) {
            if (out.length >= p.limit || late()) { truncated = true; break; }
            const kid = kids[i];
            const node = add(parent, i, safe(() => kid.role(), ''), safe(() => kid.name(), ''), safe(() => kid.title(), ''), safe(() => kid.description(), ''), safe(() => kid.value(), ''), safe(() => kid.actions.name(), []));
            next.push({ el: kid, path: node.path, depth: node.depth, node });
          }
          if (out.length) out[out.length - 1].omitted += Math.max(0, count - p.wide);
          continue;
        }
        const roles = safe(() => kids.role(), []);
        if (!roles.length) continue;
        const names = safe(() => kids.name(), []), descs = safe(() => kids.description(), []), titles = safe(() => kids.title(), []);
        const values = safe(() => kids.value(), []), actions = safe(() => kids.actions.name(), []);
        for (let i = 0; i < roles.length; i++) {
          if (out.length >= p.limit) { out[out.length - 1].omitted += roles.length - i; break; }
          const node = add(parent, i, roles[i], names[i], titles[i], descs[i], values[i], actions[i]);
          next.push({ el: kids[i], path: node.path, depth: node.depth, node });
        }
      }
      level = next;
    }
    return JSON.stringify({ nodes: out, truncated });
  }