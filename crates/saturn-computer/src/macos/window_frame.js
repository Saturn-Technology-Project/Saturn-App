function run(argv) {
    const p = JSON.parse(argv[0]);
    const proc = Application('System Events').processes.whose({ unixId: p.pid })[0];
    const windows = proc.windows();
    if (!windows.length) throw new Error('The app has no open window');
    const pick = (proc) => { const all = proc.windows(); for (let i = 0; i < all.length; i++) { try { if (all[i].name() !== 'Saturn pointer') return proc.windows[i]; } catch (e) { return proc.windows[i]; } } return proc.windows[0]; };
    const front = pick(proc);
    const position = front.position(), size = front.size();
    return JSON.stringify({ x: position[0], y: position[1], width: size[0], height: size[1] });
  }