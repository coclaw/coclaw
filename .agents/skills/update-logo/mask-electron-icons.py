#!/usr/bin/env python3
# 仅为 Electron 的 .ico / .icns 烘焙圆角中间图：
#   win  -> 全幅圆角矩形（圆角半径 = 22% 边长，仅四角透明）
#   mac  -> 方圆贴片（superellipse n=5，贴片 = 画布 80%，外边 ~10% 透明，
#           内容裁到 bbox + 4% 呼吸边后最长边填满贴片 90%）
#
# 硬规则：绝不在此处理共享 master（icon.png / public/* / android / ios / tauri）——
# 它们必须保持方形满幅，由各 OS 自行套遮罩。本脚本只输出 Electron 用的两张中间图。
#
# 用法: python3 mask-electron-icons.py <src.png> <out_win.png> <out_mac.png>
import sys
import numpy as np
from PIL import Image, ImageDraw

SS = 4  # 4x 超采样后 LANCZOS 缩小，保证边缘平滑


def detect_bg(im):
	"""取四角均值作背景（navy）色，用于方圆贴片填充以与裁切区无缝拼接。"""
	px = im.load()
	W, H = im.size
	cs = [px[0, 0], px[W - 1, 0], px[0, H - 1], px[W - 1, H - 1]]
	return tuple(round(sum(c[i] for c in cs) / len(cs)) for i in range(3))


def content_bbox(im, bg, tol=16):
	"""非背景内容 bbox（含端点）。"""
	a = np.asarray(im.convert("RGB"), dtype=np.int16)
	diff = np.abs(a - np.array(bg, dtype=np.int16)).max(axis=2)
	ys, xs = np.where(diff > tol)
	return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def rounded_rect_alpha(size, radius_frac):
	hr = size * SS
	r = round(size * radius_frac) * SS
	m = Image.new("L", (hr, hr), 0)
	ImageDraw.Draw(m).rounded_rectangle((0, 0, hr - 1, hr - 1), radius=r, fill=255)
	return m.resize((size, size), Image.LANCZOS)


def squircle_alpha(size, tile_frac, n=5):
	hr = size * SS
	a = (size * tile_frac / 2.0) * SS
	c = (hr - 1) / 2.0
	ys, xs = np.mgrid[0:hr, 0:hr].astype(np.float64)
	v = (np.abs((xs - c) / a) ** n) + (np.abs((ys - c) / a) ** n)
	m = np.where(v <= 1.0, 255, 0).astype(np.uint8)
	return Image.fromarray(m, "L").resize((size, size), Image.LANCZOS)


def build_win(src, size=512):
	out = src.convert("RGBA").resize((size, size), Image.LANCZOS)
	out.putalpha(rounded_rect_alpha(size, 0.22))  # 圆角半径 = 22% 边长
	return out


def build_mac(src, size=1024):
	src = src.convert("RGBA")
	S = src.size[0]
	bg = detect_bg(src)
	x0, y0, x1, y1 = content_bbox(src, bg)
	bw, bh = (x1 - x0 + 1), (y1 - y0 + 1)
	dx, dy = 0.04 * bw, 0.04 * bh  # 四周各加 4% 呼吸边
	cb = (max(0, x0 - dx), max(0, y0 - dy), min(S, x1 + 1 + dx), min(S, y1 + 1 + dy))
	crop = src.crop((round(cb[0]), round(cb[1]), round(cb[2]), round(cb[3])))
	cw, ch = crop.size
	tile = size * 0.80                        # 方圆贴片 = 画布 80%
	scale = (tile * 0.90) / max(cw, ch)       # 裁切框最长边填满贴片 90%
	tw, th = round(cw * scale), round(ch * scale)
	crop = crop.resize((tw, th), Image.LANCZOS).convert("RGB")
	base = Image.new("RGB", (size, size), bg)
	base.paste(crop, ((size - tw) // 2, (size - th) // 2))
	out = base.convert("RGBA")
	out.putalpha(squircle_alpha(size, 0.80, n=5))
	return out


def main():
	if len(sys.argv) != 4:
		raise SystemExit("Usage: python3 mask-electron-icons.py <src.png> <out_win.png> <out_mac.png>")
	src_path, out_win, out_mac = sys.argv[1], sys.argv[2], sys.argv[3]
	src = Image.open(src_path)
	# 全流程按方形假设处理（build_win 直接 resize 会拉伸、build_mac 用宽度钳 bbox）——非方形先造方形 master
	if src.size[0] != src.size[1]:
		raise SystemExit("Source image must be square; create a square master before masking Electron icons.")
	build_win(src).save(out_win)      # 512x512
	build_mac(src).save(out_mac)      # 1024x1024，给 icns 更清晰


if __name__ == "__main__":
	main()
