function run(argv) {
    ObjC.import('CoreGraphics');
    const p = JSON.parse(argv[0]);
    // CGEventType and CGMouseButton values (CGEventTypes.h).
    const kinds = { left: [1, 2, 6, 0], right: [3, 4, 7, 1], middle: [25, 26, 27, 2] }[p.button || 'left'];
    const post = (type, x, y, clicks) => {
      const e = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), kinds[3]);
      if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); // kCGMouseEventClickState
      $.CGEventPost(0, e); // kCGHIDEventTap
    };
    const pause = (s) => delay(s);
    post(5, p.x, p.y, 0); // move there first, so hover state and the click target agree
    if (p.kind === 'move') return 'null';
    if (p.kind === 'click') {
      const count = Math.max(1, Math.min(3, p.count || 1));
      for (let i = 1; i <= count; i++) { post(kinds[0], p.x, p.y, i); post(kinds[1], p.x, p.y, i); if (i < count) pause(0.05); }
      return 'null';
    }
    post(kinds[0], p.x, p.y, 1);
    const steps = 12;
    for (let i = 1; i <= steps; i++) { pause(0.015); post(kinds[2], p.x + (p.to.x - p.x) * i / steps, p.y + (p.to.y - p.y) * i / steps, 1); }
    post(kinds[1], p.to.x, p.to.y, 1);
    return 'null';
  }