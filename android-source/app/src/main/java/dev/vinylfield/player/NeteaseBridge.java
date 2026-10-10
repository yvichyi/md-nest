package dev.vinylfield.player;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import org.json.JSONObject;
import okhttp3.RequestBody;
import java.util.LinkedHashMap;
import java.util.Map;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import okhttp3.FormBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Narrow HTTPS bridge to NetEase API; session cookies stay in Android Keystore storage. */
public final class NeteaseBridge {
    private static final String KEY_ALIAS = "vinylfield_netease_session";
    private static final String PREFS = "vf_credentials";
    private final MainActivity activity;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();
    private final OkHttpClient client = new OkHttpClient.Builder().followRedirects(true).build();

    NeteaseBridge(MainActivity activity) { this.activity = activity; }

    // A very small, explicit facade. These are app routes, never upstream URLs.
    private static final java.util.Set<String> ALLOWED = new java.util.HashSet<>(java.util.Arrays.asList(
        "/api/login/qr/key", "/api/login/qr/create", "/api/login/qr/check",
        "/api/search/get", "/api/song/detail", "/api/lyric",
        "/api/song/enhance/player/url", "/api/user/account",
        "/api/user/playlist", "/api/playlist/detail"));

    @JavascriptInterface public void post(String requestId, String path, String jsonParams) {
        if (!ALLOWED.contains(path)) {
            deliver(requestId, false, "{\"message\":\"Unsupported API route\"}");
            return;
        }
        executor.execute(() -> {
            try {
                JSONObject p = new JSONObject(jsonParams);
                if ("/api/login/qr/create".equals(path)) {
                    String key = p.optString("key", "");
                    if (key.isEmpty() || key.length() > 128 || !key.matches("[A-Za-z0-9_-]+"))
                        throw new IOException("Invalid QR key");
                    String url = "https://music.163.com/login?codekey=" + key;
                    JSONObject data = new JSONObject().put("qrurl", url).put("qrimg", qrImage(url));
                    deliver(requestId, true, new JSONObject().put("code", 200).put("data", data).toString());
                    return;
                }

                String upstream = path;
                boolean weapi = false;
                JSONObject body = new JSONObject();
                switch (path) {
                    case "/api/login/qr/key":
                        upstream = "/api/login/qrcode/unikey";
                        body.put("type", 3); weapi = true;
                        break;
                    case "/api/login/qr/check":
                        upstream = "/api/login/qrcode/client/login";
                        body.put("key", p.getString("key")); body.put("type", 3);
                        weapi = true; break;
                    case "/api/lyric":
                        upstream = "/api/song/lyric";
                        body.put("id", p.getString("id"));
                        body.put("lv", -1); body.put("tv", -1); body.put("rv", -1);
                        body.put("kv", -1); break;
                    case "/api/song/detail":
                        upstream = "/api/v3/song/detail";
                        org.json.JSONArray ids = new org.json.JSONArray();
                        for (String id : p.getString("ids").split(",")) {
                            if (!id.matches("[0-9]{1,20}")) throw new IOException("Invalid song ID");
                            ids.put(new JSONObject().put("id", Long.parseLong(id)));
                        }
                        if (ids.length() == 0 || ids.length() > 50) throw new IOException("Too many song IDs");
                        body.put("c", ids.toString()); weapi = true; break;
                    case "/api/user/account":
                        upstream = "/api/nuser/account/get"; weapi = true; break;
                    case "/api/user/playlist":
                        body.put("uid", p.getString("uid"));
                        body.put("limit", p.optInt("limit", 50));
                        body.put("offset", p.optInt("offset", 0));
                        upstream = "/api/user/playlist"; weapi = true; break;
                    case "/api/playlist/detail":
                        upstream = "/api/v6/playlist/detail";
                        body.put("id", p.getString("id"));
                        body.put("n", 1000); body.put("s", 8); break;
                    default:
                        for (Iterator<String> it = p.keys(); it.hasNext();) {
                            String key = it.next(); body.put(key, p.get(key));
                        }
                }
                FormBody.Builder plain = new FormBody.Builder();
                for (Iterator<String> it = body.keys(); it.hasNext();) {
                    String key = it.next(); plain.add(key, String.valueOf(body.get(key)));
                }
                String url = "https://music.163.com" + (weapi ? "/weapi/" + upstream.substring(5) : upstream);
                String storedCookie = readCookie();
                Request.Builder req = new Request.Builder().url(url)
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36")
                    .header("Referer", "https://music.163.com/")
                    .header("Origin", "https://music.163.com")
                    .header("Cookie", (storedCookie.isEmpty() ? "os=pc; appver=3.1.17" : storedCookie + "; os=pc; appver=3.1.17"))
                    .post(weapi ? NeteaseWeapi.encrypt(body.put("csrf_token", csrfFrom(storedCookie))) : plain.build());
                try (Response response = client.newCall(req.build()).execute()) {
                    ResponseBody responseBody = response.body();
                    String raw = responseBody == null ? "" : responseBody.string();
                    if (raw.length() > 4_000_000) throw new IOException("Response too large");
                    JSONObject result;
                    try { result = new JSONObject(raw); }
                    catch (Exception parse) { throw new IOException("API returned HTTP " + response.code() + " rather than JSON"); }
                    if ("/api/login/qr/key".equals(path)) {
                        // Official response: {code:200,unikey:"..."}; app facade: {data:{unikey}}.
                        if (!result.has("data")) {
                            JSONObject wrap = new JSONObject();
                            wrap.put("code", result.optInt("code", 200)); wrap.put("data", result);
                            result = wrap;
                        }
                    }
                    if ("/api/login/qr/check".equals(path) && result.optInt("code") == 803) {
                        // The login session is returned in Set-Cookie headers, NOT the JSON body.
                        String loginCookie = collectLoginCookie(response);
                        if (loginCookie.isEmpty()) loginCookie = result.optString("cookie", "");
                        boolean saved = loginCookie.contains("MUSIC_U=");
                        if (saved) writeCookie(loginCookie);
                        else result.put("message", "授权成功，但服务器未提供有效 MUSIC_U；请重试");
                        result.put("sessionSaved", saved);
                    }
                    result.remove("cookie"); // never transfer secret back to WebView
                    boolean ok = response.isSuccessful();
                    // Non-2xx API-level errors should surface clearly, not silently look empty.
                    int code = result.optInt("code", 200);
                    if (ok && code >= 400 && code != 800 && code != 801 && code != 802 && code != 803) {
                        if (!result.has("message")) result.put("message", "网易云接口返回错误 " + code);
                        ok = false;
                    }
                    deliver(requestId, ok, result.toString());
                }
            } catch (Exception e) {
                JSONObject error = new JSONObject();
                try { error.put("message", "网络或接口故障：" + e.getClass().getSimpleName() + " (" + e.getMessage() + ")"); }
                catch (Exception ignored) { }
                deliver(requestId, false, error.toString());
            }
        });
    }

    private static String csrfFrom(String cookie) {
        for (String part : cookie.split(";")) {
            String item = part.trim();
            if (item.startsWith("__csrf=")) return item.substring("__csrf=".length());
        }
        return "";
    }

    private static String collectLoginCookie(Response response) {
        Map<String,String> tokens = new LinkedHashMap<>();
        for (String setCookie : response.headers("Set-Cookie")) {
            String first = setCookie.split(";", 2)[0].trim();
            int sep = first.indexOf('=');
            if (sep < 1) continue;
            String key = first.substring(0, sep);
            // Persist session attributes only, never cookie directives.
            if (key.equals("MUSIC_U") || key.equals("__csrf") || key.equals("MUSIC_A") || key.equals("NMTID"))
                tokens.put(key, first.substring(sep + 1));
        }
        if (!tokens.containsKey("MUSIC_U")) return "";
        StringBuilder cookie = new StringBuilder();
        for (Map.Entry<String,String> entry : tokens.entrySet()) {
            if (cookie.length() > 0) cookie.append("; ");
            cookie.append(entry.getKey()).append('=').append(entry.getValue());
        }
        return cookie.toString();
    }

    @JavascriptInterface public boolean hasAccount() { return !readCookie().isEmpty(); }

    /** Explicit manual import for users whose official QR flow is blocked by endpoint changes. */
    @JavascriptInterface public boolean importCookie(String cookie) {
        if (cookie == null || cookie.length() > 8192 || !cookie.contains("MUSIC_U=")) return false;
        try { writeCookie(cookie); return true; }
        catch (Exception e) { return false; }
    }

    @JavascriptInterface public void logout() {
        activity.getSharedPreferences(PREFS, 0).edit().remove("cookie").apply();
    }

    @JavascriptInterface public String qrImage(String url) {
        if (url == null || !url.startsWith("https://music.163.com/login?codekey=")) return "";
        try {
            BitMatrix matrix = new QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, 320, 320);
            Bitmap bitmap = Bitmap.createBitmap(320, 320, Bitmap.Config.ARGB_8888);
            for (int y = 0; y < 320; ++y)
                for (int x = 0; x < 320; ++x)
                    bitmap.setPixel(x, y, matrix.get(x, y) ? Color.BLACK : Color.WHITE);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
            bitmap.recycle();
            return "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        } catch (Exception ignored) { return ""; }
    }

    /**
     * Artwork palette is sampled natively because remote artwork frequently lacks CORS headers.
     * Only the official NetEase cover CDN is permitted; no arbitrary URL fetches from JS.
     * This returns a colour, never the artwork bytes or account credentials.
     */
    @JavascriptInterface public void sampleArtwork(String requestId, String coverUrl) {
        artworkExecutor.execute(() -> {
            String colour = "";
            String coverData = "";
            try {
                URI uri = new URI(coverUrl);
                String host = uri.getHost();
                if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null ||
                    !host.toLowerCase(java.util.Locale.ROOT).matches("p[0-9]+\\.music\\.126\\.net") ||
                    uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) {
                    throw new IOException("Unsupported artwork host");
                }
                OkHttpClient imageClient = client.newBuilder()
                    .followRedirects(false)
                    .connectTimeout(7, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                    .build();
                Request request = new Request.Builder().url(uri.toASCIIString()).get().build();
                try (Response response = imageClient.newCall(request).execute()) {
                    if (!response.isSuccessful() || response.body() == null) throw new IOException("No artwork");
                    String ct = response.header("Content-Type", "");
                    if (!ct.toLowerCase(java.util.Locale.ROOT).startsWith("image/")) throw new IOException("Not an image");
                    try (InputStream stream = response.body().byteStream();
                         ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                        byte[] buffer = new byte[8192];
                        int size = 0, n;
                        while ((n = stream.read(buffer)) != -1) {
                            size += n;
                            if (size > 2_500_000) throw new IOException("Artwork too large");
                            out.write(buffer, 0, n);
                        }
                        byte[] bytes = out.toByteArray();
                        BitmapFactory.Options opts = new BitmapFactory.Options();
                        opts.inJustDecodeBounds = true;
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
                        if (opts.outWidth <= 0 || opts.outHeight <= 0 ||
                            opts.outWidth > 7000 || opts.outHeight > 7000) throw new IOException("Invalid artwork dimensions");
                        opts.inJustDecodeBounds = false;
                        opts.inSampleSize = Math.max(1, Integer.highestOneBit(Math.max(opts.outWidth, opts.outHeight) / 720));
                        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
                        if (bitmap == null) throw new IOException("Cannot decode artwork");
                        try {
                            colour = dominantArtworkColour(bitmap);
                            ByteArrayOutputStream encoded = new ByteArrayOutputStream();
                            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 86, encoded))
                                throw new IOException("Cover encode failed");
                            if (encoded.size() > 1_000_000) throw new IOException("Encoded cover too large");
                            coverData = "data:image/jpeg;base64," + Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP);
                        } finally { bitmap.recycle(); }
                    }
                }
            } catch (Exception ignored) { /* Browser has neutral fallback for inaccessible covers. */ }
            // Image bytes are only sent to the local WebView, without passing through a proxy.
            activity.evaluate("window.VF && VF.onArtworkAsset(" + JSONObject.quote(requestId) + "," +
                    JSONObject.quote(colour) + "," + JSONObject.quote(coverData) + ")");
        });
    }

    private static String dominantArtworkColour(Bitmap bitmap) {
        double[] population = new double[24], red = new double[24], green = new double[24], blue = new double[24];
        float[] hsv = new float[3];
        double greyR = 0, greyG = 0, greyB = 0, greyCount = 0;
        int stepX = Math.max(1, bitmap.getWidth() / 72), stepY = Math.max(1, bitmap.getHeight() / 72);
        for (int y = 0; y < bitmap.getHeight(); y += stepY) {
            for (int x = 0; x < bitmap.getWidth(); x += stepX) {
                int px = bitmap.getPixel(x,y);
                if (Color.alpha(px) < 192) continue;
                Color.colorToHSV(px, hsv);
                if (hsv[2] < .12f || hsv[2] > .98f) continue;
                greyR += Color.red(px); greyG += Color.green(px); greyB += Color.blue(px); greyCount++;
                if (hsv[1] < .17f) continue;
                int bucket = Math.min(23, (int)(hsv[0] / 15f));
                double weight = .65 + hsv[1] * .9;
                population[bucket] += weight;
                red[bucket] += Color.red(px) * weight;
                green[bucket] += Color.green(px) * weight;
                blue[bucket] += Color.blue(px) * weight;
            }
        }
        int best = 0;
        for (int i=1; i<24; i++) if (population[i] > population[best]) best=i;
        int r, g, b;
        if (population[best] > 0) {
            r = (int)(red[best]/population[best]);g = (int)(green[best]/population[best]);b = (int)(blue[best]/population[best]);
        } else if (greyCount > 0) {
            r=(int)(greyR/greyCount);g=(int)(greyG/greyCount);b=(int)(greyB/greyCount);
        } else { return ""; }
        return String.format(java.util.Locale.ROOT,"#%02x%02x%02x", r,g,b);
    }

    private void deliver(String id, boolean success, String rawJson) {
        activity.evaluate("window.VF && VF.onNetwork(" + JSONObject.quote(id) + "," + success + "," + JSONObject.quote(rawJson) + ")");
    }

    private SecretKey getKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry found = store.getEntry(KEY_ALIAS, null);
        if (found instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) found).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private synchronized void writeCookie(String cookie) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getKey());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(cookie.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(encrypted, 0, combined, iv.length, encrypted.length);
        activity.getSharedPreferences(PREFS, 0).edit()
                .putString("cookie", Base64.encodeToString(combined, Base64.NO_WRAP)).apply();
    }

    private synchronized String readCookie() {
        String saved = activity.getSharedPreferences(PREFS, 0).getString("cookie", "");
        if (saved == null || saved.isEmpty()) return "";
        try {
            byte[] combined = Base64.decode(saved, Base64.DEFAULT);
            byte[] iv = java.util.Arrays.copyOfRange(combined, 0, 12);
            byte[] ciphertext = java.util.Arrays.copyOfRange(combined, 12, combined.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception ignored) { return ""; }
    }

    void shutdown() { executor.shutdownNow(); artworkExecutor.shutdownNow(); }
}
