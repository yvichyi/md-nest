package dev.vinylfield.player;

import android.util.Base64;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.SecureRandom;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.FormBody;

/** NetEase web-client request encoding. The upstream routes, not the facade routes,
 * are the HTTP targets. This does not circumvent entitlement or DRM checks. */
final class NeteaseWeapi {
    private static final byte[] IV = "0102030405060708".getBytes(StandardCharsets.UTF_8);
    private static final String ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    private static final String PUBLIC_KEY =
        "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB";
    private static final SecureRandom RNG = new SecureRandom();

    private NeteaseWeapi() {}

    private static String aes(String plaintext, String key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE,
            new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"),
            new IvParameterSpec(IV));
        return Base64.encodeToString(cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    }

    static FormBody encrypt(JSONObject data) throws Exception {
        char[] random = new char[16];
        for (int i = 0; i < random.length; i++) random[i] = ALPHABET.charAt(RNG.nextInt(ALPHABET.length()));
        String secret = new String(random);
        String params = aes(aes(data.toString(), "0CoJUm6Qyw8W8jud"), secret);
        PublicKey key = KeyFactory.getInstance("RSA").generatePublic(
            new X509EncodedKeySpec(Base64.decode(PUBLIC_KEY, Base64.DEFAULT)));
        // WeAPI uses textbook RSA (no padding) of the reversed 16-byte secret.
        Cipher rsa = Cipher.getInstance("RSA/ECB/NoPadding");
        rsa.init(Cipher.ENCRYPT_MODE, key);
        byte[] encrypted = rsa.doFinal(new StringBuilder(secret).reverse().toString()
            .getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(encrypted.length * 2);
        for (byte value : encrypted) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return new FormBody.Builder().add("params", params).add("encSecKey", hex.toString()).build();
    }
}
