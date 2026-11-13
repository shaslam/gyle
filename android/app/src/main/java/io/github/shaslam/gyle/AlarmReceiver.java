package io.github.shaslam.gyle;

import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Runs when a timer alarm goes off, and when the phone starts (Android forgets alarms on a
 * restart). Both times the job is the same: show what is due and set the next alarm.
 */
public class AlarmReceiver extends BroadcastReceiver {
    /** Other apps cannot reach this receiver (it is not exported), so there is no sender to check. */
    @Override
    @SuppressLint("UnsafeProtectedBroadcastReceiver")
    public void onReceive(Context context, Intent intent) {
        Alarms.arm(context);
    }
}
