# Android Release 配置记录

> 首次配置时间：2026-03-10

## 配置结果

| 项目 | 状态 |
|------|------|
| Keystore | `android/app/keystore/coclaw-release.jks`（已被 .gitignore 排除） |
| 签名配置 | `build.gradle` 从 `local.properties` 读取密码（不入库） |
| 签名格式 | PKCS12（keytool 默认），keystore 和 key 共用同一密码 |
| versionName | `0.2.0` |
| versionCode | `1` |
| applicationId | `net.coclaw.im` |
| allowBackup | `false` |
| minifyEnabled | `false`（Capacitor 壳层代码极少，无需混淆） |
| 权限 | INTERNET, CAMERA, RECORD_AUDIO, READ_MEDIA_IMAGES, READ/WRITE_EXTERNAL_STORAGE（≤Android 12） |
| Release APK | 构建成功，约 6.1MB |

## 签名指纹（备案用）

- **SHA1**: `0F:DD:03:B4:8F:6A:53:E0:33:37:6B:FB:D0:85:B4:D8:4D:4F:17:F5`
- **SHA256**: `44:BE:2C:83:70:34:C4:BB:AA:A5:DB:4C:01:4D:0B:81:E2:9F:D9:0A:39:64:DE:0B:CA:E4:42:B2:11:DC:A4:41`
- **MD5**: `36:17:79:B5:BD:7D:17:04:24:CC:B0:5A:E6:0A:DB:BF`

## 发布主体

成都公演科技有限公司（Chengdu Gongyan Technology Co., Ltd.）

## 密码

Keystore 密码：`xxx`（keystore 和 key 共用）

> 此密码应妥善保管于密码管理器中，丢失后无法恢复 keystore 访问权限。

## APK 构建命令

```bash
cd ui/android && ./gradlew assembleRelease
```

产出路径：`android/app/build/outputs/apk/release/app-release.apk`

## TODO（上架应用商店前）

- [ ] 工信部 App 备案（签名指纹见上方）
- [ ] 隐私政策页面（需提供 URL）
- [ ] 用户服务协议页面（需提供 URL）
- [ ] App 首次启动隐私政策弹窗同意（前端开发）
- [ ] 应用商店素材：应用截图、简介、分类、目标用户年龄段
- [ ] 第三方 SDK 清单（国内商店合规要求）
