function run(argv) {
    const p = JSON.parse(argv[0]);
    const proc = Application('System Events').processes.whose({ unixId: p.pid })[0];
    const windows = proc.windows();
    if (!windows.length) throw new Error('The app has no open window');
    const position = windows[0].position(), size = windows[0].size();
    return JSON.stringify({ x: position[0], y: position[1], width: size[0], height: size[1] });
  }