package com.odomiles.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionRequest;
import com.google.android.gms.location.DetectedActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * Asks Android to tell us when the phone starts or stops riding in a vehicle.
 * Uses motion sensors, not GPS, so it costs almost no battery while idle.
 */
final class Transitions {
    private Transitions() {}

    static boolean hasPermission(Context c) {
        if (Build.VERSION.SDK_INT < 29) return true; // granted at install on older Android
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static PendingIntent pendingIntent(Context c) {
        Intent i = new Intent(c, TransitionReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE; // results are added to the intent
        return PendingIntent.getBroadcast(c, 42, i, flags);
    }

    @SuppressLint("MissingPermission")
    static void register(Context c) {
        if (!hasPermission(c)) return;
        List<ActivityTransition> list = new ArrayList<>();
        list.add(new ActivityTransition.Builder()
                .setActivityType(DetectedActivity.IN_VEHICLE)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                .build());
        list.add(new ActivityTransition.Builder()
                .setActivityType(DetectedActivity.IN_VEHICLE)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
                .build());
        try {
            ActivityRecognition.getClient(c)
                    .requestActivityTransitionUpdates(new ActivityTransitionRequest(list), pendingIntent(c));
        } catch (SecurityException ignored) {
        }
    }

    @SuppressLint("MissingPermission")
    static void unregister(Context c) {
        try {
            ActivityRecognition.getClient(c).removeActivityTransitionUpdates(pendingIntent(c));
        } catch (SecurityException ignored) {
        }
    }
}
