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

public final class UpdateProvider extends ContentProvider {
    private static final String AUTHORITY = "com.fablepavilion.app.updates";

    static File file(Context context, String filename) {
        return new File(new File(context.getFilesDir(), "android-updates"), filename);
    }

    static Uri uri(String filename) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(filename).build();
    }

    private File checkedFile(Uri uri) {
        if (!AUTHORITY.equals(uri.getAuthority()) || uri.getPathSegments().size() != 1 ||
                !VerifiedFrontend.isInstallerPath("/downloads/android/" + uri.getLastPathSegment()))
            throw new IllegalArgumentException("Unknown APK");
        return file(getContext(), uri.getLastPathSegment());
    }

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return AndroidUpdates.MIME; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File apk = checkedFile(uri);
        if (!"r".equals(mode) || !apk.isFile()) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(apk, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File apk = checkedFile(uri);
        String[] columns = projection == null
                ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE } : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        if (!apk.isFile()) return cursor;
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : columns) {
            if (OpenableColumns.DISPLAY_NAME.equals(column)) row.add(apk.getName());
            else if (OpenableColumns.SIZE.equals(column)) row.add(apk.length());
            else row.add(null);
        }
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
