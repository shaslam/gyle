package io.github.shaslam.gyle;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import java.io.OutputStream;

/**
 * What the page can ask the app to do. The page sees this object as `GyleNative` (js/native.js
 * lists the same methods). Android calls these methods on a background thread, so anything that
 * touches the screen is passed to the main thread.
 */
final class Bridge {
    private final MainActivity app;

    Bridge(MainActivity app) {
        this.app = app;
    }

    /** Put a file in the phone's Downloads folder. Returns "" when saved, or what went wrong. */
    @JavascriptInterface
    public String saveFile(String name, String mime, String base64) {
        ContentResolver files = app.getContentResolver();
        ContentValues about = new ContentValues();
        about.put(MediaStore.Downloads.DISPLAY_NAME, name.replaceAll("[/\\\\]", "-"));
        about.put(MediaStore.Downloads.MIME_TYPE, mime);
        about.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = null;
        try {
            uri = files.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, about);
            if (uri == null) throw new IllegalStateException("no place to write to");
            try (OutputStream out = files.openOutputStream(uri)) {
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            about.clear();
            about.put(MediaStore.Downloads.IS_PENDING, 0);
            files.update(uri, about, null, null);
        } catch (Exception e) {
            if (uri != null) files.delete(uri, null, null);
            return app.getString(R.string.saved_failed, String.valueOf(e.getMessage()));
        }
        if ("application/pdf".equals(mime)) show(uri, mime); // a brew sheet: open it straight away
        return "";
    }

    private void show(Uri uri, String mime) {
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        app.runOnUiThread(() -> {
            try {
                app.startActivity(view);
            } catch (ActivityNotFoundException e) {
                // No PDF viewer. The file is in Downloads and the page says so.
            }
        });
    }

    /** Print the page that is open (the brew sheet), on A4. */
    @JavascriptInterface
    public void print(String title) {
        app.runOnUiThread(() -> {
            if (app.web == null) return;
            PrintManager printer = (PrintManager) app.getSystemService(Context.PRINT_SERVICE);
            PrintAttributes a4 = new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build();
            printer.print(title, app.web.createPrintDocumentAdapter(title), a4);
        });
    }

    /** The timer alerts still to come: [{ key, at, title, body }]. Replaces the list from before. */
    @JavascriptInterface
    public void setAlarms(String json) {
        Alarms.set(app, json);
    }

    /** Show a timer alert now, unless an alert with this key was shown already. */
    @JavascriptInterface
    public void showAlert(String key, String title, String body) {
        Alarms.show(app, key, title, body);
    }

    /** "granted", "denied", or "default" when the person was not asked yet. */
    @JavascriptInterface
    public String notifyStatus() {
        if (!mayNotify()) return prefs().getBoolean("asked", false) ? "denied" : "default";
        return app.getSystemService(NotificationManager.class).areNotificationsEnabled() ? "granted" : "denied";
    }

    /**
     * Ask to show notifications. Android shows its question at most two times. After that, and on
     * Android 12 and earlier, the only way is the app's page in the phone settings, so open that.
     * The page gets a "gyle-notify" event when there is an answer.
     */
    @JavascriptInterface
    @SuppressLint("InlinedApi") // the permission's name is only used on Android 13 and later
    public void askToNotify() {
        app.runOnUiThread(() -> {
            boolean asked = prefs().getBoolean("asked", false);
            if (!mayNotify() && (!asked || app.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
                prefs().edit().putBoolean("asked", true).apply();
                app.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, MainActivity.ASK_NOTIFY);
                return;
            }
            app.awayToSettings = true;
            try {
                app.startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, app.getPackageName()));
            } catch (ActivityNotFoundException e) {
                app.awayToSettings = false;
            }
        });
    }

    /** Keep the screen on while the timer runs. */
    @JavascriptInterface
    public void keepAwake(boolean on) {
        app.runOnUiThread(() -> {
            if (on) app.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else app.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    /** Open a web address in the phone's browser (sign-in with GitHub or Google). */
    @JavascriptInterface
    public void openExternal(String url) {
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme())) return;
        app.runOnUiThread(() -> app.openOutside(uri));
    }

    /** Before Android 13 an app needs no permission to notify. */
    private boolean mayNotify() {
        return Build.VERSION.SDK_INT < 33 || app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private SharedPreferences prefs() {
        return app.getSharedPreferences("app", Context.MODE_PRIVATE);
    }
}
