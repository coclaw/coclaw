package net.coclaw.im;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.oss.licenses.OssLicensesMenuActivity;

/**
 * Capacitor 插件：打开 Google oss-licenses 标准开源许可界面，
 * 展示构建期收集的 Maven（原生）依赖许可证（res/raw/third_party_licenses）。
 *
 * Web 端用法：
 *   const OssLicenses = registerPlugin('OssLicenses');
 *   await OssLicenses.open({ title: 'Open Source Licenses' });
 */
@CapacitorPlugin(name = "OssLicenses")
public class OssLicensesPlugin extends Plugin {

	@PluginMethod
	public void open(PluginCall call) {
		String title = call.getString("title", "Open Source Licenses");
		OssLicensesMenuActivity.setActivityTitle(title);
		Intent intent = new Intent(getContext(), OssLicensesMenuActivity.class);
		getActivity().startActivity(intent);
		call.resolve();
	}
}
