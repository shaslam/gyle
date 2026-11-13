package io.github.shaslam.gyle;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * The whole app is one screen: a WebView that shows the Gyle web files packed into the app.
 *
 * The files are served to the page from a made-up https address (the page needs http or https
 * for JavaScript modules, and one fixed address so its saved data stays with it). Requests to
 * that address never leave the phone. Everything else the page asks for goes to the network.
 */
public class MainActivity extends Activity {
    /** Reserved by Google for this purpose: no real site answers at this address. */
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/index.html";

    private static final int PICK_FILES = 1;
    static final int ASK_NOTIFY = 2;

    WebView web;
    /** True while the person is in the phone settings to allow notifications. */
    boolean awayToSettings;
    private ValueCallback<Uri[]> picking;
    private Uri cameraShot;

    /** JavaScript is on because the page is the app. The page comes from files inside the app only. */
    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // localStorage holds the working copy
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setBackgroundColor(getColor(R.color.wall));
        web.addJavascriptInterface(new Bridge(this), "GyleNative");
        web.setWebViewClient(new Pages());
        web.setWebChromeClient(new Chrome());
        layout();

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }

        String link = saved == null ? authLink(getIntent()) : null;
        if (link != null) web.loadUrl(START + link);
        else if (saved == null || web.restoreState(saved) == null) web.loadUrl(START);
    }

    /**
     * Green behind the status bar, the page in the middle, tan behind the navigation bar.
     * From Android 11 the app sizes these bands itself, so the page is never under a system
     * bar or the keyboard. On Android 10 the system does it and the theme sets the colours.
     */
    private void layout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.wall));
        View top = new View(this), bottom = new View(this);
        top.setBackgroundColor(getColor(R.color.green));
        bottom.setBackgroundColor(getColor(R.color.wall));
        root.addView(top, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(bottom, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
        setContentView(root);
        if (Build.VERSION.SDK_INT < 30) return;

        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarContrastEnforced(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets keys = insets.getInsets(WindowInsets.Type.ime());
            setHeight(top, bars.top);
            setHeight(bottom, Math.max(bars.bottom, keys.bottom));
            v.setPadding(bars.left, 0, bars.right, 0);
            return WindowInsets.CONSUMED;
        });
    }

    private static void setHeight(View v, int px) {
        ViewGroup.LayoutParams p = v.getLayoutParams();
        if (p.height == px) return;
        p.height = px;
        v.setLayoutParams(p);
    }

    // ---- sign-in links ----

    /** The part of a gyle://auth link that holds the session, as a page address ending. */
    private static String authLink(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u == null || !"gyle".equals(u.getScheme())) return null;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null; // an old link, already used
        String rest = u.getEncodedFragment();
        if (rest == null || rest.isEmpty()) rest = u.getEncodedQuery(); // some errors arrive after a ? instead
        return rest == null || rest.isEmpty() ? null : "#" + rest;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String link = authLink(intent);
        if (link != null && web != null) web.loadUrl(START + link); // the open page sees the address change and signs in
    }

    // ---- leaving and coming back ----

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out); // which screen was open
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (awayToSettings) { awayToSettings = false; tellPage("gyle-notify"); }
    }

    @Override
    protected void onDestroy() {
        if (picking != null) { picking.onReceiveValue(null); picking = null; }
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** Back closes a popup that is open in the page. Without one it goes to the screen before, and leaves the app from the first screen. */
    private void back() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript(CLOSE_POPUP, closed -> {
            if ("true".equals(closed) || web == null) return;
            if (web.canGoBack()) web.goBack(); else finish();
        });
    }

    /** Closes the popup on top, if there is one, and says whether it did. */
    private static final String CLOSE_POPUP = "(() => { const d = [...document.querySelectorAll('dialog[open]')].pop(); if (d) d.close(); return !!d; })()";

    /** Android 10 to 12 report Back this way. Later versions use the callback set in onCreate. */
    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        back();
    }

    /** Send an event to the page, for example after the answer about notifications. */
    void tellPage(String event) {
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('" + event + "'))", null);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == ASK_NOTIFY) tellPage("gyle-notify");
    }

    void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show();
        }
    }

    // ---- the page and its files ----

    private final class Pages extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!HOST.equals(u.getHost())) return null; // Supabase, ThingSpeak: the network
            String path = u.getPath();
            if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
            try {
                if (path.contains("..")) throw new IOException("not a file of the app");
                return new WebResourceResponse(mime(path), isText(path) ? "utf-8" : null, getAssets().open("www" + path));
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
            }
        }

        /** The page stays in the app. Any other address opens in the phone's browser. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openOutside(u);
            return true;
        }

        /** Android can stop the page's process to free memory. Start the screen again; the working copy is saved. */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (web != null) {
                ((ViewGroup) web.getParent()).removeView(web);
                web.destroy();
                web = null;
            }
            recreate();
            return true;
        }
    }

    private static boolean isText(String path) {
        return !path.endsWith(".woff2") && !path.endsWith(".png") && !path.endsWith(".jpg");
    }

    private static String mime(String path) {
        String ext = path.substring(path.lastIndexOf('.') + 1);
        switch (ext) {
            case "html": return "text/html";
            case "js": case "mjs": return "text/javascript"; // modules do not load with any other type
            case "css": return "text/css";
            case "json": return "application/json";
            case "svg": return "image/svg+xml";
            case "woff2": return "font/woff2";
            case "png": return "image/png";
            case "jpg": return "image/jpeg";
            default: return "text/plain";
        }
    }

    // ---- choosing files and taking photos ----

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (picking != null) picking.onReceiveValue(null);
            picking = callback;
            cameraShot = null;

            // The page asks for pictures (photos, pump clips) or for recipe files (BeerXML, BeerJSON, a backup zip).
            int named = 0, pictures = 0;
            for (String type : params.getAcceptTypes()) {
                if (type == null || type.isEmpty()) continue;
                named++;
                if (type.startsWith("image/")) pictures++;
            }
            boolean photos = named > 0 && pictures == named;

            Intent files = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType(photos ? "image/*" : "*/*");
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) files.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            Intent chooser = Intent.createChooser(files, null);
            if (photos) {
                cameraShot = CameraFiles.fresh(MainActivity.this);
                Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraShot);
                camera.setClipData(ClipData.newRawUri(null, cameraShot));
                camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { camera });
            }
            try {
                startActivityForResult(chooser, PICK_FILES);
            } catch (ActivityNotFoundException e) {
                picking = null;
                callback.onReceiveValue(null);
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILES) return;
        ValueCallback<Uri[]> callback = picking;
        Uri shot = cameraShot;
        picking = null;
        cameraShot = null;
        if (callback == null) return;

        List<Uri> chosen = new ArrayList<>();
        if (result == RESULT_OK) {
            ClipData many = data == null ? null : data.getClipData();
            if (many != null) for (int i = 0; i < many.getItemCount(); i++) chosen.add(many.getItemAt(i).getUri());
            else if (data != null && data.getData() != null) chosen.add(data.getData());
            else if (shot != null && CameraFiles.hasPicture(this, shot)) chosen.add(shot); // the camera wrote into our file
        }
        callback.onReceiveValue(chosen.isEmpty() ? null : chosen.toArray(new Uri[0]));
    }
}
