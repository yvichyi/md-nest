package dev.vinylfield.player;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;

import androidx.annotation.NonNull;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.webkit.WebViewAssetLoader;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.JSONObject;

/** Native entrypoint: a local, offline-capable UI backed by Android Media3. */
public final class MainActivity extends Activity {
    private static final int PICK_AUDIO = 42;
    private WebView web;
    private MediaController controller;
    private ListenableFuture<MediaController> controllerFuture;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean uiReady;
    private boolean endedSent;
    private NeteaseBridge network;
    private int chromeColour = Color.rgb(241, 233, 226);

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(chromeColour);
        getWindow().setNavigationBarColor(chromeColour);
        web = new WebView(this);
        web.setBackgroundColor(chromeColour);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setDefaultTextEncodingName("UTF-8");
        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView w, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest req) {
                String u = req.getUrl().toString();
                return !u.startsWith("https://appassets.androidplatform.net/assets/");
            }
            @Override public void onPageFinished(WebView w, String url) {
                uiReady = true;
                emitState();
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        network = new NeteaseBridge(this);
        web.addJavascriptInterface(network, "Netease");
        web.addJavascriptInterface(new PlayerBridge(), "Vinyl");
        setContentView(web);
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
        connectMedia();
        applySystemUi();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 12);
        }
    }

    private void connectMedia() {
        SessionToken token = new SessionToken(this,
                new android.content.ComponentName(this, PlaybackService.class));
        controllerFuture = new MediaController.Builder(this, token).buildAsync();
        controllerFuture.addListener(() -> {
            try {
                controller = controllerFuture.get();
                controller.addListener(new Player.Listener() {
                    @Override public void onEvents(Player player, Player.Events events) {
                        emitState();
                        if (player.getPlaybackState() == Player.STATE_ENDED && !endedSent) {
                            endedSent = true;
                            evaluate("window.VF && VF.onNativeEnded && VF.onNativeEnded()");
                        }
                        if (player.getPlaybackState() != Player.STATE_ENDED) endedSent = false;
                    }
                    @Override public void onPlayerError(androidx.media3.common.PlaybackException error) {
                        evaluate("window.VF && VF.onNativeError(" + JSONObject.quote(error.getMessage()) + ")");
                    }
                });
                emitState();
            } catch (Exception ex) { evaluate("window.VF && VF.onNativeError('无法连接系统播放器')"); }
        }, command -> main.post(command));
        main.post(progressTicker);
    }

    private final Runnable progressTicker = new Runnable() {
        @Override public void run() {
            emitState();
            main.postDelayed(this, 700);
        }
    };

    void evaluate(String js) {
        main.post(() -> { if (web != null && uiReady) web.evaluateJavascript(js, null); });
    }

    private void emitState() {
        if (controller == null || !uiReady) return;
        JSONObject state = new JSONObject();
        try {
            state.put("playing", controller.isPlaying());
            state.put("buffering", controller.getPlaybackState() == Player.STATE_BUFFERING);
            state.put("position", Math.max(0, controller.getCurrentPosition()));
            state.put("duration", Math.max(0, controller.getDuration()));
            state.put("hasItem", controller.getCurrentMediaItem() != null);
        } catch (Exception ignore) { return; }
        evaluate("window.VF && VF.onNativeState(" + state.toString() + ")");
    }

    private void applySystemUi() {
        boolean landscape = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        int flags = landscape
                ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                  | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                  | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                : View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        if (!landscape && android.graphics.Color.luminance(chromeColour) > 0.55) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    @Override public void onConfigurationChanged(@NonNull Configuration cfg) {
        super.onConfigurationChanged(cfg);
        applySystemUi();
        evaluate("window.VF && VF.onOrientationChange(" + (cfg.orientation == Configuration.ORIENTATION_LANDSCAPE) + ")");
    }

    @Override public void onBackPressed() {
        if (web != null) {
            evaluate("window.VF && VF.closeOverlay()");
        } else super.onBackPressed();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_AUDIO && resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
            catch (SecurityException ignored) { }
            String title = "本地音频";
            try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) title = c.getString(0);
            } catch (Exception ignored) { }
            evaluate("window.VF && VF.addLocalTrack(" + JSONObject.quote(uri.toString()) + "," + JSONObject.quote(title) + ")");
        }
    }

    @Override protected void onDestroy() {
        main.removeCallbacks(progressTicker);
        if (controllerFuture != null) MediaController.releaseFuture(controllerFuture);
        controller = null;
        if (network != null) network.shutdown();
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    private final class PlayerBridge {
        /** Sync Android system bars with the album-derived background. */
        @JavascriptInterface public void setChromeColour(String hex) {
            if (hex == null || !hex.matches("#[0-9a-fA-F]{6}")) return;
            main.post(() -> {
                try {
                    chromeColour = Color.parseColor(hex);
                    getWindow().setStatusBarColor(chromeColour);
                    getWindow().setNavigationBarColor(chromeColour);
                    web.setBackgroundColor(chromeColour);
                    applySystemUi();
                } catch (IllegalArgumentException ignored) { }
            });
        }
        @JavascriptInterface public void play(String url, String title, String artist, String artwork, String id) {
            main.post(() -> {
                if (controller == null) { evaluate("VF.onNativeError('播放器正在初始化')"); return; }
                try {
                    Uri uri = Uri.parse(url);
                    String scheme = uri.getScheme();
                    if (!"https".equalsIgnoreCase(scheme) && !"content".equalsIgnoreCase(scheme))
                        throw new IllegalArgumentException("不支持的音频来源");
                    MediaMetadata.Builder meta = new MediaMetadata.Builder()
                            .setTitle(title).setArtist(artist);
                    if (artwork != null && artwork.startsWith("https://"))
                        meta.setArtworkUri(Uri.parse(artwork));
                    MediaItem item = new MediaItem.Builder().setUri(uri).setMediaId(id)
                            .setMediaMetadata(meta.build()).build();
                    endedSent = false;
                    controller.setMediaItem(item);
                    controller.prepare();
                    controller.play();
                    emitState();
                } catch (Exception e) {
                    evaluate("VF.onNativeError(" + JSONObject.quote(e.getMessage()) + ")");
                }
            });
        }
        @JavascriptInterface public void pause() {
            main.post(() -> { if (controller != null) controller.pause(); });
        }
        @JavascriptInterface public void resume() {
            main.post(() -> { if (controller != null) controller.play(); });
        }
        @JavascriptInterface public void seek(long millis) {
            main.post(() -> { if (controller != null) controller.seekTo(Math.max(0, millis)); });
        }
        @JavascriptInterface public void landscape() {
            main.post(() -> setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE));
        }
        @JavascriptInterface public void portrait() {
            main.post(() -> setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
        }
        @JavascriptInterface public void pickAudio() {
            main.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("audio/*");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(i, PICK_AUDIO);
            });
        }
    }
}
