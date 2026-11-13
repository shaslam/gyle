// The Android app (android/) and the iOS app (ios/) show these same files in a web view and add
// an object called `GyleNative` for the things a web page cannot do there by itself: timer
// alerts while the app is closed, saving a file, printing, keeping the screen on and opening a
// link in the browser. In a browser there is no such object, `native` is null and nothing changes.
//
// What each app provides (Android: android/app/src/main/java/io/github/shaslam/gyle/Bridge.java,
// iOS: ios/bridge.js and ios/Gyle/Bridge.swift):
//   saveFile(name, mime, base64) -> '' or what went wrong     print(title)
//   setAlarms(json)   [{ key, at (ms), title, body }], replaces the list; the app shows each one when due
//   showAlert(key, title, body)   a notification now; a key already shown is not shown again
//   notifyStatus() -> 'granted' | 'denied' | 'default'        askToNotify()   answers with a 'gyle-notify' event
//   keepAwake(on)                                             openExternal(url)
//   platform   'ios' in the iOS app. The Android app does not set it.
export const native = window.GyleNative || null;

// The few places where the two apps differ test this. For example, iOS has no Downloads folder.
export const ios = native?.platform === 'ios';

// Sign-in links (email confirmation, password reset, GitHub or Google) come back to the app
// through this address. It must be in the Supabase project's list of redirect URLs.
export const APP_LINK = 'gyle://auth';
