package com.odomiles.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OdoTrackerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
