package com.odomiles.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Drive detection is cleared on reboot or app update, so turn it back on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            if (Prefs.isAuto(context)) Transitions.register(context);
        }
    }
}
