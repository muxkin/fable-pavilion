package com.fablepavilion.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** Shares only temporary camera output with the Android camera activity. */
public final class CaptureProvider extends ContentProvider {
    private static final String AUTHORITY = "com.fablepavilion.app.camera";

    private static File directory(Context context) {
        return new File(context.getCacheDir(), "camera");
    }

    static Uri newPhoto(Context context) throws IOException {
        File directory = directory(context);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Camera cache");
        File[] old = directory.listFiles();
        if (old != null) for (File file : old) {
            if (System.currentTimeMillis() - file.lastModified() >= TimeUnit.DAYS.toMillis(1)) file.delete();
        }
        File photo = File.createTempFile("photo-", ".jpg", directory);
        return Uri.parse("content://" + AUTHORITY + "/" + photo.getName());
    }

    private static File photo(Context context, Uri uri) {
        String name = uri.getLastPathSegment();
        if (!AUTHORITY.equals(uri.getAuthority()) || uri.getPathSegments().size() != 1 ||
                name == null || !name.matches("photo-[0-9]+\\.jpg"))
            throw new IllegalArgumentException("Unknown camera file");
        return new File(directory(context), name);
    }

    static boolean visiblePhoto(Context context, Uri uri) {
        try {
            File file = photo(context, uri);
            return file.isFile() && file.length() > 0;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    static void deletePhoto(Context context, Uri uri) { photo(context, uri).delete(); }

    @Override public boolean onCreate() { return true; }

    @Override public String getType(Uri uri) { return "image/jpeg"; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = photo(getContext(), uri);
        if (!file.isFile()) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode));
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File file = photo(getContext(), uri);
        String[] columns = projection == null
                ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE } : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        if (file.isFile()) {
            MatrixCursor.RowBuilder row = cursor.newRow();
            for (String column : columns) {
                if (OpenableColumns.DISPLAY_NAME.equals(column)) row.add(file.getName());
                else if (OpenableColumns.SIZE.equals(column)) row.add(file.length());
                else row.add(null);
            }
        }
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
