package ph.research.csimonitor;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Small, deliberately narrow JavaScript bridge
 * (only the bundled page can reach it).
 */
class NativeBridge {

    private static final String CHANNEL = "csi_alerts";
    private static final int MAX_BYTES = 2 * 1024 * 1024;

    private final Activity activity;
    private int nextId = 100;

    NativeBridge(Activity a) {
        activity = a;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL,
                    "CSI alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );

            ch.setDescription(
                    "Presence-estimate and link alerts from the gateway"
            );

            ((NotificationManager) a.getSystemService(
                    Context.NOTIFICATION_SERVICE
            )).createNotificationChannel(ch);
        }
    }

    /**
     * Posts a notification.
     * Silently does nothing if the user denied notification permission.
     */
    @JavascriptInterface
    public void notify(String title, String text) {

        if (Build.VERSION.SDK_INT >= 33
                && activity.checkSelfPermission(
                "android.permission.POST_NOTIFICATIONS"
        ) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Notification.Builder nb =
                Build.VERSION.SDK_INT >= 26
                        ? new Notification.Builder(activity, CHANNEL)
                        : new Notification.Builder(activity);

        nb.setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(limit(title, 80))
                .setContentText(limit(text, 160))
                .setStyle(
                        new Notification.BigTextStyle()
                                .bigText(limit(text, 400))
                )
                .setContentIntent(
                        PendingIntent.getActivity(
                                activity,
                                0,
                                new Intent(activity, MainActivity.class)
                                        .addFlags(
                                                Intent.FLAG_ACTIVITY_SINGLE_TOP
                                                        | Intent.FLAG_ACTIVITY_NEW_TASK
                                        ),
                                PendingIntent.FLAG_IMMUTABLE
                                        | PendingIntent.FLAG_UPDATE_CURRENT
                        )
                )
                .setAutoCancel(true);

        NotificationManager nm =
                (NotificationManager) activity.getSystemService(
                        Context.NOTIFICATION_SERVICE
                );

        nm.notify(nextId++ % 1000 + 100, nb.build());
    }

    /**
     * Writes text to the app cache and opens the Android share sheet.
     * Returns false on failure.
     */
    @JavascriptInterface
    public boolean shareFile(String name, String mime, String content) {

        try {
            if (content == null
                    || content.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
                return false;
            }

            String safe = name == null
                    ? "export.txt"
                    : name.replaceAll("[^A-Za-z0-9._-]", "_");

            if (safe.length() > 80) {
                safe = safe.substring(0, 80);
            }

            String type =
                    "text/csv".equals(mime)
                            || "application/json".equals(mime)
                            ? mime
                            : "text/plain";

            File dir = new File(activity.getCacheDir(), "exports");

            if (!dir.exists() && !dir.mkdirs()) {
                return false;
            }

            // Keep the cache tidy by removing earlier exports.
            File[] old = dir.listFiles();

            if (old != null) {
                for (File o : old) {
                    if (!o.getName().equals(safe)) {
                        o.delete();
                    }
                }
            }

            File f = new File(dir, safe);

            try (FileOutputStream o = new FileOutputStream(f)) {
                o.write(content.getBytes(StandardCharsets.UTF_8));
            }

            final Uri uri = FileProvider.getUriForFile(
                    activity,
                    activity.getPackageName() + ".files",
                    f
            );

            final String t = type;

            activity.runOnUiThread(() -> {

                Intent send = new Intent(Intent.ACTION_SEND);

                send.setType(t);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.setClipData(
                        ClipData.newRawUri("export", uri)
                );
                send.addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                );

                activity.startActivity(
                        Intent.createChooser(send, "Export")
                );
            });

            return true;

        } catch (Exception e) {
            e.printStackTrace();
            return false;
        }
    }

    private static String limit(String s, int n) {
        s = s == null ? "" : s;
        return s.length() > n ? s.substring(0, n) : s;
    }
}