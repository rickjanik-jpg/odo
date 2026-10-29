package com.odomiles.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.UUID;

/**
 * Records one drive at a time with GPS. Runs as a foreground service so it keeps
 * going with the screen off. GPS only runs while a drive is being recorded.
 */
public class TrackingService extends Service {
    public static final String ACTION_AUTO_START = "com.odomiles.app.AUTO_START";
    public static final String ACTION_MANUAL_START = "com.odomiles.app.MANUAL_START";
    public static final String ACTION_STOP = "com.odomiles.app.STOP";

    private static final long CHECK_MS = 30_000;
    /** After Android says driving stopped, end the trip once we've been still this long. */
    private static final long IDLE_AFTER_EXIT_MS = 2 * 60_000;
    /** Safety net if the "stopped driving" signal never arrives. */
    private static final long IDLE_MAX_MS = 6 * 60_000;
    /** A saved in-progress trip newer than this is resumed after a restart. */
    private static final long RESUME_WINDOW_MS = 15 * 60_000;
    /** How old the phone's last known location may be to use as the trip start. */
    private static final long SEED_MAX_AGE_MS = 5 * 60_000;
    private static final int MAX_STORED_POINTS = 300;

    static volatile TrackingService instance;

    private FusedLocationProviderClient fused;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private boolean active = false;
    private boolean manual = false;
    private boolean exitSignaled = false;
    private boolean updatesOn = false;
    private String tripId;
    private long startTime;
    private long lastMoveTime;
    private double meters = 0;
    private Location anchor;
    private final ArrayList<double[]> path = new ArrayList<>();
    private int sinceSave = 0;
    private double lastShownMiles = -1;

    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            for (Location l : result.getLocations()) onFix(l);
        }
    };

    private final Runnable checker = new Runnable() {
        @Override
        public void run() {
            check();
            if (active) handler.postDelayed(this, CHECK_MS);
        }
    };

    // ---- Static helpers used by the plugin and receivers ----

    static void start(Context c, String action) {
        ContextCompat.startForegroundService(c, new Intent(c, TrackingService.class).setAction(action));
    }

    static boolean isTracking() {
        TrackingService s = instance;
        return s != null && s.active;
    }

    static boolean isManualTrip() {
        TrackingService s = instance;
        return s != null && s.active && s.manual;
    }

    static double currentMiles() {
        TrackingService s = instance;
        return (s != null && s.active) ? s.meters / 1609.344 : 0;
    }

    static long currentStart() {
        TrackingService s = instance;
        return (s != null && s.active) ? s.startTime : 0;
    }

    // ---- Lifecycle ----

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        fused = LocationServices.getFusedLocationProviderClient(this);
        Notifs.ensureChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            if (active) {
                manual = true; // stopping by hand: end time is now, keep short trips
                finish();
            } else {
                stopSelfSafe();
            }
            return START_NOT_STICKY;
        }

        if (!goForeground()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (active) {
            if (ACTION_MANUAL_START.equals(action)) manual = true;
            exitSignaled = false; // driving again (or user pressed Start)
        } else if (!resumeSaved()) {
            if (action == null) { // restarted by Android with nothing to resume
                stopSelfSafe();
                return START_NOT_STICKY;
            }
            beginTrip(ACTION_MANUAL_START.equals(action));
        }

        if (!startUpdates()) {
            active = false;
            TripStore.currentFile(this).delete();
            stopSelfSafe();
            OdoTrackerPlugin.emitState();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(checker);
        handler.postDelayed(checker, CHECK_MS);
        refreshOngoing(true);
        OdoTrackerPlugin.emitState();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (active) saveCurrent(); // resumed on restart if Android kills us
        stopUpdates();
        handler.removeCallbacksAndMessages(null);
        instance = null;
        OdoTrackerPlugin.emitState();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Called when Android reports the phone left the vehicle. */
    void onVehicleExit() {
        if (active && !manual) exitSignaled = true;
    }

    // ---- Trip recording ----

    private boolean goForeground() {
        try {
            int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, Notifs.ONGOING_ID,
                    Notifs.ongoing(this, currentMiles(), manual), type);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void beginTrip(boolean byHand) {
        active = true;
        manual = byHand;
        exitSignaled = false;
        tripId = UUID.randomUUID().toString();
        startTime = System.currentTimeMillis();
        lastMoveTime = startTime;
        meters = 0;
        anchor = null;
        path.clear();
        sinceSave = 0;
        lastShownMiles = -1;

        // Drive detection takes a moment, so start the trip where the phone last was.
        try {
            fused.getLastLocation().addOnSuccessListener(loc -> {
                if (loc == null || !active || anchor != null) return;
                long age = System.currentTimeMillis() - loc.getTime();
                if (age <= SEED_MAX_AGE_MS && loc.getAccuracy() <= 100) {
                    anchor = loc;
                    path.add(new double[]{loc.getLatitude(), loc.getLongitude()});
                }
            });
        } catch (SecurityException ignored) {
        }
    }

    private boolean startUpdates() {
        if (updatesOn) return true;
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 4000)
                .setMinUpdateIntervalMillis(2000)
                .setMinUpdateDistanceMeters(5)
                .build();
        try {
            fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
            updatesOn = true;
            return true;
        } catch (SecurityException e) {
            return false;
        }
    }

    private void stopUpdates() {
        if (!updatesOn) return;
        fused.removeLocationUpdates(callback);
        updatesOn = false;
    }

    private void onFix(Location l) {
        if (!active) return;
        long now = System.currentTimeMillis();
        float acc = l.hasAccuracy() ? l.getAccuracy() : 50f;

        if (anchor == null) {
            if (acc <= 100) {
                anchor = l;
                path.add(new double[]{l.getLatitude(), l.getLongitude()});
                lastMoveTime = now;
            }
            return;
        }
        if (acc > 40) return; // too fuzzy to count

        float d = anchor.distanceTo(l);
        if (d < Math.max(20f, acc)) return; // GPS jitter while parked

        long dtMs = Math.max(1000, l.getTime() - anchor.getTime());
        double speed = d / (dtMs / 1000.0);
        if (speed > 70 && dtMs < 60_000) return; // impossible jump (~155 mph)

        meters += d;
        anchor = l;
        path.add(new double[]{l.getLatitude(), l.getLongitude()});
        lastMoveTime = now;

        if (++sinceSave >= 10) {
            sinceSave = 0;
            saveCurrent();
        }
        refreshOngoing(false);
    }

    private void check() {
        if (!active || manual) return;
        long idle = System.currentTimeMillis() - lastMoveTime;
        if ((exitSignaled && idle >= IDLE_AFTER_EXIT_MS) || idle >= IDLE_MAX_MS) finish();
    }

    private void refreshOngoing(boolean force) {
        double miles = currentMiles();
        if (!force && miles - lastShownMiles < 0.1) return;
        lastShownMiles = miles;
        try {
            NotificationManagerCompat.from(this).notify(Notifs.ONGOING_ID, Notifs.ongoing(this, miles, manual));
        } catch (SecurityException ignored) {
        }
        OdoTrackerPlugin.emitState();
    }

    private void finish() {
        finalizeTrip();
        stopSelfSafe();
    }

    /** Ends the current trip, saves it if it's long enough, and asks Work or Personal. */
    private void finalizeTrip() {
        if (!active) return;
        active = false;
        stopUpdates();
        handler.removeCallbacks(checker);
        TripStore.currentFile(this).delete();

        double miles = meters / 1609.344;
        boolean keep = manual ? miles >= 0.05 : miles >= Prefs.MIN_AUTO_MILES;
        if (keep) {
            long end = manual ? System.currentTimeMillis() : lastMoveTime;
            JSONObject trip = buildTrip(miles, end);
            if (trip != null) {
                TripStore.add(this, trip);
                Notifs.promptTrip(this, trip);
            }
        }
        OdoTrackerPlugin.emitChanged();
        OdoTrackerPlugin.emitState();
    }

    private JSONObject buildTrip(double miles, long end) {
        try {
            JSONObject t = new JSONObject();
            t.put("id", tripId);
            t.put("start", startTime);
            t.put("end", Math.max(end, startTime));
            t.put("miles", Math.round(miles * 100) / 100.0);
            t.put("type", "pending");
            t.put("purpose", "");
            t.put("manual", manual);
            JSONArray p = new JSONArray();
            int step = Math.max(1, (int) Math.ceil(path.size() / (double) MAX_STORED_POINTS));
            for (int i = 0; i < path.size(); i += step) p.put(point(path.get(i)));
            if (!path.isEmpty() && (path.size() - 1) % step != 0) p.put(point(path.get(path.size() - 1)));
            t.put("path", p);
            return t;
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONArray point(double[] ll) throws org.json.JSONException {
        return new JSONArray()
                .put(Math.round(ll[0] * 1e5) / 1e5)
                .put(Math.round(ll[1] * 1e5) / 1e5);
    }

    // ---- Survive Android killing the service mid-drive ----

    private void saveCurrent() {
        try {
            JSONObject o = new JSONObject();
            o.put("id", tripId);
            o.put("start", startTime);
            o.put("manual", manual);
            o.put("meters", meters);
            o.put("lastMove", lastMoveTime);
            o.put("savedAt", System.currentTimeMillis());
            JSONArray p = new JSONArray();
            for (double[] ll : path) p.put(point(ll));
            o.put("path", p);
            if (anchor != null) {
                o.put("aLat", anchor.getLatitude());
                o.put("aLng", anchor.getLongitude());
                o.put("aTime", anchor.getTime());
            }
            TripStore.writeText(TripStore.currentFile(this), o.toString());
        } catch (Exception ignored) {
        }
    }

    /** Returns true if a recent in-progress trip was picked back up. */
    private boolean resumeSaved() {
        File f = TripStore.currentFile(this);
        if (!f.exists()) return false;
        JSONObject o = TripStore.readObject(f);
        if (o == null) {
            f.delete();
            return false;
        }
        tripId = o.optString("id", UUID.randomUUID().toString());
        startTime = o.optLong("start", System.currentTimeMillis());
        manual = o.optBoolean("manual", false);
        meters = o.optDouble("meters", 0);
        lastMoveTime = o.optLong("lastMove", startTime);
        exitSignaled = false;
        path.clear();
        JSONArray p = o.optJSONArray("path");
        if (p != null) {
            for (int i = 0; i < p.length(); i++) {
                JSONArray ll = p.optJSONArray(i);
                if (ll != null) path.add(new double[]{ll.optDouble(0), ll.optDouble(1)});
            }
        }
        anchor = null;
        if (o.has("aLat")) {
            Location a = new Location("saved");
            a.setLatitude(o.optDouble("aLat"));
            a.setLongitude(o.optDouble("aLng"));
            a.setTime(o.optLong("aTime", lastMoveTime));
            a.setAccuracy(20);
            anchor = a;
        }
        active = true;

        if (System.currentTimeMillis() - o.optLong("savedAt", 0) <= RESUME_WINDOW_MS) {
            return true;
        }
        finalizeTrip(); // too old to continue: save what we have as its own trip
        return false;
    }

    private void stopSelfSafe() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
}
