package com.odomiles.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Trips live in a JSON file on the phone. Nothing leaves the device. */
final class TripStore {
    private static final Object LOCK = new Object();

    private TripStore() {}

    private static File tripsFile(Context c) {
        return new File(c.getFilesDir(), "trips.json");
    }

    static File currentFile(Context c) {
        return new File(c.getFilesDir(), "current_trip.json");
    }

    static JSONArray all(Context c) {
        synchronized (LOCK) {
            return readArray(tripsFile(c));
        }
    }

    static void add(Context c, JSONObject trip) {
        synchronized (LOCK) {
            JSONArray a = readArray(tripsFile(c));
            a.put(trip);
            writeText(tripsFile(c), a.toString());
        }
    }

    /** Adds trips entered by hand or imported. Skips ids already saved. Returns how many were added. */
    static int addMany(Context c, JSONArray incoming) {
        synchronized (LOCK) {
            JSONArray a = readArray(tripsFile(c));
            java.util.HashSet<String> have = new java.util.HashSet<>();
            for (int i = 0; i < a.length(); i++) {
                JSONObject t = a.optJSONObject(i);
                if (t != null) have.add(t.optString("id"));
            }
            int n = 0;
            for (int i = 0; i < incoming.length(); i++) {
                JSONObject t = incoming.optJSONObject(i);
                if (t == null || t.optString("id").isEmpty() || have.contains(t.optString("id"))) continue;
                a.put(t);
                have.add(t.optString("id"));
                n++;
            }
            writeText(tripsFile(c), a.toString());
            return n;
        }
    }

    static boolean update(Context c, String id, String type, String purpose) {
        return update(c, id, type, purpose, null);
    }

    /** Pass null for a field to leave it unchanged. */
    static boolean update(Context c, String id, String type, String purpose, Double miles) {
        synchronized (LOCK) {
            JSONArray a = readArray(tripsFile(c));
            for (int i = 0; i < a.length(); i++) {
                JSONObject t = a.optJSONObject(i);
                if (t != null && id.equals(t.optString("id"))) {
                    try {
                        if (type != null) t.put("type", type);
                        if (purpose != null) t.put("purpose", purpose);
                        if (miles != null && miles >= 0) t.put("miles", Math.round(miles * 100) / 100.0);
                    } catch (Exception e) {
                        return false;
                    }
                    writeText(tripsFile(c), a.toString());
                    return true;
                }
            }
            return false;
        }
    }

    static boolean delete(Context c, String id) {
        synchronized (LOCK) {
            JSONArray a = readArray(tripsFile(c));
            JSONArray out = new JSONArray();
            boolean found = false;
            for (int i = 0; i < a.length(); i++) {
                JSONObject t = a.optJSONObject(i);
                if (t != null && id.equals(t.optString("id"))) {
                    found = true;
                } else if (t != null) {
                    out.put(t);
                }
            }
            if (found) writeText(tripsFile(c), out.toString());
            return found;
        }
    }

    static JSONObject readObject(File f) {
        try {
            String s = readText(f);
            return s == null ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONArray readArray(File f) {
        try {
            String s = readText(f);
            return s == null ? new JSONArray() : new JSONArray(s);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static String readText(File f) {
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    /** Write to a temp file first so a crash mid-write can't corrupt the trip log. */
    static void writeText(File f, String s) {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(s.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (Exception e) {
            return;
        }
        if (!tmp.renameTo(f)) {
            f.delete();
            tmp.renameTo(f);
        }
    }
}
