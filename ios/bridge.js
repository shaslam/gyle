// The iOS app runs this script in the page before the page's own code. It builds the object
// `GyleNative` that js/native.js describes, with the same methods as the Android app
// (android/.../Bridge.java). Keep the three files in step.
//
// A page in a WKWebView (the iOS component that shows a web page inside an app) can only post
// messages to the app. A posted message gets no answer in the same step. Two methods must answer
// at once (saveFile and notifyStatus), so they go through window.prompt(): the app receives the
// prompt, shows nothing, and gives its answer as the text that prompt() returns.
(() => {
  const send = (name, ...args) => { window.webkit.messageHandlers.gyle.postMessage({ name, args }); };
  const ask = (name, ...args) => window.prompt('gyle-native', JSON.stringify({ name, args })) || '';

  window.GyleNative = {
    platform: 'ios',
    saveFile: (name, mime, base64) => ask('saveFile', String(name), String(mime), String(base64)),
    notifyStatus: () => ask('notifyStatus'),
    print: title => send('print', String(title ?? '')),
    setAlarms: json => send('setAlarms', String(json)),
    showAlert: (key, title, body) => send('showAlert', String(key), String(title ?? ''), String(body ?? '')),
    askToNotify: () => send('askToNotify'),
    keepAwake: on => send('keepAwake', !!on),
    openExternal: url => send('openExternal', String(url)),
  };

  // The app draws the page down to the bottom edge of the screen. `viewport-fit=cover` makes
  // env(safe-area-inset-bottom) hold the height of the home bar, so the tab bar can keep clear
  // of it. `maximum-scale=1` stops iOS from zooming in when a field with small text gets the cursor.
  const fit = () => {
    const meta = document.querySelector('meta[name=viewport]');
    if (meta && !meta.content.includes('viewport-fit')) meta.content += ', viewport-fit=cover, maximum-scale=1';
    return !!meta;
  };
  if (!fit()) {
    const watch = new MutationObserver(() => { if (fit()) watch.disconnect(); });
    watch.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => { fit(); watch.disconnect(); });
  }
})();
