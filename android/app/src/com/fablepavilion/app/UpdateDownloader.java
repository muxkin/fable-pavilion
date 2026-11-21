package com.fablepavilion.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.HttpsURLConnection;

/**
 * Direct in-process HTTPS APK downloader with mirror fallback and parallel HTTP Range support.
 * Runs inside the app process so it uses the app's network routing and foreground priority,
 * avoiding system DownloadManager background throttling.
 */
final class UpdateDownloader {
    static final int CHUNK_BYTES = 512 * 1024;
    static final int PARALLEL_WORKERS = 4;
    static final long MIN_PARALLEL_BYTES = 1024 * 1024;
    static final int CONNECT_TIMEOUT_MS = 15_000;
    static final int READ_TIMEOUT_MS = 20_000;
    private static final int BUFFER_BYTES = 64 * 1024;
    private static final int CHUNK_ATTEMPTS = 3;

    interface ProgressListener {
        void onProgress(int percent);
    }

    interface ConnectionFactory {
        HttpURLConnection open(String url) throws IOException;
    }

    static final ConnectionFactory HTTPS_ONLY = url -> {
        URL parsed = new URL(url);
        if (!"https".equalsIgnoreCase(parsed.getProtocol()))
            throw new IOException("HTTPS required");
        HttpURLConnection connection = (HttpURLConnection) parsed.openConnection();
        if (!(connection instanceof HttpsURLConnection))
            throw new IOException("HTTPS connection required");
        return connection;
    };

    private UpdateDownloader() { }

    static void download(List<String> urls, long expectedBytes, String expectedSha256,
            File destination, ProgressListener progress) throws IOException {
        download(urls, expectedBytes, expectedSha256, destination, progress, HTTPS_ONLY);
    }

    static void download(List<String> urls, long expectedBytes, String expectedSha256,
            File destination, ProgressListener progress, ConnectionFactory factory) throws IOException {
        if (urls == null || urls.isEmpty()) throw new IOException("No update download URLs");
        if (expectedBytes <= 0 || expectedSha256 == null || !expectedSha256.matches("[a-f0-9]{64}"))
            throw new IOException("Invalid expected APK metadata");
        IOException lastFailure = null;
        for (String url : urls) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
            try {
                downloadFromUrl(url, expectedBytes, expectedSha256, destination, progress, factory);
                return;
            } catch (IOException failure) {
                destination.delete();
                lastFailure = failure;
            }
        }
        throw lastFailure != null ? lastFailure : new IOException("Update download failed");
    }

    private static void downloadFromUrl(String url, long expectedBytes, String expectedSha256,
            File destination, ProgressListener progress, ConnectionFactory factory) throws IOException {
        boolean tryRange = expectedBytes >= MIN_PARALLEL_BYTES;
        long firstEnd = Math.min(CHUNK_BYTES - 1L, expectedBytes - 1L);
        HttpURLConnection first = open(factory, url, tryRange ? 0L : -1L, firstEnd);
        try {
            int code = first.getResponseCode();
            if (code == HttpURLConnection.HTTP_PARTIAL && tryRange) {
                if (!validContentRange(first.getHeaderField("Content-Range"), 0L, firstEnd, expectedBytes))
                    throw new IOException("Unexpected Content-Range on initial chunk");
                downloadParallel(url, first, firstEnd, expectedBytes, expectedSha256, destination, progress, factory);
                return;
            }
            if (code == HttpURLConnection.HTTP_OK) {
                long length = first.getContentLengthLong();
                if (length >= 0 && length != expectedBytes)
                    throw new IOException("Unexpected APK Content-Length: " + length);
                downloadSingleStream(first, expectedBytes, expectedSha256, destination, progress);
                return;
            }
            throw new IOException("Unexpected HTTP status " + code);
        } finally {
            first.disconnect();
        }
    }

    private static void downloadSingleStream(HttpURLConnection connection, long expectedBytes,
            String expectedSha256, File destination, ProgressListener progress) throws IOException {
        MessageDigest digest = sha256();
        long written = 0;
        AtomicInteger reported = new AtomicInteger(-1);
        reportProgress(progress, reported, 0, expectedBytes);
        try (InputStream input = connection.getInputStream();
                FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[BUFFER_BYTES];
            for (int count; (count = input.read(buffer)) != -1; ) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
                written += count;
                if (written > expectedBytes) throw new IOException("Unexpected update size");
                digest.update(buffer, 0, count);
                output.write(buffer, 0, count);
                reportProgress(progress, reported, written, expectedBytes);
            }
            output.getFD().sync();
        }
        if (written != expectedBytes) throw new IOException("Truncated update download");
        if (!expectedSha256.equals(hex(digest.digest())))
            throw new IOException("Update checksum mismatch");
        reportProgress(progress, reported, expectedBytes, expectedBytes);
    }

    private static void downloadParallel(String url, HttpURLConnection first, long firstEnd,
            long expectedBytes, String expectedSha256, File destination,
            ProgressListener progress, ConnectionFactory factory) throws IOException {
        AtomicLong completed = new AtomicLong(0);
        AtomicInteger reported = new AtomicInteger(-1);
        reportProgress(progress, reported, 0, expectedBytes);

        try (RandomAccessFile file = new RandomAccessFile(destination, "rw")) {
            file.setLength(expectedBytes);
            FileChannel channel = file.getChannel();
            long firstLen = firstEnd + 1L;
            try (InputStream input = first.getInputStream()) {
                writeRange(input, channel, 0L, firstLen, completed, expectedBytes, progress, reported);
            }
            first.disconnect();

            List<long[]> remaining = new ArrayList<>();
            for (long start = firstEnd + 1L; start < expectedBytes; start += CHUNK_BYTES) {
                long end = Math.min(start + CHUNK_BYTES - 1L, expectedBytes - 1L);
                remaining.add(new long[] { start, end });
            }
            if (!remaining.isEmpty()) {
                int threads = Math.min(PARALLEL_WORKERS, remaining.size());
                ExecutorService pool = Executors.newFixedThreadPool(threads);
                try {
                    List<Future<?>> tasks = new ArrayList<>(remaining.size());
                    for (final long[] range : remaining) {
                        tasks.add(pool.submit(() -> {
                            downloadChunkWithRetry(url, factory, channel, range[0], range[1],
                                    expectedBytes, completed, progress, reported);
                            return null;
                        }));
                    }
                    for (Future<?> task : tasks) {
                        try {
                            task.get();
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IOException("Download cancelled", interrupted);
                        } catch (ExecutionException failure) {
                            Throwable cause = failure.getCause();
                            if (cause instanceof IOException) throw (IOException) cause;
                            throw new IOException("Chunk download failed", cause);
                        }
                    }
                } finally {
                    pool.shutdownNow();
                }
            }
            channel.force(true);
        }

        if (destination.length() != expectedBytes) throw new IOException("Unexpected update size");
        verifyFileDigest(destination, expectedBytes, expectedSha256);
        reportProgress(progress, reported, expectedBytes, expectedBytes);
    }

    private static void downloadChunkWithRetry(String url, ConnectionFactory factory,
            FileChannel channel, long start, long end, long expectedBytes,
            AtomicLong completed, ProgressListener progress, AtomicInteger reported) throws IOException {
        long expectedLen = end - start + 1L;
        IOException last = null;
        for (int attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
            long chunkAdded = 0;
            HttpURLConnection connection = open(factory, url, start, end);
            try {
                int code = connection.getResponseCode();
                if (code != HttpURLConnection.HTTP_PARTIAL)
                    throw new IOException("Expected 206 Partial Content, got " + code);
                if (!validContentRange(connection.getHeaderField("Content-Range"), start, end, expectedBytes))
                    throw new IOException("Unexpected Content-Range for chunk " + start + "-" + end);
                try (InputStream input = connection.getInputStream()) {
                    chunkAdded = writeRange(input, channel, start, expectedLen,
                            completed, expectedBytes, progress, reported);
                }
                return;
            } catch (IOException failure) {
                if (chunkAdded > 0) completed.addAndGet(-chunkAdded);
                last = failure;
                if (attempt + 1 == CHUNK_ATTEMPTS) throw failure;
            } finally {
                connection.disconnect();
            }
        }
        throw last != null ? last : new IOException("Chunk download failed");
    }

    private static long writeRange(InputStream input, FileChannel channel, long offset,
            long expectedLen, AtomicLong completed, long totalBytes,
            ProgressListener progress, AtomicInteger reported) throws IOException {
        byte[] buffer = new byte[BUFFER_BYTES];
        long position = offset;
        long written = 0;
        for (int count; (count = input.read(buffer)) != -1; ) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
            if (written + count > expectedLen) throw new IOException("Chunk exceeded requested range");
            ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, count);
            while (bytes.hasRemaining()) {
                position += channel.write(bytes, position);
            }
            written += count;
            long total = completed.addAndGet(count);
            reportProgress(progress, reported, total, totalBytes);
        }
        if (written != expectedLen) throw new IOException("Truncated chunk: " + written + "/" + expectedLen);
        return written;
    }

    private static void verifyFileDigest(File file, long expectedBytes, String expectedSha256) throws IOException {
        MessageDigest digest = sha256();
        long size = 0;
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[BUFFER_BYTES];
            for (int count; (count = input.read(buffer)) != -1; ) {
                size += count;
                if (size > expectedBytes) throw new IOException("Unexpected update size");
                digest.update(buffer, 0, count);
            }
        }
        if (size != expectedBytes || !expectedSha256.equals(hex(digest.digest())))
            throw new IOException("Update checksum mismatch");
    }

    private static HttpURLConnection open(ConnectionFactory factory, String url,
            long rangeStart, long rangeEnd) throws IOException {
        HttpURLConnection connection = factory.open(url);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (rangeStart >= 0) {
            connection.setRequestProperty("Range", "bytes=" + rangeStart + "-" + rangeEnd);
        }
        return connection;
    }

    static boolean validContentRange(String header, long start, long end, long total) {
        if (header == null) return false;
        String expected = "bytes " + start + "-" + end + "/" + total;
        return expected.equals(header.trim());
    }

    private static void reportProgress(ProgressListener listener, AtomicInteger lastPercent,
            long downloaded, long total) {
        if (listener == null || total <= 0) return;
        int percent = (int) Math.min(100L, Math.max(0L, (downloaded * 100L) / total));
        int previous = lastPercent.get();
        if (percent > previous && lastPercent.compareAndSet(previous, percent)) {
            listener.onProgress(percent);
        }
    }

    private static MessageDigest sha256() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IOException(impossible);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
}
