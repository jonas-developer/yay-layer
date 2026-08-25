'use strict';
// A recording stand-in for an EFFECT SURFACE (a canvas 2D context, a DOM node, a
// logger…). Every method call and property assignment on it is appended to a shared
// `trace`, so a spec can assert on WHAT a side-effecting function DID — e.g. which
// `fillStyle` was set before which `fillRect` — instead of a return value it doesn't
// have. Property READS return another recorder, so chains like `ctx.canvas.width`
// don't crash; used as a value a recorder coerces to 0 / ''.
//
// trace entries: { type:'call', name, args } | { type:'set', name, value }
function makeRecorder() {
  const trace = [];
  function node(prefix) {
    return new Proxy(function () {}, {
      get(_t, k) {
        if (k === '__trace') return trace;
        if (k === Symbol.toPrimitive) return () => 0;
        if (k === 'then') return undefined;            // not a thenable
        if (typeof k === 'symbol') return undefined;
        return node(prefix ? prefix + '.' + String(k) : String(k));
      },
      set(_t, k, v) { trace.push({ type: 'set', name: (prefix ? prefix + '.' : '') + String(k), value: v }); return true; },
      apply(_t, _this, args) { trace.push({ type: 'call', name: prefix || '(call)', args: args }); return node(prefix); },
      construct() { return node(prefix); },
      has() { return true; },
    });
  }
  return { proxy: node(''), trace };
}

module.exports = { makeRecorder };
