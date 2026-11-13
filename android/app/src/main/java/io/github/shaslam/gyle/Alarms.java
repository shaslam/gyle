package io.github.shaslam.gyle;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Brew-day timer alerts. Android stops the page when the phone is locked, so the page hands over
 * the list of alerts still to come and the app shows each one at its time.
 *
 * The list is kept on disk. One alarm is set for the earliest alert. When it goes off, every alert
 * that is due is shown and the alarm is set again for the next one.
 *
 * The page raises the same alerts itself while it is open. Each alert has a key and a key is
 * shown one time only, so the person never gets the same alert twice.
 */
final class Alarms {
    private static final String CHANNEL = "timer";
    private static final String LIST = "list", SHOWN = "shown";
    private static final int NOTE_ID = 1;
    private static final int REMEMBER = 40; // keys of alerts already shown

    private Alarms() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("alarms", Context.MODE_PRIVATE);
    }

    /** Replace the list of alerts to come. An empty list cancels the alarm. */
    static synchronized void set(Context c, String json) {
        prefs(c).edit().putString(LIST, json).apply();
        arm(c);
    }

    /** Show the alerts that are due, then set the alarm for the next one. */
    static synchronized void arm(Context c) {
        JSONArray all, later = new JSONArray();
        try {
            all = new JSONArray(prefs(c).getString(LIST, "[]"));
        } catch (JSONException e) {
            all = new JSONArray();
        }
        long now = System.currentTimeMillis(), next = Long.MAX_VALUE;
        for (int i = 0; i < all.length(); i++) {
            JSONObject a = all.optJSONObject(i);
            if (a == null) continue;
            long at = a.optLong("at");
            if (at <= now + 500) {
                show(c, a.optString("key"), a.optString("title"), a.optString("body"));
            } else {
                later.put(a);
                next = Math.min(next, at);
            }
        }
        prefs(c).edit().putString(LIST, later.toString()).apply();

        AlarmManager alarms = c.getSystemService(AlarmManager.class);
        PendingIntent ring = PendingIntent.getBroadcast(c, 0, new Intent(c, AlarmReceiver.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (next == Long.MAX_VALUE) {
            alarms.cancel(ring);
        } else if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) {
            // An alarm-clock alarm is the one kind that Android does not delay to save battery.
            alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(next, openApp(c)), ring);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, ring); // can be some minutes late
        }
    }

    /** Show one alert as a notification, unless its key was shown before. */
    static synchronized void show(Context c, String key, String title, String body) {
        SharedPreferences p = prefs(c);
        List<String> shown = new ArrayList<>(Arrays.asList(p.getString(SHOWN, "").split("\n")));
        if (shown.contains(key)) return;
        shown.add(key);
        while (shown.size() > REMEMBER) shown.remove(0);
        p.edit().putString(SHOWN, String.join("\n", shown)).apply();

        NotificationManager notes = c.getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, c.getString(R.string.channel_timer), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(c.getString(R.string.channel_timer_about));
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 300, 150, 300, 150, 300 });
        notes.createNotificationChannel(channel); // does nothing when the channel exists

        // Every alert replaces the one before, as on the website.
        notes.notify(NOTE_ID, new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_pint)
                .setColor(c.getColor(R.color.green))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_ALARM)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(openApp(c))
                .build());
    }

    private static PendingIntent openApp(Context c) {
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
