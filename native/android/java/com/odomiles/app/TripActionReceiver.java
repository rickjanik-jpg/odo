package com.odomiles.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

/** Handles the Yes / No (or gig name) buttons on the trip notification. */
public class TripActionReceiver extends BroadcastReceiver {
    static final String EXTRA_TRIP = "tripId";
    static final String EXTRA_TYPE = "type";
    static final String EXTRA_PURPOSE = "purpose";

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra(EXTRA_TRIP);
        if (id == null) return;
        String type = intent.getStringExtra(EXTRA_TYPE);
        String purpose = intent.getStringExtra(EXTRA_PURPOSE);
        TripStore.update(context, id, type, purpose == null ? "" : purpose);
        NotificationManagerCompat.from(context).cancel(Notifs.tripNotificationId(id));
        OdoTrackerPlugin.emitChanged();
    }
}
