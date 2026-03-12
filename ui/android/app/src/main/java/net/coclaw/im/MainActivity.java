package net.coclaw.im;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		registerPlugin(KeepAlivePlugin.class);
		super.onCreate(savedInstanceState);
	}
}
