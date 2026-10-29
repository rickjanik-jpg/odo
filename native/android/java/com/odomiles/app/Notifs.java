package com.odomiles.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

final class Notifs {
    static final String CH_TRACKING = "tracking";
    static final String CH_TRIPS = "trips";
    static final int ONGOING_ID = 1001;

    private Notifs() {}

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel tracking = new NotificationChannel(
                CH_TRACKING, "Drive recording", NotificationManager.IMPORTANCE_LOW);
        tracking.setDescription("Shown while a drive is being recorded");
        nm.createNotificationChannel(tracking);
        NotificationChannel trips = new NotificationChannel(
                CH_TRIPS, "Trip questions", NotificationManager.IMPORTANCE_HIGH);
        trips.setDescription("Asks whether a finished drive was for work");
        nm.createNotificationChannel(trips);
    }

    static int tripNotificationId(String tripId) {
        return 2000 + (tripId.hashCode() & 0x0fffffff);
    }

    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The quiet, ongoing notification Android requires while GPS runs in the background. */
    static Notification ongoing(Context c, double miles, boolean manual) {
        Intent stop = new Intent(c, TrackingService.class).setAction(TrackingService.ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(c, 1, stop,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = String.format(Locale.US, "%.1f mi so far", miles) + (manual ? " · started by you" : "");
        return new NotificationCompat.Builder(c, CH_TRACKING)
                .setSmallIcon(R.drawable.ic_odo)
                .setContentTitle("Recording a drive")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(openApp(c))
                .addAction(0, "Stop", stopPi)
                .build();
    }

    /** "Was this drive for work?" with Work / Personal, or one button per work label. */
    static void promptTrip(Context c, JSONObject trip) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c,
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        String id = trip.optString("id");
        int nid = tripNotificationId(id);
        DateFormat tf = DateFormat.getTimeInstance(DateFormat.SHORT);
        String text = String.format(Locale.US, "%.1f mi · %s – %s",
                trip.optDouble("miles", 0),
                tf.format(new Date(trip.optLong("start"))),
                tf.format(new Date(trip.optLong("end"))));

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_TRIPS)
                .setSmallIcon(R.drawable.ic_odo)
                .setContentTitle(Prefs.prompt(c))
                .setContentText(text)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(openApp(c));

        List<String> gigs = Prefs.gigs(c);
        if (gigs.size() <= 1) {
            String g = gigs.isEmpty() ? "Work" : gigs.get(0);
            b.addAction(0, g, action(c, id, nid, 1, "work", g));
        } else {
            // Android shows at most three buttons: two gigs plus No.
            for (int i = 0; i < Math.min(2, gigs.size()); i++) {
                b.addAction(0, gigs.get(i), action(c, id, nid, i + 1, "work", gigs.get(i)));
            }
        }
        b.addAction(0, "Personal", action(c, id, nid, 9, "personal", ""));

        try {
            NotificationManagerCompat.from(c).notify(nid, b.build());
        } catch (SecurityException ignored) {
        }
    }

    private static PendingIntent action(Context c, String tripId, int nid, int slot, String type, String purpose) {
        Intent i = new Intent(c, TripActionReceiver.class)
                .putExtra(TripActionReceiver.EXTRA_TRIP, tripId)
                .putExtra(TripActionReceiver.EXTRA_TYPE, type)
                .putExtra(TripActionReceiver.EXTRA_PURPOSE, purpose);
        int requestCode = nid * 10 + slot; // unique per trip and button
        return PendingIntent.getBroadcast(c, requestCode, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
