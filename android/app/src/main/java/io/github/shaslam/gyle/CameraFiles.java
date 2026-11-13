package io.github.shaslam.gyle;

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

/**
 * Gives the camera app a file to write a new photo into, and lets the page read it afterwards.
 * The photos are in the app's cache folder: the page shrinks each one and keeps its own copy,
 * so a file here is only needed for a moment. Other apps reach a file only through an address
 * that this app handed to them for one use.
 */
public class CameraFiles extends ContentProvider {
    private static final String NAME = "photo-\\d+\\.jpg";
    private static final long KEEP_MS = 60 * 60 * 1000;

    private static File folder(Context c) {
        File dir = new File(c.getCacheDir(), "camera");
        dir.mkdirs();
        return dir;
    }

    /** The address of a new, empty photo. Photos from more than an hour ago are removed first. */
    static Uri fresh(Context c) {
        File[] old = folder(c).listFiles();
        long now = System.currentTimeMillis();
        if (old != null) for (File f : old) if (now - f.lastModified() > KEEP_MS) f.delete();
        return new Uri.Builder().scheme("content").authority(c.getPackageName() + ".camera").appendPath("photo-" + now + ".jpg").build();
    }

    /** True when the camera wrote a picture to this address. */
    static boolean hasPicture(Context c, Uri uri) {
        File f = file(c, uri);
        return f != null && f.length() > 0;
    }

    private static File file(Context c, Uri uri) {
        String name = uri.getLastPathSegment();
        return name != null && name.matches(NAME) ? new File(folder(c), name) : null;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = file(getContext(), uri);
        if (f == null) throw new FileNotFoundException(uri.toString());
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    /** The page asks for the name and size of a file it was given. */
    @Override
    public Cursor query(Uri uri, String[] columns, String selection, String[] args, String order) {
        File f = file(getContext(), uri);
        if (columns == null) columns = new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        MatrixCursor out = new MatrixCursor(columns, 1);
        if (f == null) return out;
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = f.length();
        }
        out.addRow(row);
        return out;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }
}
