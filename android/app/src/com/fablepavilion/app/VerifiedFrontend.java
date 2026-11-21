package com.fablepavilion.app;

import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

final class VerifiedFrontend {
    private static final String RELEASE = "/_release/";
    private static final String EMBEDDED = "verified-frontend/";
    private static final int MAX_FILE = 25 * 1024 * 1024; // Pages' maximum asset size.
    private static final Pattern INSTALLER_PATH =
            Pattern.compile("/downloads/android/fable-pavilion-android-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk");
    private static final Pattern SHELL_ASSET = Pattern.compile("[\"']/assets/([A-Za-z0-9._-]+\\.(?:js|css))[\"']");
    private static final ConcurrentHashMap<String, Object> ASSET_LOCKS = new ConcurrentHashMap<>();
    private final Uri releaseOrigin;
    private final File cache;
    private final Map<String, String> files;
    private final Set<String> hashes;
    private final Embedded embedded;
    private final byte[] document;
    private final String id;
    private final long version;
    private final long expires;
    private final String uploadOrigins;

    private static final class Embedded {
        final AssetManager assets;
        final Set<String> files;

        Embedded(AssetManager assets) throws IOException {
            this.assets = assets;
            files = new HashSet<>(Arrays.asList(assets.list(EMBEDDED + "assets")));
        }
    }

    private VerifiedFrontend(Uri releaseOrigin, File cache, byte[] document, PublicKey key, Embedded embedded)
            throws Exception {
        this.releaseOrigin = releaseOrigin;
        this.document = document;
        this.embedded = embedded;
        JSONObject signed = new JSONObject(new String(document, StandardCharsets.UTF_8));
        byte[] bytes = Base64.decode(signed.getString("manifest"), Base64.DEFAULT);
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(key);
        verifier.update(bytes);
        if (!verifier.verify(Base64.decode(signed.getString("signature"), Base64.DEFAULT)))
            throw new IOException("Invalid release signature");
        JSONObject manifest = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        version = manifest.getLong("version");
        expires = manifest.getLong("expires");
        if (manifest.getInt("schema") != 1 || version <= 0 || version > 9007199254740991L || expires <= 0)
            throw new IOException("Invalid release manifest");
        JSONArray sources = manifest.optJSONArray("uploadOrigins");
        StringBuilder destinations = new StringBuilder();
        if (sources != null) for (int i = 0; i < sources.length(); i++) {
            String destination = sources.getString(i);
            if (!destination.matches("https://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?"))
                throw new IOException("Invalid upload origin");
            destinations.append(' ').append(destination);
        }
        uploadOrigins = destinations.toString();
        id = digest(bytes);
        this.cache = cache;
        files = new HashMap<>();
        JSONObject entries = manifest.getJSONObject("files");
        for (Iterator<String> names = entries.keys(); names.hasNext();) {
            String path = names.next();
            String hash = entries.getString(path);
            if (!path.matches("/[a-zA-Z0-9_.@+-]+(?:/[a-zA-Z0-9_.@+-]+)*") ||
                    path.matches(".*/\\.{1,2}(?:/.*)?") || path.startsWith(RELEASE) ||
                    !hash.matches("[a-f0-9]{64}")) throw new IOException("Invalid release path");
            files.put(path, hash);
        }
        if (!files.containsKey("/index.html")) throw new IOException("Release entry missing");
        hashes = new HashSet<>(files.values());
    }

    private static PublicKey releaseKey(String encodedKey) throws Exception {
        return KeyFactory.getInstance("RSA")
                .generatePublic(new X509EncodedKeySpec(Base64.decode(encodedKey, Base64.DEFAULT)));
    }

    static VerifiedFrontend openLocal(Uri releaseOrigin, String encodedKey, File cache, SharedPreferences prefs,
            AssetManager assets) throws Exception {
        PublicKey key = releaseKey(encodedKey);
        Embedded embedded = new Embedded(assets);
        VerifiedFrontend bundled;
        try (InputStream stream = assets.open(EMBEDDED + "manifest.json")) {
            bundled = new VerifiedFrontend(releaseOrigin, cache, read(stream, 1024 * 1024), key, embedded);
        }
        VerifiedFrontend cached = saved(releaseOrigin, cache, key, embedded, prefs);
        if (cached != null && cached.sameOrNewerThan(bundled) && cached.ready()) return cached;
        if (bundled.ready()) return bundled;
        return bundled.update(encodedKey, prefs);
    }

    private static VerifiedFrontend saved(Uri releaseOrigin, File cache, PublicKey key, Embedded embedded,
            SharedPreferences prefs) {
        String document = prefs.getString(releaseOrigin.toString(), null);
        if (document == null) return null;
        try {
            return new VerifiedFrontend(releaseOrigin, cache, Base64.decode(document, Base64.DEFAULT), key, embedded);
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean sameOrNewerThan(VerifiedFrontend previous) {
        return version > previous.version || version == previous.version && id.equals(previous.id);
    }

    private boolean hasLocalAsset(String hash) {
        return hash != null && (embedded.files.contains(hash + ".bin") || new File(cache, hash).isFile());
    }

    private boolean ready() {
        if (expires <= System.currentTimeMillis()) return false;
        return hasLocalAsset(files.get("/index.html"));
    }

    private Set<String> criticalShellHashes(byte[] indexHtml) {
        Set<String> needed = new HashSet<>();
        for (String path : new String[] { "/index.html", "/sw.js", "/version.json", "/manifest.webmanifest", AndroidUpdates.FEED }) {
            String hash = files.get(path);
            if (hash != null && !hasLocalAsset(hash)) needed.add(hash);
        }
        if (indexHtml != null) {
            Matcher matcher = SHELL_ASSET.matcher(new String(indexHtml, StandardCharsets.UTF_8));
            while (matcher.find()) {
                String path = "/assets/" + matcher.group(1);
                String hash = files.get(path);
                if (hash != null && !hasLocalAsset(hash)) needed.add(hash);
            }
        }
        return needed;
    }

    VerifiedFrontend update(String encodedKey, SharedPreferences prefs) throws Exception {
        PublicKey key = releaseKey(encodedKey);
        VerifiedFrontend previous = saved(releaseOrigin, cache, key, embedded, prefs);
        byte[] document = fetch(releaseOrigin + RELEASE + "manifest.json", 1024 * 1024);
        VerifiedFrontend next = new VerifiedFrontend(releaseOrigin, cache, document, key, embedded);
        if (next.expires <= System.currentTimeMillis() || !next.sameOrNewerThan(this) ||
                (previous != null && !next.sameOrNewerThan(previous)))
            throw new IOException("Expired or rolled back release");
        if (next.id.equals(id) && ready()) return this;
        // Prefetch only the critical shell (/index.html + its direct entry assets) so hot-updates
        // complete in under a second; lazy route/syntax/diagram chunks verify & cache on demand.
        String indexHash = next.files.get("/index.html");
        byte[] indexHtml = indexHash != null ? next.file(indexHash, true) : null;
        Set<String> needed = next.criticalShellHashes(indexHtml);
        if (!needed.isEmpty()) {
            ExecutorService pool = Executors.newFixedThreadPool(Math.min(6, needed.size()));
            try {
                java.util.List<Future<?>> tasks = new java.util.ArrayList<>(needed.size());
                for (final String hash : needed) {
                    tasks.add(pool.submit(() -> {
                        next.file(hash, true);
                        return null;
                    }));
                }
                for (Future<?> task : tasks) {
                    try {
                        task.get();
                    } catch (ExecutionException failure) {
                        Throwable cause = failure.getCause();
                        if (cause instanceof Exception) throw (Exception) cause;
                        throw new IOException("Asset download failed", cause);
                    }
                }
            } finally {
                pool.shutdownNow();
            }
        }
        if (!prefs.edit().putString(releaseOrigin.toString(), Base64.encodeToString(document, Base64.NO_WRAP)).commit())
            throw new IOException("Could not save accepted release");
        return next;
    }

    AndroidUpdates.Release fetchLatestAndroidRelease(String encodedKey) throws Exception {
        PublicKey key = releaseKey(encodedKey);
        byte[] doc = fetch(releaseOrigin + RELEASE + "manifest.json", 1024 * 1024);
        VerifiedFrontend next = new VerifiedFrontend(releaseOrigin, cache, doc, key, embedded);
        if (next.expires <= System.currentTimeMillis() || !next.sameOrNewerThan(this))
            throw new IOException("Expired or rolled back release");
        String hash = next.files.get(AndroidUpdates.FEED);
        if (hash == null) return null;
        byte[] bytes = next.file(hash, true);
        AndroidUpdates.Release apk = new AndroidUpdates.Release(
                new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
        if (!apk.checksum.equals(next.files.get(apk.path()))) throw new IOException("Unsigned APK checksum");
        return apk;
    }

    static boolean isInstallerPath(String path) {
        return path != null && INSTALLER_PATH.matcher(path).matches();
    }

    AndroidUpdates.Release androidRelease() throws Exception {
        String hash = files.get(AndroidUpdates.FEED);
        if (hash == null) return null;
        if (expires <= System.currentTimeMillis()) throw new IOException("Release expired");
        byte[] bytes = file(hash, true);
        AndroidUpdates.Release apk = new AndroidUpdates.Release(
                new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
        if (!apk.checksum.equals(files.get(apk.path()))) throw new IOException("Unsigned APK checksum");
        return apk;
    }

    WebResourceResponse intercept(WebResourceRequest request, Uri site) {
        Uri url = request.getUrl();
        if (!MainActivity.sameOrigin(site, url)) return null;
        String path = url.getEncodedPath();
        if (path == null) path = "/";
        boolean data = path.startsWith("/api/") || path.startsWith("/local-files/") ||
                path.startsWith("/downloads/desktop/") || path.equals("/health");
        if (data && !request.isForMainFrame()) return null;
        if (!"GET".equals(request.getMethod()) || data) return error(403, "Forbidden");
        try {
            if (expires <= System.currentTimeMillis()) throw new IOException("Release expired");
            if (path.startsWith(RELEASE)) {
                if (request.isForMainFrame()) return error(403, "Forbidden");
                if (path.equals(RELEASE + "manifest.json")) return releaseData(document);
                String prefix = RELEASE + "assets/";
                if (path.startsWith(prefix) && path.endsWith(".bin")) {
                    String hash = path.substring(prefix.length(), path.length() - 4);
                    if (hashes.contains(hash)) return releaseData(file(hash, true));
                }
                return error(404, "Not Found");
            }
            if (request.isForMainFrame() || path.equals("/")) path = "/index.html";
            return asset(path, site);
        } catch (Exception failure) {
            return unavailable();
        }
    }

    WebResourceResponse asset(String path, Uri site) throws Exception {
        if (expires <= System.currentTimeMillis()) throw new IOException("Release expired");
        String expected = files.get(path);
        if (expected == null) return error(404, "Not Found");
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        headers.put("Cache-Control", "no-store");
        if (path.endsWith(".html")) headers.put("Content-Security-Policy",
                "default-src 'self'; script-src " + site + "/assets/; " +
                "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
                "media-src 'self' blob: https:; connect-src 'self'" + uploadOrigins + "; font-src 'self'; " +
                "worker-src " + site + "/sw.js " + site + "/assets/ blob:; " +
                "frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'");
        String mime = mime(path);
        String encoding = mime.startsWith("text/") ? "UTF-8" : null;
        return new WebResourceResponse(mime, encoding, 200, "OK", headers,
                new ByteArrayInputStream(file(expected, true)));
    }

    private static WebResourceResponse releaseData(byte[] bytes) {
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Cache-Control", "no-store");
        headers.put("Content-Security-Policy", "default-src 'none'; sandbox");
        return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers,
                new ByteArrayInputStream(bytes));
    }

    static WebResourceResponse unavailable() {
        return error(503, "Release Verification Failed");
    }

    private static WebResourceResponse error(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason,
                java.util.Collections.singletonMap("X-Content-Type-Options", "nosniff"),
                new ByteArrayInputStream("前端发布验签失败".getBytes(StandardCharsets.UTF_8)));
    }

    private byte[] file(String expected, boolean download) throws Exception {
        if (embedded.files.contains(expected + ".bin")) {
            try (InputStream input = embedded.assets.open(EMBEDDED + "assets/" + expected + ".bin")) {
                byte[] bytes = read(input, MAX_FILE);
                if (expected.equals(digest(bytes))) return bytes;
            }
        }
        File stored = new File(cache, expected);
        if (stored.isFile()) {
            try (InputStream input = new FileInputStream(stored)) {
                byte[] bytes = read(input, MAX_FILE);
                if (expected.equals(digest(bytes))) return bytes;
            } catch (IOException ignored) {
                // An interrupted or unreadable cache entry can be downloaded again.
            }
            stored.delete();
        }
        if (!download) throw new IOException("Asset is not present in the verified release cache");
        Object lock = ASSET_LOCKS.computeIfAbsent(expected, ignored -> new Object());
        synchronized (lock) {
            if (stored.isFile()) {
                try (InputStream input = new FileInputStream(stored)) {
                    byte[] bytes = read(input, MAX_FILE);
                    if (expected.equals(digest(bytes))) return bytes;
                } catch (IOException ignored) {}
                stored.delete();
            }
            byte[] bytes = fetch(releaseOrigin + RELEASE + "assets/" + expected + ".bin", MAX_FILE);
            if (!expected.equals(digest(bytes))) throw new IOException("Invalid release file hash");
            if (!cache.isDirectory() && !cache.mkdirs() && !cache.isDirectory())
                throw new IOException("Could not create the verified release cache");
            File writing = File.createTempFile("asset", ".tmp", cache);
            try {
                try (FileOutputStream output = new FileOutputStream(writing)) { output.write(bytes); }
                if (!writing.renameTo(stored)) throw new IOException("Could not save the verified release asset");
            } finally {
                writing.delete();
            }
            return bytes;
        }
    }

    static byte[] fetch(String url, int limit) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setUseCaches(false);
            boolean keepAlive = false;
            try {
                if (connection.getResponseCode() != 200 || connection.getContentLengthLong() > limit)
                    throw new IOException("Release download unavailable");
                try (InputStream input = connection.getInputStream()) {
                    byte[] data = read(input, limit);
                    keepAlive = true;
                    return data;
                }
            } catch (IOException failure) {
                last = failure;
                if (attempt == 2) throw failure;
            } finally {
                if (!keepAlive) connection.disconnect();
            }
        }
        throw last != null ? last : new IOException("Release download unavailable");
    }

    private static byte[] read(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > limit) throw new IOException("Release file too large");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static String digest(byte[] value) throws Exception {
        StringBuilder out = new StringBuilder(64);
        for (byte by : MessageDigest.getInstance("SHA-256").digest(value))
            out.append(String.format(Locale.ROOT, "%02x", by & 255));
        return out.toString();
    }

    private static String mime(String path) {
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        if (path.endsWith(".wasm")) return "application/wasm";
        if (path.endsWith(".woff2")) return "font/woff2";
        if (path.endsWith(".woff")) return "font/woff";
        if (path.endsWith(".apk")) return "application/vnd.android.package-archive";
        String guessed = android.webkit.MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(android.webkit.MimeTypeMap.getFileExtensionFromUrl(path));
        return guessed == null ? "application/octet-stream" : guessed;
    }
}
