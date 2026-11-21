package com.fablepavilion.app;

import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    interface Listener { void report(State state, Release release); }

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
    }

    private static final class Transfer {
        final Release release;
        final long id;

        Transfer(Release release, long id) {
            this.release = release;
            this.id = id;
        }
    }

    private final Context context;
    private final SharedPreferences preferences;
    private final DownloadManager downloads;
    private final NotificationManager notifications;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final int installedCode;
    private Listener listener;
    private State state = State.CHECKING;
    private Release displayed;
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
        downloads = context.getSystemService(DownloadManager.class);
        notifications = context.getSystemService(NotificationManager.class);
        PackageInfo installed = packageInfo();
        installedCode = installed == null ? Integer.MAX_VALUE : installed.versionCode;
        notifications.createNotificationChannel(new NotificationChannel(
                CHANNEL, "软件更新", NotificationManager.IMPORTANCE_DEFAULT));
    }

    void attach(Listener listener) {
        this.listener = listener;
        listener.report(state, displayed);
    }

    void detach() { listener = null; }

    void check(Uri source, boolean verify, String encodedKey, VerifiedFrontend frontend, boolean manual) {
        work.execute(() -> {
            Transfer previous = reconcile();
            if (verify && frontend == null) return;
            if (manual) {
                lastFailure = 0;
                if (previous == null) publish(State.CHECKING, null);
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
                    if (previous == null && (manual || lastFailure == 0)) publish(State.CURRENT, null);
                    return;
                }
                if (previous != null && next.code <= previous.release.code) return;
                if (!manual && lastFailure != 0 && SystemClock.elapsedRealtime() - lastFailure < 60_000) return;
                enqueue(source, next, previous);
            } catch (Exception failure) {
                Log.w("FableUpdate", "Update check failed: " + failure.getClass().getSimpleName());
                if (previous == null) publish(State.FAILED, null);
            }
        });
    }

    private void enqueue(Uri origin, Release release, Transfer previous) throws JSONException, IOException {
        Uri url = origin.buildUpon().encodedPath(release.path()).build();
        DownloadManager.Request request = new DownloadManager.Request(url)
                .setTitle("子虚亭 " + release.version)
                .setMimeType(MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_HIDDEN)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS,
                        "update-" + UUID.randomUUID() + ".apk");
        long id = downloads.enqueue(request);
        JSONObject metadata = new JSONObject()
                .put("version", release.version).put("versionCode", release.code)
                .put("bytes", release.bytes).put("sha256", release.checksum).put("id", id);
        if (!preferences.edit().putString("transfer", metadata.toString()).commit()) {
            downloads.remove(id);
            throw new IOException("Could not save update download");
        }
        if (previous != null) removeFiles(previous);
        notifications.cancel(NOTIFICATION);
        lastFailure = 0;
        publish(State.DOWNLOADING, release);
    }

    private Transfer transfer() {
        String saved = preferences.getString("transfer", null);
        if (saved == null) return null;
        try {
            JSONObject row = new JSONObject(saved);
            return new Transfer(new Release(row), row.getLong("id"));
        } catch (JSONException malformed) {
            preferences.edit().remove("transfer").apply();
            return null;
        }
    }

    private Transfer reconcile() {
        Transfer entry = transfer();
        if (entry == null) return null;
        Release release = entry.release;
        if (release.code <= installedCode) {
            clear(entry);
            publish(State.CURRENT, null);
            return null;
        }
        if (UpdateProvider.file(context, release.filename).isFile()) {
            publish(State.READY, release);
            return entry;
        }

        try {
            int status;
            try (Cursor row = downloads.query(new DownloadManager.Query().setFilterById(entry.id))) {
                status = row != null && row.moveToFirst()
                        ? row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                        : DownloadManager.STATUS_FAILED;
            }
            if (status == DownloadManager.STATUS_FAILED) throw new IOException("Download failed");
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                publish(State.DOWNLOADING, release);
                return entry;
            }
            verifyDownload(entry);
            downloads.remove(entry.id);
            publish(State.READY, release);
            notifyReady(release);
            Log.i("FableUpdate", "Verified Android update ready: " + release.version);
            return entry;
        } catch (Exception failure) {
            clear(entry);
            lastFailure = SystemClock.elapsedRealtime();
            publish(State.FAILED, release);
            Log.w("FableUpdate", "Update rejected: " + failure.getClass().getSimpleName());
            return null;
        }
    }

    private void verifyDownload(Transfer entry) throws Exception {
        Release release = entry.release;
        File destination = UpdateProvider.file(context, release.filename);
        File directory = destination.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Update folder");
        File temporary = File.createTempFile("verify-", ".apk", directory);
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long size = 0;
            try (InputStream from = new ParcelFileDescriptor.AutoCloseInputStream(downloads.openDownloadedFile(entry.id));
                    FileOutputStream to = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = from.read(buffer)) != -1;) {
                    size += count;
                    if (size > release.bytes) throw new IOException("Unexpected update size");
                    digest.update(buffer, 0, count);
                    to.write(buffer, 0, count);
                }
                to.getFD().sync();
            }
            StringBuilder hash = new StringBuilder(64);
            for (byte b : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", b & 255));
            if (size != release.bytes || !release.checksum.contentEquals(hash))
                throw new IOException("Update checksum mismatch");
            PackageInfo archive = context.getPackageManager().getPackageArchiveInfo(temporary.getPath(), signingFlag());
            PackageInfo installed = packageInfo();
            if (archive == null || installed == null || !context.getPackageName().equals(archive.packageName) ||
                    archive.versionCode != release.code || !release.version.equals(archive.versionName) ||
                    !sameSigners(installed, archive)) throw new IOException("Unexpected APK identity");
            if (!temporary.renameTo(destination)) throw new IOException("Could not store verified APK");
        } finally {
            temporary.delete();
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

    private void removeFiles(Transfer entry) {
        downloads.remove(entry.id);
        UpdateProvider.file(context, entry.release.filename).delete();
    }

    private void clear(Transfer entry) {
        preferences.edit().remove("transfer").apply();
        removeFiles(entry);
        notifications.cancel(NOTIFICATION);
    }

    private void publish(State next, Release release) {
        main.post(() -> {
            if (state == next && (displayed == release ||
                    displayed != null && release != null && displayed.code == release.code)) return;
            state = next;
            displayed = release;
            if (listener != null) listener.report(state, displayed);
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

    public static final class Completed extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            AndroidUpdates updates = get(context);
            PendingResult pending = goAsync();
            updates.work.execute(() -> {
                try {
                    Transfer current = updates.transfer();
                    if (current != null && current.id == id) updates.reconcile();
                } finally {
                    pending.finish();
                }
            });
        }
    }
}
