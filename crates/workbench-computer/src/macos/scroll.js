function run(argv) {
    ObjC.import('CoreGraphics');
    const p = JSON.parse(argv[0]);
    $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 5, $.CGPointMake(p.x, p.y), 0));
    for (let i = 0; i < Math.max(Math.abs(p.dy), Math.abs(p.dx)); i++) {
      const e = $.CGEventCreateScrollWheelEvent2($(), 1, 2, i < Math.abs(p.dy) ? Math.sign(p.dy) : 0, i < Math.abs(p.dx) ? Math.sign(p.dx) : 0, 0);
      $.CGEventPost(0, e);
      delay(0.02);
    }
    return 'null';
  }