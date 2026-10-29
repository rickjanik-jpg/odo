package com.odomiles.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionEvent;
import com.google.android.gms.location.ActivityTransitionResult;
import com.google.android.gms.location.DetectedActivity;

/** Starts recording when driving begins; flags the end when driving stops. */
public class TransitionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return;
        if (!Prefs.isAuto(context)) return;
        ActivityTransitionResult result = ActivityTransitionResult.extractResult(intent);
        if (result == null) return;

        ActivityTransitionEvent last = null;
        for (ActivityTransitionEvent e : result.getTransitionEvents()) {
            if (e.getActivityType() == DetectedActivity.IN_VEHICLE) last = e;
        }
        if (last == null) return;

        if (last.getTransitionType() == ActivityTransition.ACTIVITY_TRANSITION_ENTER) {
            try {
                TrackingService.start(context, TrackingService.ACTION_AUTO_START);
            } catch (Exception ignored) {
                // Android refused to start the service (rare); the next drive will try again.
            }
        } else {
            TrackingService s = TrackingService.instance;
            if (s != null) s.onVehicleExit();
        }
    }
}
