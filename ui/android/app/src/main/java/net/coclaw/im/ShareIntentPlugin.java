package net.coclaw.im;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Capacitor 插件：接收外部 App 分享的文本/文件，桥接给 JS 层。
 *
 * 支持场景：
 * - 冷启动：JS 调用 checkPending() 获取启动时携带的分享数据
 * - 热启动：通过 handleOnNewIntent → 事件 "shareReceived" 推送给 JS
 *
 * Web 端用法：
 *   import { registerPlugin } from '@capacitor/core';
 *   const ShareIntent = registerPlugin('ShareIntent');
 *   // 冷启动：主动查询
 *   const pending = await ShareIntent.checkPending();
 *   // 热启动：监听事件
 *   ShareIntent.addListener('shareReceived', (data) => { ... });
 *   // 消费完毕后清理临时文件
 *   await ShareIntent.clearFiles();
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

	/** 临时文件存放子目录 */
	private static final String SHARE_DIR = "share_intent";

	/** 缓存的待消费分享数据（冷启动 & 热启动共用） */
	private JSObject pendingShare = null;

	/** 当前批次的临时文件路径，用于清理 */
	private final List<File> tempFiles = new ArrayList<>();

	// --- 生命周期 ---

	@Override
	public void load() {
		// 冷启动：检查启动 intent 是否携带分享数据
		handleIntent(getActivity().getIntent());
	}

	@Override
	protected void handleOnNewIntent(Intent intent) {
		// 热启动：App 已在前台，收到新的分享 intent
		// 先清空旧数据，避免非分享 intent 触发时推送过期数据
		pendingShare = null;
		handleIntent(intent);
		if (pendingShare != null) {
			notifyListeners("shareReceived", pendingShare);
		}
	}

	// --- JS 桥接方法 ---

	/**
	 * 查询并消费冷启动时缓存的分享数据。
	 * 返回后清空缓存，避免重复消费。
	 */
	@PluginMethod
	public void checkPending(PluginCall call) {
		if (pendingShare != null) {
			JSObject result = pendingShare;
			pendingShare = null;
			call.resolve(result);
		} else {
			call.resolve(new JSObject());
		}
	}

	/**
	 * 清理本插件创建的分享临时文件。
	 * JS 侧在将文件转为 Blob 后应调用此方法。
	 */
	@PluginMethod
	public void clearFiles(PluginCall call) {
		cleanTempFiles();
		call.resolve();
	}

	// --- Intent 解析 ---

	private void handleIntent(Intent intent) {
		if (intent == null) return;
		String action = intent.getAction();
		String type = intent.getType();
		if (action == null || type == null) return;

		// 新一轮分享，先清理上一批临时文件
		cleanTempFiles();

		if (Intent.ACTION_SEND.equals(action)) {
			if (type.startsWith("text/")) {
				handleTextShare(intent);
			} else {
				// image/* 或其他文件类型，统一走文件处理
				handleSingleFileShare(intent);
			}
		} else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
			handleMultiFileShare(intent);
		}
	}

	// --- 文本分享 ---

	private void handleTextShare(Intent intent) {
		String text = intent.getStringExtra(Intent.EXTRA_TEXT);
		if (text == null || text.isEmpty()) return;

		JSObject data = new JSObject();
		data.put("type", "text");
		data.put("text", text);
		pendingShare = data;
	}

	// --- 单文件分享 ---

	@SuppressWarnings("deprecation")
	private void handleSingleFileShare(Intent intent) {
		Uri uri = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
			? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
			: intent.getParcelableExtra(Intent.EXTRA_STREAM);
		if (uri == null) return;

		JSObject fileInfo = resolveContentUri(uri);
		if (fileInfo == null) return;

		JSObject data = new JSObject();
		data.put("type", "file");
		JSArray files = new JSArray();
		files.put(fileInfo);
		data.put("files", files);
		pendingShare = data;
	}

	// --- 多文件分享 ---

	@SuppressWarnings("deprecation")
	private void handleMultiFileShare(Intent intent) {
		ArrayList<Uri> uris = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
			? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
			: intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
		if (uris == null || uris.isEmpty()) return;

		JSArray files = new JSArray();
		for (Uri uri : uris) {
			JSObject fileInfo = resolveContentUri(uri);
			if (fileInfo != null) {
				files.put(fileInfo);
			}
		}

		if (files.length() == 0) return;

		JSObject data = new JSObject();
		data.put("type", "file");
		data.put("files", files);
		pendingShare = data;
	}

	// --- content:// → 临时文件 ---

	/**
	 * 将 content:// URI 通过 ContentResolver 读取，写入 cacheDir 临时文件，
	 * 返回文件元信息（路径、文件名、mimeType、大小）供 JS 消费。
	 */
	private JSObject resolveContentUri(Uri uri) {
		ContentResolver resolver = getContext().getContentResolver();
		String mimeType = resolver.getType(uri);

		// 查询文件名和大小
		String fileName = null;
		long fileSize = -1;
		try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
			if (cursor != null && cursor.moveToFirst()) {
				int nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
				int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
				if (nameIdx >= 0) fileName = cursor.getString(nameIdx);
				if (sizeIdx >= 0) fileSize = cursor.getLong(sizeIdx);
			}
		} catch (Exception e) {
			// 查询失败时使用兜底文件名
		}

		// 兜底文件名
		if (fileName == null || fileName.isEmpty()) {
			String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType);
			fileName = "shared_" + System.currentTimeMillis() + (ext != null ? "." + ext : "");
		}

		// 写入临时文件
		File shareDir = new File(getContext().getCacheDir(), SHARE_DIR);
		if (!shareDir.exists()) shareDir.mkdirs();

		// 文件名加时间戳前缀避免冲突
		File tempFile = new File(shareDir, System.currentTimeMillis() + "_" + fileName);

		try (InputStream in = resolver.openInputStream(uri);
			 OutputStream out = new FileOutputStream(tempFile)) {
			if (in == null) return null;
			byte[] buf = new byte[8192];
			int len;
			while ((len = in.read(buf)) != -1) {
				out.write(buf, 0, len);
			}
		} catch (Exception e) {
			tempFile.delete();
			return null;
		}

		tempFiles.add(tempFile);

		JSObject info = new JSObject();
		info.put("path", tempFile.getAbsolutePath());
		info.put("name", fileName);
		info.put("mimeType", mimeType != null ? mimeType : "application/octet-stream");
		if (fileSize >= 0) info.put("size", fileSize);
		return info;
	}

	// --- 临时文件清理 ---

	private void cleanTempFiles() {
		for (File f : tempFiles) {
			if (f.exists()) f.delete();
		}
		tempFiles.clear();

		// 清理整个 share_intent 目录下的残留（防止异常退出遗留）
		File shareDir = new File(getContext().getCacheDir(), SHARE_DIR);
		if (shareDir.exists()) {
			File[] files = shareDir.listFiles();
			if (files != null) {
				for (File f : files) f.delete();
			}
		}
	}
}
