package net.coclaw.im;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * 前台服务：App 切到后台时保持进程存活，防止被系统杀死。
 * 通过 Web 端 JS 调用 KeepAlivePlugin 来启停。
 */
public class KeepAliveService extends Service {

	private static final String CHANNEL_ID = "coclaw_keep_alive";
	private static final int NOTIFICATION_ID = 1;
	private PowerManager.WakeLock wakeLock;

	@Override
	public void onCreate() {
		super.onCreate();
		createNotificationChannel();
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		Notification notification = buildNotification();
		startForeground(NOTIFICATION_ID, notification);
		acquireWakeLock();
		return START_STICKY;
	}

	@Override
	public void onDestroy() {
		releaseWakeLock();
		super.onDestroy();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}

	private void createNotificationChannel() {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			NotificationChannel channel = new NotificationChannel(
				CHANNEL_ID,
				"CoClaw Background Service",
				NotificationManager.IMPORTANCE_LOW
			);
			channel.setDescription("Keeps CoClaw connected in the background");
			channel.setShowBadge(false);
			NotificationManager manager = getSystemService(NotificationManager.class);
			if (manager != null) {
				manager.createNotificationChannel(channel);
			}
		}
	}

	private Notification buildNotification() {
		Intent notificationIntent = new Intent(this, MainActivity.class);
		PendingIntent pendingIntent = PendingIntent.getActivity(
			this, 0, notificationIntent,
			PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
		);

		return new NotificationCompat.Builder(this, CHANNEL_ID)
			.setContentTitle("CoClaw")
			.setContentText("Running in background")
			.setSmallIcon(android.R.drawable.ic_dialog_info)
			.setContentIntent(pendingIntent)
			.setOngoing(true)
			.build();
	}

	private void acquireWakeLock() {
		PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
		if (powerManager != null) {
			wakeLock = powerManager.newWakeLock(
				PowerManager.PARTIAL_WAKE_LOCK,
				"CoClaw::KeepAliveWakeLock"
			);
			wakeLock.acquire();
		}
	}

	private void releaseWakeLock() {
		if (wakeLock != null && wakeLock.isHeld()) {
			wakeLock.release();
			wakeLock = null;
		}
	}
}
