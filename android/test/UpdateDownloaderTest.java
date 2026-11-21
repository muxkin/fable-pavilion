package com.fablepavilion.app;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class UpdateDownloaderTest {
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static String sha256(byte[] data) throws Exception {
        StringBuilder hex = new StringBuilder(64);
        for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) {
            hex.append(String.format(Locale.ROOT, "%02x", b & 255));
        }
        return hex.toString();
    }

    private static void sendBytes(HttpExchange exchange, int code, byte[] body, int offset, int length)
            throws IOException {
        exchange.sendResponseHeaders(code, length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body, offset, length);
        }
    }

    public static void main(String[] args) throws Exception {
        byte[] payload = new byte[2 * 1024 * 1024 + 137_219]; // > 2 MiB to trigger parallel Range chunks
        new Random(42).nextBytes(payload);
        String expectedHash = sha256(payload);

        AtomicInteger rangeHits = new AtomicInteger();
        AtomicInteger flakyFailOnce = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService serverPool = Executors.newFixedThreadPool(8);
        server.setExecutor(serverPool);

        // 1. Supports 206 Partial Content (with one transient 500 on chunk 2 to exercise retry)
        server.createContext("/range.apk", exchange -> {
            String range = exchange.getRequestHeaders().getFirst("Range");
            if (range != null && range.startsWith("bytes=")) {
                rangeHits.incrementAndGet();
                String[] bounds = range.substring(6).split("-", 2);
                int start = Integer.parseInt(bounds[0]);
                int end = Integer.parseInt(bounds[1]);
                if (start > 0 && flakyFailOnce.compareAndSet(0, 1)) {
                    exchange.sendResponseHeaders(500, -1);
                    exchange.close();
                    return;
                }
                int len = end - start + 1;
                exchange.getResponseHeaders().set("Accept-Ranges", "bytes");
                exchange.getResponseHeaders().set("Content-Range",
                        "bytes " + start + "-" + end + "/" + payload.length);
                sendBytes(exchange, 206, payload, start, len);
            } else {
                sendBytes(exchange, 200, payload, 0, payload.length);
            }
        });

        // 2. Ignores Range header, always returns 200 OK
        server.createContext("/stream.apk", exchange ->
                sendBytes(exchange, 200, payload, 0, payload.length));

        // 3. Returns 404 (tests mirror fallback)
        server.createContext("/missing.apk", exchange -> {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
        });

        // 4. Returns corrupted bytes (tests SHA-256 verification + mirror fallback)
        server.createContext("/corrupt.apk", exchange -> {
            byte[] bad = Arrays.copyOf(payload, payload.length);
            bad[1234] ^= 0x55;
            sendBytes(exchange, 200, bad, 0, bad.length);
        });

        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        UpdateDownloader.ConnectionFactory localHttp = url -> (HttpURLConnection) new URL(url).openConnection();
        File tmpDir = Files.createTempDirectory("update-downloader-test-").toFile();
        try {
            // Test 1: Parallel 206 Range download + transient chunk retry + progress monotonicity
            File out1 = new File(tmpDir, "range.apk");
            List<Integer> progress1 = Collections.synchronizedList(new ArrayList<>());
            UpdateDownloader.download(
                    Collections.singletonList(base + "/range.apk"),
                    payload.length, expectedHash, out1, progress1::add, localHttp);
            require(Arrays.equals(Files.readAllBytes(out1.toPath()), payload), "Parallel range payload mismatch");
            require(rangeHits.get() >= 5, "Expected multiple range chunk requests, got " + rangeHits.get());
            require(flakyFailOnce.get() == 1, "Expected transient chunk retry to fire");
            require(!progress1.isEmpty() && progress1.get(progress1.size() - 1) == 100, "Progress should end at 100");

            // Test 2: Single-stream 200 fallback when Range is ignored
            File out2 = new File(tmpDir, "stream.apk");
            UpdateDownloader.download(
                    Collections.singletonList(base + "/stream.apk"),
                    payload.length, expectedHash, out2, null, localHttp);
            require(Arrays.equals(Files.readAllBytes(out2.toPath()), payload), "Stream fallback payload mismatch");

            // Test 3: Mirror fallback from 404 -> corrupt -> healthy Range mirror
            File out3 = new File(tmpDir, "fallback.apk");
            UpdateDownloader.download(
                    Arrays.asList(base + "/missing.apk", base + "/corrupt.apk", base + "/range.apk"),
                    payload.length, expectedHash, out3, null, localHttp);
            require(Arrays.equals(Files.readAllBytes(out3.toPath()), payload), "Mirror fallback payload mismatch");

            // Test 4: Corrupt-only mirror must fail and clean up destination
            File out4 = new File(tmpDir, "bad.apk");
            boolean failed = false;
            try {
                UpdateDownloader.download(
                        Collections.singletonList(base + "/corrupt.apk"),
                        payload.length, expectedHash, out4, null, localHttp);
            } catch (IOException expected) {
                failed = true;
            }
            require(failed, "Corrupt APK should be rejected");
            require(!out4.exists(), "Corrupt APK destination file should be deleted");

            // Test 5: Production HTTPS-only factory rejects HTTP URLs
            boolean rejectedHttp = false;
            try {
                UpdateDownloader.download(
                        Collections.singletonList(base + "/stream.apk"),
                        payload.length, expectedHash, out4, null);
            } catch (IOException expected) {
                rejectedHttp = true;
            }
            require(rejectedHttp, "Default HTTPS factory must reject HTTP URLs");

            System.out.println("UpdateDownloaderTest passed (" + rangeHits.get() + " range requests)");
        } finally {
            server.stop(0);
            serverPool.shutdownNow();
            for (File child : tmpDir.listFiles()) child.delete();
            tmpDir.delete();
        }
    }
}
