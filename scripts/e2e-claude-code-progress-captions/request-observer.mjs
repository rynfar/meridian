// Synchronous, observe-only Meridian Transform. No request field is changed.
// The gate installs this private callback before startProxyServer imports it.
export default {
  name: 'caption-native-gate-observer',
  version: '0.1.0',
  adapters: ['claude-code'],
  onRequest(context) {
    const observe = globalThis[Symbol.for('meridian.caption-native-gate.observe')];
    if (typeof observe !== 'function') throw new Error('caption observer absent');
    observe(context);
    return context;
  },
};
