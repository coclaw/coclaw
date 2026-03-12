package net.coclaw.im;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor 插件：JS 桥接层，供 Web 端控制 KeepAliveService 启停。
 *
 * Web 端用法：
 *   import { registerPlugin } from '@capacitor/core';
 *   const KeepAlive = registerPlugin('KeepAlive');
 *   await KeepAlive.start();
 *   await KeepAlive.stop();
 */
@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {

	@PluginMethod
	public void start(PluginCall call) {
		Intent intent = new Intent(getContext(), KeepAliveService.class);
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			getContext().startForegroundService(intent);
		} else {
			getContext().startService(intent);
		}
		call.resolve();
	}

	@PluginMethod
	public void stop(PluginCall call) {
		Intent intent = new Intent(getContext(), KeepAliveService.class);
		getContext().stopService(intent);
		call.resolve();
	}
}
