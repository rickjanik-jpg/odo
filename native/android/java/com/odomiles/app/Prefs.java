package com.odomiles.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

/** Small settings the native side needs even when the app screen is closed. */
final class Prefs {
    /** Automatic trips shorter than this are dropped (parking lot shuffles, GPS noise). */
    static final double MIN_AUTO_MILES = 0.25;

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("odo_prefs", Context.MODE_PRIVATE);
    }

    static boolean isAuto(Context c) {
        return sp(c).getBoolean("auto", false);
    }

    static void setAuto(Context c, boolean on) {
        sp(c).edit().putBoolean("auto", on).apply();
    }

    static String prompt(Context c) {
        return sp(c).getString("prompt", "Are you dashing?");
    }

    static void setPrompt(Context c, String prompt) {
        sp(c).edit().putString("prompt", prompt).apply();
    }

    static List<String> gigs(Context c) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(sp(c).getString("gigs", "[\"DoorDash\"]"));
            for (int i = 0; i < a.length(); i++) {
                String g = a.optString(i, "").trim();
                if (!g.isEmpty()) out.add(g);
            }
        } catch (Exception ignored) {
            out.add("DoorDash");
        }
        return out;
    }

    static String gigsJson(Context c) {
        return sp(c).getString("gigs", "[\"DoorDash\"]");
    }

    static void setGigs(Context c, String json) {
        sp(c).edit().putString("gigs", json).apply();
    }
}
