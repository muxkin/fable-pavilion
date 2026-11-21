package com.fablepavilion.app;

import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.json.JSONException;
import org.json.JSONObject;

public final class AndroidUpdates {
    static final String FEED = "/downloads/android/latest.json";
    static final String OPEN = "com.fablepavilion.app.OPEN_UPDATE";
    static final String MIME = "application/vnd.android.package-archive";
    private static final String CHANNEL = "software-updates";
    private static final int NOTIFICATION = 1;
    private static AndroidUpdates instance;

    enum State { CHECKING, CURRENT, DOWNLOADING, READY, FAILED }
    interface Listener { void report(State state, Release release, int progress); }

    static final class Release {
        final String version;
        final int code;
        final long bytes;
        final String checksum;
        final String filename;

        Release(JSONObject metadata) throws JSONException {
            version = metadata.getString("version");
            code = metadata.getInt("versionCode");
            bytes = metadata.getLong("bytes");
            checksum = metadata.getString("sha256");
            filename = "fable-pavilion-android-" + version + ".apk";
            if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+") || code < 1 || bytes < 1 ||
                    !checksum.matches("[a-f0-9]{64}")) throw new JSONException("Invalid APK metadata");
        }

        String path() { return "/downloads/android/" + filename; }

        JSONObject toJson() throws JSONException {
            return new JSONObject()
                    .put("version", version)
                    .put("versionCode", code)
                    .put("bytes", bytes)
                    .put("sha256", checksum);
        }
    }

    private final Context context;
    private final SharedPreferences preferences;
    private final NotificationManager notifications;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final ExecutorService downloadWork = Executors.newSingleThreadExecutor();
    private final Object downloadLock = new Object();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final int installedCode;
    private Listener listener;
    private State state = State.CHECKING;
    private Release displayed;
    private int progress = -1;
    private Release inFlight;
    private Future<?> inFlightTask;
    private long lastFailure;
    private Uri queriedOrigin;
    private long queriedAt;

    static synchronized AndroidUpdates get(Context context) {
        if (instance == null) instance = new AndroidUpdates(context.getApplicationContext());
        return instance;
    }

    private AndroidUpdates(Context context) {
        this.context = context;
        preferences = context.getSharedPreferences("android-updates", Context.MODE_PRIVATE);
        notifications = context.getSystemService(NotificationManager.class);
        PackageInfo installed = packageInfo();
        installedCode = installed == null ? Integer.MAX_VALUE : installed.versionCode;
        notifications.createNotificationChannel(new NotificationChannel(
                CHANNEL, "软件更新", NotificationManager.IMPORTANCE_DEFAULT));
    }

    void attach(Listener listener) {
        this.listener = listener;
        listener.report(state, displayed, progress);
    }

    void detach() { listener = null; }

    void check(Uri source, Uri preferredDownloadOrigin, boolean verify, String encodedKey,
            VerifiedFrontend frontend, boolean manual) {
        work.execute(() -> {
            Release ready = reconcile();
            Release active = activeDownload();
            if (verify && frontend == null) return;
            if (manual) {
                lastFailure = 0;
                if (ready == null && active == null) publish(State.CHECKING, null, -1);
            }
            try {
                Release next;
                long now = SystemClock.elapsedRealtime();
                if (verify) {
                    next = frontend.androidRelease();
                    boolean shouldFetch = manual || next == null || next.code <= installedCode;
                    if (shouldFetch && encodedKey != null && !encodedKey.isEmpty() &&
                            (manual || !source.equals(queriedOrigin) || now - queriedAt >= 60_000)) {
                        queriedAt = now;
                        queriedOrigin = source;
                        Release remote = frontend.fetchLatestAndroidRelease(encodedKey);
                        if (remote != null && (next == null || remote.code >= next.code)) next = remote;
                    }
                } else {
                    if (!manual && source.equals(queriedOrigin) && now - queriedAt < 60_000) return;
                    queriedAt = now;
                    queriedOrigin = source;
                    byte[] raw = VerifiedFrontend.fetch(source + FEED, 16 * 1024);
                    next = new Release(new JSONObject(new String(raw, StandardCharsets.UTF_8)));
                }
                if (next == null || next.code <= installedCode) {
                    if (ready == null && active == null && (manual || lastFailure == 0))
                        publish(State.CURRENT, null, -1);
                    return;
                }
                if (ready != null && next.code <= ready.code) return;
                if (active != null && next.code <= active.code) return;
                if (!manual && lastFailure != 0 && SystemClock.elapsedRealtime() - lastFailure < 60_000) return;
                startDownload(downloadUrls(preferredDownloadOrigin, source, next), next);
            } catch (Exception failure) {
                Log.w("FableUpdate", "Update check failed: " + failure.getClass().getSimpleName());
                if (ready == null && active == null) publish(State.FAILED, null, -1);
            }
        });
    }

    private static List<String> downloadUrls(Uri preferredOrigin, Uri releaseOrigin, Release release) {
        LinkedHashSet<String> urls = new LinkedHashSet<>();
        if (preferredOrigin != null && "https".equalsIgnoreCase(preferredOrigin.getScheme())) {
            urls.add(preferredOrigin.buildUpon().encodedPath(release.path()).build().toString());
        }
        if (releaseOrigin != null && "https".equalsIgnoreCase(releaseOrigin.getScheme())) {
            urls.add(releaseOrigin.buildUpon().encodedPath(release.path()).build().toString());
        }
        return new ArrayList<>(urls);
    }

    private Release activeDownload() {
        synchronized (downloadLock) {
            return inFlight;
        }
    }

    private void startDownload(List<String> urls, Release release) {
        synchronized (downloadLock) {
            if (inFlight != null && release.code <= inFlight.code) return;
            if (inFlightTask != null) inFlightTask.cancel(true);
            inFlight = release;
            notifications.cancel(NOTIFICATION);
            lastFailure = 0;
            publish(State.DOWNLOADING, release, 0);
            inFlightTask = downloadWork.submit(() -> runDownload(urls, release));
        }
    }

    private void runDownload(List<String> urls, Release release) {
        File destination = UpdateProvider.file(context, release.filename);
        File directory = destination.getParentFile();
        File temporary = null;
        try {
            if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory())
                throw new IOException("Update folder");
            temporary = File.createTempFile("download-", ".apk", directory);
            long started = SystemClock.elapsedRealtime();
            UpdateDownloader.download(urls, release.bytes, release.checksum, temporary, percent -> {
                synchronized (downloadLock) {
                    if (inFlight == release) publish(State.DOWNLOADING, release, percent);
                }
            });
            verifyApkArchive(temporary, release);
            if (!temporary.renameTo(destination)) throw new IOException("Could not store verified APK");
            temporary = null;
            if (!preferences.edit().putString("ready", release.toJson().toString()).commit()) {
                destination.delete();
                throw new IOException("Could not save update metadata");
            }
            pruneOtherApks(directory, release.filename);
            synchronized (downloadLock) {
                if (inFlight == release) {
                    inFlight = null;
                    inFlightTask = null;
                }
            }
            publish(State.READY, release, 100);
            notifyReady(release);
            long elapsed = Math.max(1L, SystemClock.elapsedRealtime() - started);
            Log.i("FableUpdate", "Verified Android update ready: " + release.version +
                    " (" + (release.bytes / 1024) + " KiB in " + elapsed + " ms)");
        } catch (Exception failure) {
            if (temporary != null) temporary.delete();
            boolean superseded;
            synchronized (downloadLock) {
                superseded = inFlight != release;
                if (!superseded) {
                    inFlight = null;
                    inFlightTask = null;
                }
            }
            if (!superseded) {
                lastFailure = SystemClock.elapsedRealtime();
                publish(State.FAILED, release, -1);
                Log.w("FableUpdate", "Update download failed: " + failure.getClass().getSimpleName() +
                        ": " + failure.getMessage());
            }
        }
    }

    private void verifyApkArchive(File apk, Release release) throws IOException {
        PackageInfo archive = context.getPackageManager().getPackageArchiveInfo(apk.getPath(), signingFlag());
        PackageInfo installed = packageInfo();
        if (archive == null || installed == null || !context.getPackageName().equals(archive.packageName) ||
                archive.versionCode != release.code || !release.version.equals(archive.versionName) ||
                !sameSigners(installed, archive)) {
            throw new IOException("Unexpected APK identity");
        }
    }

    private Release savedReady() {
        String saved = preferences.getString("ready", null);
        if (saved == null) return null;
        try {
            return new Release(new JSONObject(saved));
        } catch (JSONException malformed) {
            preferences.edit().remove("ready").apply();
            return null;
        }
    }

    private void cleanupLegacyTransfer() {
        String legacy = preferences.getString("transfer", null);
        if (legacy == null) return;
        try {
            JSONObject row = new JSONObject(legacy);
            long id = row.optLong("id", -1);
            if (id >= 0) {
                DownloadManager manager = context.getSystemService(DownloadManager.class);
                if (manager != null) manager.remove(id);
            }
            if (preferences.getString("ready", null) == null) {
                Release release = new Release(row);
                File existing = UpdateProvider.file(context, release.filename);
                if (existing.isFile() && existing.length() == release.bytes) {
                    preferences.edit().putString("ready", release.toJson().toString()).apply();
                }
            }
        } catch (Exception ignored) {
            // Legacy state is best-effort cleanup.
        } finally {
            preferences.edit().remove("transfer").apply();
        }
    }

    private Release reconcile() {
        cleanupLegacyTransfer();
        Release ready = savedReady();
        if (ready == null) return null;
        File file = UpdateProvider.file(context, ready.filename);
        if (ready.code <= installedCode) {
            clearReady(ready);
            publish(State.CURRENT, null, -1);
            return null;
        }
        if (file.isFile() && file.length() == ready.bytes) {
            publish(State.READY, ready, 100);
            return ready;
        }
        clearReady(ready);
        return null;
    }

    private static void pruneOtherApks(File directory, String keepFilename) {
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isFile() && !child.getName().equals(keepFilename)) child.delete();
        }
    }

    private PackageInfo packageInfo() {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), signingFlag());
        } catch (PackageManager.NameNotFoundException ignored) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static int signingFlag() {
        return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signers(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28
                ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners())
                : info.signatures;
    }

    private static boolean sameSigners(PackageInfo installed, PackageInfo archive) {
        Signature[] before = signers(installed), after = signers(archive);
        return before != null && before.length != 0 && after != null &&
                new HashSet<>(Arrays.asList(before)).equals(new HashSet<>(Arrays.asList(after)));
    }

    private void clearReady(Release release) {
        preferences.edit().remove("ready").apply();
        UpdateProvider.file(context, release.filename).delete();
        notifications.cancel(NOTIFICATION);
    }

    private void publish(State next, Release release, int nextProgress) {
        main.post(() -> {
            boolean sameRelease = displayed == release ||
                    (displayed != null && release != null && displayed.code == release.code);
            if (state == next && sameRelease && progress == nextProgress) return;
            state = next;
            displayed = release;
            progress = nextProgress;
            if (listener != null) listener.report(state, displayed, progress);
        });
    }

    private void notifyReady(Release release) {
        if (!notifications.areNotificationsEnabled()) return;
        Intent open = new Intent(context, MainActivity.class).setAction(OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent action = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        notifications.notify(NOTIFICATION, new Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("子虚亭 " + release.version + " 已下载")
                .setContentText("点此安装更新")
                .setContentIntent(action)
                .setAutoCancel(true)
                .build());
    }
}
