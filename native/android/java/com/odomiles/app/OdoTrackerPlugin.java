package com.odomiles.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Bridge between the app screens (JavaScript) and the native tracker. */
@CapacitorPlugin(
        name = "OdoTracker",
        permissions = {
                @Permission(alias = "location", strings = {
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}),
                @Permission(alias = "background", strings = {Manifest.permission.ACCESS_BACKGROUND_LOCATION}),
                @Permission(alias = "activity", strings = {Manifest.permission.ACTIVITY_RECOGNITION}),
                @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
        })
public class OdoTrackerPlugin extends Plugin {
    private static volatile OdoTrackerPlugin current;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        current = this;
        Notifs.ensureChannels(getContext());
        if (Prefs.isAuto(getContext())) Transitions.register(getContext());
    }

    static void emitChanged() {
        MAIN.post(() -> {
            OdoTrackerPlugin p = current;
            if (p != null) p.notifyListeners("tripsChanged", new JSObject());
        });
    }

    static void emitState() {
        MAIN.post(() -> {
            OdoTrackerPlugin p = current;
            if (p != null) p.notifyListeners("trackingChanged", p.status());
        });
    }

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject status() {
        Context c = getContext();
        JSObject o = new JSObject();
        o.put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        o.put("background", Build.VERSION.SDK_INT < 29 || granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        o.put("activity", Transitions.hasPermission(c));
        o.put("notifications", Build.VERSION.SDK_INT < 33
                ? NotificationManagerCompat.from(c).areNotificationsEnabled()
                : granted(Manifest.permission.POST_NOTIFICATIONS));
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        o.put("batteryUnrestricted", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        o.put("auto", Prefs.isAuto(c));
        o.put("tracking", TrackingService.isTracking());
        o.put("manual", TrackingService.isManualTrip());
        o.put("miles", TrackingService.currentMiles());
        o.put("tripStart", TrackingService.currentStart());
        o.put("sdk", Build.VERSION.SDK_INT);
        return o;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void requestPerm(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null) {
            call.reject("alias is required");
            return;
        }
        requestPermissionForAlias(alias, call, "permDone");
    }

    @PermissionCallback
    private void permDone(PluginCall call) {
        if (Prefs.isAuto(getContext())) Transitions.register(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", getContext().getPackageName(), null));
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(fallback);
        }
        call.resolve();
    }

    @PluginMethod
    public void setAuto(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        Prefs.setAuto(getContext(), on);
        if (on) Transitions.register(getContext());
        else Transitions.unregister(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void startManual(PluginCall call) {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.reject("Location permission is needed first", "NO_LOCATION");
            return;
        }
        try {
            TrackingService.start(getContext(), TrackingService.ACTION_MANUAL_START);
            call.resolve(status());
        } catch (Exception e) {
            call.reject("Could not start recording: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopTrip(PluginCall call) {
        if (TrackingService.isTracking()) {
            getContext().startService(new Intent(getContext(), TrackingService.class)
                    .setAction(TrackingService.ACTION_STOP));
        }
        call.resolve();
    }

    @PluginMethod
    public void getTrips(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("trips", new JSArray(TripStore.all(getContext()).toString()));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not read trips");
        }
    }

    @PluginMethod
    public void updateTrip(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        String type = call.getString("type");
        String purpose = call.getString("purpose");
        Double miles = call.getDouble("miles");
        boolean ok = TripStore.update(getContext(), id, type, purpose, miles);
        if (type != null && !"pending".equals(type)) {
            NotificationManagerCompat.from(getContext()).cancel(Notifs.tripNotificationId(id));
        }
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void addTrips(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("json is required");
            return;
        }
        try {
            int n = TripStore.addMany(getContext(), new org.json.JSONArray(json));
            JSObject ret = new JSObject();
            ret.put("added", n);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Those trips couldn't be read");
        }
    }

    /** Writes a backup file and opens Android's share sheet (Drive, Files, email...). */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String name = call.getString("name");
        String text = call.getString("text");
        if (name == null || text == null) {
            call.reject("name and text are required");
            return;
        }
        try {
            java.io.File dir = new java.io.File(getContext().getCacheDir(), "share");
            dir.mkdirs();
            java.io.File f = new java.io.File(dir, name.replace('/', '-'));
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
                out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND)
                    .setType("application/json")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Save Odo backup");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            JSObject ret = new JSObject();
            ret.put("completed", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Couldn't create the backup file");
        }
    }

    @PluginMethod
    public void deleteTrip(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        NotificationManagerCompat.from(getContext()).cancel(Notifs.tripNotificationId(id));
        JSObject ret = new JSObject();
        ret.put("ok", TripStore.delete(getContext(), id));
        call.resolve(ret);
    }

    @PluginMethod
    public void getPrefs(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("prompt", Prefs.prompt(getContext()));
            ret.put("gigs", new JSArray(Prefs.gigsJson(getContext())));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not read settings");
        }
    }

    @PluginMethod
    public void setPrefs(PluginCall call) {
        String prompt = call.getString("prompt");
        if (prompt != null && !prompt.trim().isEmpty()) Prefs.setPrompt(getContext(), prompt.trim());
        JSArray gigs = call.getArray("gigs");
        if (gigs != null) Prefs.setGigs(getContext(), gigs.toString());
        call.resolve();
    }
}
