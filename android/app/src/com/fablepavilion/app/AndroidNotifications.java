package com.fablepavilion.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.BroadcastOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class AndroidNotifications {
    static final String OPEN = "com.fablepavilion.app.OPEN_NOTIFICATION";
    private static final String DISTRIBUTOR = "org.unifiedpush.android.distributor.";
    private static final String CONNECTOR = "org.unifiedpush.android.connector.";
    private static final String MESSAGES = "assistant-messages";
    private static final String CALLS = "assistant-calls";
    private static final Pattern ID =
            Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static Runnable listener;

    static boolean validId(String value) { return value != null && ID.matcher(value).matches(); }

    private static SharedPreferences state(Context context) {
        return context.getSharedPreferences("assistant-notifications", Context.MODE_PRIVATE);
    }

    static void observe(Runnable next) { listener = next; }

    static void connect(Activity activity, Uri origin, String binding) {
        SharedPreferences prefs = state(activity);
        if (binding.equals(prefs.getString("binding", "")) && sameSite(prefs, origin)
                && !prefs.contains("error")) {
            if (listener != null) listener.run();
            if (prefs.contains("endpoint")) return;
            broadcast(activity, prefs.getString("distributor", ""), "REGISTER", prefs.getString("token", ""), null);
            return;
        }
        reset(activity);
        List<ResolveInfo> apps = activity.getPackageManager().queryBroadcastReceivers(
                new Intent(DISTRIBUTOR + "REGISTER"), 0);
        String[] packages = apps.stream().map(info -> info.activityInfo.packageName).distinct().toArray(String[]::new);
        if (packages.length == 0) {
            failure(activity, origin, binding, "请先安装并启用 UnifiedPush 分发器，再开启通知");
            return;
        }
        if (packages.length == 1) {
            startRegistration(activity, origin, binding, packages[0]);
            return;
        }
        String[] labels = new String[packages.length];
        for (int index = 0; index < packages.length; index++) {
            final String app = packages[index];
            labels[index] = apps.stream().filter(info -> info.activityInfo.packageName.equals(app))
                    .findFirst().get().loadLabel(activity.getPackageManager()).toString();
        }
        new AlertDialog.Builder(activity).setTitle("选择本机推送服务")
                .setItems(labels, (dialog, index) -> startRegistration(activity, origin, binding, packages[index]))
                .setOnCancelListener(dialog -> failure(activity, origin, binding, "已取消启用通知"))
                .show();
    }

    static void failure(Context context, Uri origin, String binding, String message) {
        state(context).edit().putString("origin", origin.toString()).putString("binding", binding)
                .putString("error", message).remove("endpoint").apply();
        if (listener != null) listener.run();
    }

    private static void startRegistration(Context context, Uri origin, String binding, String distributor) {
        String token = UUID.randomUUID().toString();
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        state(context).edit().putString("origin", origin.toString()).putString("binding", binding)
                .putString("key", Base64.encodeToString(key, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP))
                .putString("token", token).putString("distributor", distributor).apply();
        broadcast(context, distributor, "REGISTER", token, null);
    }

    private static void broadcast(Context context, String distributor, String action, String token, String id) {
        if (distributor.isEmpty() || token.isEmpty()) return;
        Intent intent = new Intent(DISTRIBUTOR + action).setPackage(distributor)
                .putExtra("token", token).putExtra("application", context.getPackageName());
        if (id != null) intent.putExtra("id", id);
        if ("REGISTER".equals(action)) intent.putExtra("message", "子虚亭的助手消息和来电");
        if (Build.VERSION.SDK_INT >= 34) {
            Bundle options = BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle();
            context.sendBroadcast(intent, null, options);
        } else {
            PendingIntent identity = PendingIntent.getBroadcast(context, 0,
                    new Intent("org.unifiedpush.dummy").setPackage("org.unifiedpush.dummy_app"),
                    PendingIntent.FLAG_IMMUTABLE);
            intent.putExtra("pi", identity);
            context.sendBroadcast(intent);
        }
    }

    private static boolean sameSite(SharedPreferences prefs, Uri origin) {
        return origin.toString().equals(prefs.getString("origin", ""));
    }

    static void disconnect(Context context, Uri origin, String binding) {
        SharedPreferences prefs = state(context);
        if (sameSite(prefs, origin) && binding.equals(prefs.getString("binding", ""))) reset(context);
    }

    static void reset(Context context) {
        SharedPreferences prefs = state(context);
        String distributor = prefs.getString("distributor", ""), token = prefs.getString("token", "");
        prefs.edit().clear().commit();
        broadcast(context, distributor, "UNREGISTER", token, null);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification notice : manager.getActiveNotifications())
            if (notice.getTag() != null && notice.getTag().startsWith("fable-assistant-"))
                manager.cancel(notice.getTag(), notice.getId());
    }

    static JSONObject status(Context context, Uri origin) throws JSONException {
        SharedPreferences prefs = state(context);
        String binding = prefs.getString("binding", "");
        if (binding.isEmpty() || !sameSite(prefs, origin)) return null;
        return new JSONObject().put("id", binding).put("endpoint", prefs.getString("endpoint", null))
                .put("key", prefs.getString("key", null))
                .put("error", prefs.getString("error", null));
    }

    static final class Action {
        final String id;
        final String conversation;
        final String action;

        Action(String id, String conversation, String action) {
            this.id = id;
            this.conversation = conversation;
            this.action = action;
        }
    }

    static Action takeAction(Context context, Uri origin) {
        SharedPreferences prefs = state(context);
        if (!sameSite(prefs, origin)) return null;
        String id = prefs.getString("open-id", ""), conversation = prefs.getString("open-conversation", "");
        String action = prefs.getString("open-action", "");
        prefs.edit().remove("open-id").remove("open-conversation").remove("open-action").apply();
        return validId(id) && validId(conversation) ? new Action(id, conversation, action) : null;
    }

    public static final class OpenActivity extends Activity {
        @Override protected void onCreate(Bundle saved) {
            super.onCreate(saved);
            Intent source = getIntent();
            SharedPreferences prefs = state(this);
            String binding = source.getStringExtra("binding"), id = source.getStringExtra("id");
            String conversation = source.getStringExtra("conversation"), action = source.getStringExtra("action");
            if (validId(binding) && binding.equals(prefs.getString("binding", "")) &&
                    validId(id) && validId(conversation) &&
                    ("message".equals(source.getStringExtra("kind")) ||
                            source.getLongExtra("expires", 0) > System.currentTimeMillis())) {
                prefs.edit().putString("open-id", id).putString("open-conversation", conversation)
                        .putString("open-action", action).apply();
                startActivity(new Intent(this, MainActivity.class).setAction(OPEN)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            }
            finish();
        }
    }

    public static final class Receiver extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            SharedPreferences prefs = state(context);
            String token = prefs.getString("token", "");
            String action = intent.getAction();
            if (token.isEmpty() || !token.equals(intent.getStringExtra("token")) || action == null) return;
            String sender = Build.VERSION.SDK_INT >= 34 ? getSentFromPackage() : null;
            String distributor = prefs.getString("distributor", "");
            if (sender != null && !Objects.equals(distributor, sender)) return;
            switch (action) {
                case CONNECTOR + "NEW_ENDPOINT":
                    String endpoint = intent.getStringExtra("endpoint");
                    Uri url = endpoint == null ? null : Uri.parse(endpoint);
                    if (url == null || !"https".equals(url.getScheme()) || url.getHost() == null ||
                            url.getUserInfo() != null || url.getFragment() != null || endpoint.length() > 2048) return;
                    prefs.edit().putString("endpoint", endpoint).remove("error").apply();
                    if (listener != null) listener.run();
                    break;
                case CONNECTOR + "MESSAGE":
                    byte[] payload = intent.getByteArrayExtra("message");
                    if (payload != null && payload.length <= 4096) render(context, prefs, payload);
                    String id = intent.getStringExtra("id");
                    if (id != null && id.length() <= 100) broadcast(context, distributor, "MESSAGE_ACK", token, id);
                    break;
                case CONNECTOR + "TEMP_UNAVAILABLE":
                case CONNECTOR + "REGISTRATION_FAILED":
                case CONNECTOR + "UNREGISTERED":
                    prefs.edit().remove("endpoint").putString("error", "本机推送服务暂不可用，请重试").apply();
                    if (listener != null) listener.run();
                    break;
                default:
                    break;
            }
        }
    }

    private static PendingIntent open(Context context, JSONObject event, String action) throws JSONException {
        String id = event.getString("id");
        Intent intent = new Intent(context, OpenActivity.class)
                .setData(Uri.parse("fable-notification://open/" + id + "/" + action))
                .putExtra("action", action).putExtra("id", id)
                .putExtra("binding", event.getString("binding"))
                .putExtra("kind", event.getString("kind"))
                .putExtra("conversation", event.getString("conversation"))
                .putExtra("expires", event.getLong("expiresAt"));
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void render(Context context, SharedPreferences prefs, byte[] payload) {
        try {
            String encrypted = new String(payload, StandardCharsets.US_ASCII);
            if (!encrypted.startsWith("fable1.")) return;
            byte[] bytes = Base64.decode(encrypted.substring(7), Base64.URL_SAFE);
            byte[] key = Base64.decode(prefs.getString("key", ""), Base64.URL_SAFE);
            if (bytes.length < 29 || key.length != 32) return;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, bytes, 0, 12));
            cipher.updateAAD("fable-push-v1".getBytes(StandardCharsets.US_ASCII));
            byte[] clear = cipher.doFinal(bytes, 12, bytes.length - 12);
            JSONObject event = new JSONObject(new String(clear, StandardCharsets.UTF_8));
            String id = event.getString("id"), conversation = event.getString("conversation");
            long remaining = event.getLong("expiresAt") - System.currentTimeMillis();
            if (!validId(id) || !validId(conversation) || remaining <= 0 || remaining > 16 * 60_000L ||
                    !event.getString("binding").equals(prefs.getString("binding", ""))) return;
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            String tag = "fable-assistant-call:" + id;
            String kind = event.getString("kind");
            String closed = "cleared:" + id;
            long now = System.currentTimeMillis();
            if ("call-cleared".equals(kind)) {
                SharedPreferences.Editor cleanup = prefs.edit();
                prefs.getAll().forEach((entry, value) -> {
                    if (entry.startsWith("cleared:") && value instanceof Long && ((Long) value) <= now)
                        cleanup.remove(entry);
                });
                cleanup.putLong(closed, event.getLong("expiresAt")).apply();
                manager.cancel(tag, 0);
                return;
            }
            boolean call = "audio-call".equals(kind) || "video-call".equals(kind);
            if (!call && !"message".equals(kind)) return;
            if (call && prefs.getLong(closed, 0) > now) return;
            if (!manager.areNotificationsEnabled()) return;
            String channel = call ? CALLS : MESSAGES;
            manager.createNotificationChannel(new NotificationChannel(channel, call ? "助手来电" : "助手消息",
                    call ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT));
            String title = "video-call".equals(kind) ? "有视频来电" : call ? "有语音来电" : "助手发来新消息";
            Notification.Builder builder = new Notification.Builder(context, channel)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle("子虚亭").setContentText(title)
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .setContentIntent(open(context, event, "open"))
                    .setOnlyAlertOnce(true).setAutoCancel(true);
            if (call) {
                builder.setTimeoutAfter(remaining);
                builder.setCategory(Notification.CATEGORY_CALL);
                PendingIntent answer = open(context, event, "answer"), decline = open(context, event, "decline");
                // Android can post these actions from a background push receiver.
                builder.addAction(new Notification.Action.Builder(null, "拒绝", decline).build())
                        .addAction(new Notification.Action.Builder(null, "接听", answer).build());
            }
            manager.notify(call ? tag : "fable-assistant-message:" + conversation, 0, builder.build());
        } catch (JSONException | IllegalArgumentException | GeneralSecurityException ignored) {
            // The external distributor cannot trigger app navigation with a malformed notice.
        }
    }
}
