function run() {
    ObjC.import('CoreGraphics');
    const b = $.CGDisplayBounds($.CGMainDisplayID());
    return JSON.stringify({ width: Math.round(b.size.width), height: Math.round(b.size.height) });
  }