package com.fablepavilion.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.os.ext.SdkExtensions;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int SELECT_FILE = 10;
    private static final int SAVE_FILE = 11;
    private static final int WEB_PERMISSIONS = 12;
    private static final int CAPTURE_PERMISSION = 13;
    private static final int UPDATE_INSTALL_PERMISSION = 14;
    private static final int UPDATE_NOTIFICATION_PERMISSION = 15;
    private static final int ASSISTANT_NOTIFICATION_PERMISSION = 16;
    private static final String SITE_ORIGIN = "site-origin";
    private static boolean isolatedFrontend;
    private String frontendReleaseKey;
    private volatile VerifiedFrontend verifiedFrontend;
    private volatile VerifiedFrontend availableFrontend;
    private long startupId;
    private volatile boolean startingFrontend;
    private boolean checkingFrontend;
    private long lastFrontendCheck;
    private Button retryButton;
    private TextView unavailableSummary;
    private Uri defaultOrigin;
    private volatile Uri origin;
    private FrameLayout root;
    private LinearLayout offline;
    private WebView web;
    private WebView popup;
    private DownloadTransfer downloads;
    private AndroidUpdates updates;
    private AndroidUpdates.State updateState = AndroidUpdates.State.CHECKING;
    private AndroidUpdates.Release updateRelease;
    private AndroidUpdates.Release requestedInstall;
    private AlertDialog updateDialog;
    private boolean showUpdateWhenReady;
    private final Handler updateHandler = new Handler(Looper.getMainLooper());
    private final Runnable periodicUpdate = new Runnable() {
        @Override public void run() {
            refreshAndroidUpdates();
            updateHandler.postDelayed(this, 60000);
        }
    };
    private Uri retryUrl;
    private String siteAccess;
    private String notificationAccess;
    private String requestedNotificationBinding;
    private AndroidNotifications.Action pendingNotification;
    private Button resetSite;
    private String pageRequest;
    private PermissionRequest permissionRequest;
    private ValueCallback<Uri[]> fileChooser;
    private WebChromeClient.FileChooserParams chooserParams;
    private Uri photo;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        frontendReleaseKey = getString(R.string.frontend_release_key);
        if (!frontendReleaseKey.isEmpty() && !isolatedFrontend) {
            // A previous installation may have registered an unsigned service worker.
            WebView.setDataDirectorySuffix("verified-frontend-v1");
            isolatedFrontend = true;
        }
        defaultOrigin = Uri.parse(getString(R.string.web_origin));
        URI selected = SiteLogin.storedOrigin(getPreferences(MODE_PRIVATE).getString(SITE_ORIGIN, null));
        origin = selected == null ? defaultOrigin : Uri.parse(selected.toASCIIString());
        pendingNotification = AndroidNotifications.takeAction(this, origin);
        root = new FrameLayout(this);
        setContentView(root);
        updates = AndroidUpdates.get(this);
        showUpdateWhenReady = AndroidUpdates.OPEN.equals(getIntent().getAction());
        configureSystemBars();
        buildOfflineView();
        downloads = new DownloadTransfer(this, origin, SAVE_FILE);
        createWebView();
        if (isolatedFrontend) ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return interceptVerified(request);
            }
        });
        if (isolatedFrontend) startVerifiedFrontend(notificationTarget());
        else if (savedInstanceState == null ||
                !origin.toString().equals(savedInstanceState.getString(SITE_ORIGIN)) ||
                web.restoreState(savedInstanceState) == null)
            web.loadUrl(notificationTarget().toString());
        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
    }

    private boolean darkMode() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    @SuppressWarnings("deprecation")
    private void applyWebViewTheme(WebView view) {
        if (view == null) return;
        boolean dark = darkMode();
        view.setBackgroundColor(Color.parseColor(dark ? "#151B20" : "#FFFCF5"));
        WebSettings settings = view.getSettings();
        if (Build.VERSION.SDK_INT >= 33) {
            settings.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= 29) {
            settings.setForceDark(dark ? WebSettings.FORCE_DARK_ON : WebSettings.FORCE_DARK_OFF);
        }
    }

    private void emitSystemTheme() {
        if (web == null || web.getUrl() == null || !trusted(Uri.parse(web.getUrl()))) return;
        String mode = darkMode() ? "'dark'" : "'light'";
        web.evaluateJavascript(
                "window.fableAndroidSystemTheme=" + mode
                        + ";window.dispatchEvent(new Event('fable-android-system-theme'));",
                null);
    }

    @Override public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        configureSystemBars();
        boolean dark = darkMode();
        if (offline != null) offline.setBackgroundColor(Color.parseColor(dark ? "#151B20" : "#FFFCF5"));
        if (unavailableSummary != null)
            unavailableSummary.setTextColor(Color.parseColor(dark ? "#F4F0E8" : "#202F37"));
        applyWebViewTheme(web);
        emitSystemTheme();
    }

    private void configureSystemBars() {
        boolean dark = darkMode();
        int background = Color.parseColor(dark ? "#151B20" : "#FFFCF5");
        root.setBackgroundColor(background);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            int lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            root.post(() -> {
                WindowInsetsController controller = root.getWindowInsetsController();
                if (controller != null) controller.setSystemBarsAppearance(dark ? 0 : lightBars, lightBars);
            });
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        } else {
            getWindow().getDecorView().setSystemUiVisibility(dark ? 0 :
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private void buildOfflineView() {
        offline = new LinearLayout(this);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(Gravity.CENTER);
        offline.setPadding(32, 32, 32, 32);
        offline.setBackgroundColor(Color.parseColor(darkMode() ? "#151B20" : "#FFFCF5"));
        TextView summary = unavailableSummary = new TextView(this);
        summary.setText("暂时无法打开子虚亭");
        summary.setTextSize(18);
        summary.setTextColor(Color.parseColor(darkMode() ? "#F4F0E8" : "#202F37"));
        offline.addView(summary);
        Button retry = retryButton = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(view -> {
            if (isolatedFrontend) {
                startVerifiedFrontend(retryUrl == null ? Uri.parse(origin + "/") : retryUrl);
                return;
            }
            offline.setVisibility(View.GONE);
            if (retryUrl != null && retryUrl.toString().equals(web.getUrl())) web.reload();
            else web.loadUrl(retryUrl == null ? origin + "/" : retryUrl.toString());
        });
        offline.addView(retry);
        resetSite = new Button(this);
        resetSite.setText("返回默认站点");
        resetSite.setOnClickListener(view -> openSite(defaultOrigin, Uri.parse(defaultOrigin + "/")));
        offline.addView(resetSite);
        root.addView(offline);
        offline.setVisibility(View.GONE);
    }

    private void createWebView() {
        web = new WebView(this);
        applyWebViewTheme(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() +
                " FablePavilionAndroid/" + versionCode() + " FablePavilionAndroidUpdater");
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return interceptVerified(request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("fable-pavilion".equals(url.getScheme())) {
                    if (request.isForMainFrame() && view.getUrl() != null && trusted(Uri.parse(view.getUrl()))) {
                        if ("android-update".equals(url.getHost()) && request.hasGesture()) openUpdate();
                        else if ("notifications".equals(url.getHost())) handleNotificationBridge(url);
                        else receiveLoginSite(view, url);
                    }
                    return true;
                }
                if (request.isForMainFrame() && trusted(url) &&
                        VerifiedFrontend.isInstallerPath(url.getEncodedPath())) {
                    requestDownload(url, null, null);
                    return true;
                }
                if (!request.isForMainFrame() || trusted(url)) return false;
                if (request.hasGesture() || request.isRedirect()) openBrowser(request.getUrl());
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                siteAccess = null;
                notificationAccess = null;
                pageRequest = url;
                if (trusted(Uri.parse(url))) return;
                view.stopLoading();
                if (view.canGoBack()) view.goBack();
                else view.loadUrl(origin + "/");
            }

            @Override public void onPageCommitVisible(WebView view, String url) {
                if (offline.getVisibility() == View.VISIBLE && !startingFrontend) return;
                retryUrl = trusted(Uri.parse(url)) ? Uri.parse(url) : origin;
                if (trusted(Uri.parse(url))) {
                    downloads.watchBlobUrls(view);
                    offerLoginSiteAccess(view);
                    offerNotificationAccess(view);
                    emitSystemTheme();
                    reportUpdateToPage();
                }
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    if (isolatedFrontend) unavailableSummary.setText("页面连接失败，错误代码 " + error.getErrorCode());
                    showUnavailable(request.getUrl());
                }
            }

            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame() && error.getStatusCode() >= 500) {
                    if (isolatedFrontend) unavailableSummary.setText("本机已验签的页面资源无法读取");
                    showUnavailable(request.getUrl());
                }
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (error.getUrl().equals(pageRequest)) showUnavailable(Uri.parse(error.getUrl()));
            }

            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                cancelFileChooser();
                hideFullscreen();
                downloads.cancel();
                root.removeView(view);
                view.destroy();
                createWebView();
                showUnavailable(retryUrl == null ? origin : retryUrl);
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) ->
                requestDownload(Uri.parse(url), disposition, mime));
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                requestWebPermissions(request);
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (permissionRequest == request) permissionRequest = null;
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                cancelFileChooser();
                if (view.getUrl() == null || !trusted(Uri.parse(view.getUrl()))) {
                    callback.onReceiveValue(null);
                    return true;
                }
                fileChooser = callback;
                chooserParams = params;
                boolean capture = false;
                for (String type : params.getAcceptTypes()) capture |= type.startsWith("image/");
                if (params.isCaptureEnabled() && capture) {
                    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
                        requestPermissions(new String[] { Manifest.permission.CAMERA }, CAPTURE_PERMISSION);
                    else launchCamera();
                } else if (photoOnly(params)) launchPhotoPicker();
                else launchFileChooser();
                return true;
            }

            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!gesture || view.getUrl() == null || !trusted(Uri.parse(view.getUrl()))) return false;
                createPopup(result);
                return true;
            }

            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreen != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreen = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(-1, -1));
            }

            @Override public void onHideCustomView() { hideFullscreen(); }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
    }

    private void createPopup(Message result) {
        closePopup();
        popup = new WebView(this);
        WebView created = popup;
        popup.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri target = request.getUrl();
                String path = target.getPath();
                if ("blob".equals(target.getScheme()) ||
                        (trusted(target) && path != null && (path.startsWith("/local-files/") ||
                                VerifiedFrontend.isInstallerPath(path))))
                    requestDownload(target, null, null);
                else if (trusted(target)) web.loadUrl(target.toString());
                else openBrowser(target);
                web.post(() -> { if (popup == created) closePopup(); });
                return true;
            }
        });
        popup.setDownloadListener((url, agent, disposition, mime, length) -> {
            requestDownload(Uri.parse(url), disposition, mime);
            web.post(() -> { if (popup == created) closePopup(); });
        });
        ((WebView.WebViewTransport) result.obj).setWebView(popup);
        result.sendToTarget();
    }

    private void closePopup() {
        if (popup != null) popup.destroy();
        popup = null;
    }

    private void requestDownload(Uri url, String disposition, String mime) {
        if (trusted(url) && VerifiedFrontend.isInstallerPath(url.getEncodedPath())) {
            openUpdate();
            return;
        }
        boolean sameSiteBlob = "blob".equals(url.getScheme()) && trusted(Uri.parse(url.getSchemeSpecificPart()));
        if ((trusted(url) || sameSiteBlob) && web.getUrl() != null && trusted(Uri.parse(web.getUrl())))
            downloads.start(web, url, disposition, mime);
        else openBrowser(url);
    }

    private void refreshAndroidUpdates() {
        refreshAndroidUpdates(false);
    }

    private void refreshAndroidUpdates(boolean manual) {
        updates.check(isolatedFrontend ? defaultOrigin : origin, isolatedFrontend, frontendReleaseKey,
                availableFrontend, manual);
        checkFrontendUpdate(manual);
    }

    private void reportUpdateToPage() {
        if (web == null || web.getUrl() == null || !trusted(Uri.parse(web.getUrl()))) return;
        String state = JSONObject.quote(updateState.name().toLowerCase(Locale.ROOT));
        web.evaluateJavascript("window.fableAndroidUpdate=" + state +
                ";window.dispatchEvent(new Event('fable-android-update'));", null);
    }

    private void updateChanged(AndroidUpdates.State state, AndroidUpdates.Release release) {
        updateState = state;
        updateRelease = release;
        reportUpdateToPage();
        if (state == AndroidUpdates.State.DOWNLOADING && Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                !getPreferences(MODE_PRIVATE).getBoolean("update-notification-requested", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("update-notification-requested", true).apply();
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, UPDATE_NOTIFICATION_PERMISSION);
        }
        if (state == AndroidUpdates.State.READY &&
                (showUpdateWhenReady || getPreferences(MODE_PRIVATE).getInt("offered-update", 0) != release.code))
            offerUpdate(release);
    }

    private void openUpdate() {
        if (updateState == AndroidUpdates.State.READY && updateRelease != null) {
            offerUpdate(updateRelease);
            return;
        }
        if (updateState == AndroidUpdates.State.DOWNLOADING) {
            Toast.makeText(this, "更新正在后台下载，完成后会提示安装", Toast.LENGTH_SHORT).show();
            return;
        }
        refreshAndroidUpdates(true);
        Toast.makeText(this, "正在检查更新", Toast.LENGTH_SHORT).show();
    }

    private void offerUpdate(AndroidUpdates.Release release) {
        if (isFinishing() || isDestroyed() || (updateDialog != null && updateDialog.isShowing())) return;
        showUpdateWhenReady = false;
        getPreferences(MODE_PRIVATE).edit().putInt("offered-update", release.code).apply();
        updateDialog = new AlertDialog.Builder(this)
                .setTitle("子虚亭 " + release.version + " 已下载")
                .setMessage("现在安装更新？")
                .setNegativeButton("稍后", null)
                .setPositiveButton("安装更新", (dialog, which) -> installUpdate(release))
                .show();
    }

    private void installUpdate(AndroidUpdates.Release release) {
        if (!UpdateProvider.file(this, release.filename).isFile()) {
            openUpdate();
            return;
        }
        try {
            if (!getPackageManager().canRequestPackageInstalls()) {
                requestedInstall = release;
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())), UPDATE_INSTALL_PERMISSION);
                return;
            }
            Uri apk = UpdateProvider.uri(release.filename);
            Intent installer = new Intent(Intent.ACTION_VIEW);
            installer.setDataAndType(apk, AndroidUpdates.MIME);
            installer.setClipData(ClipData.newRawUri("APK", apk));
            installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(installer);
        } catch (ActivityNotFoundException | SecurityException failure) {
            Toast.makeText(this, "暂时无法打开 Android 安装界面", Toast.LENGTH_LONG).show();
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (AndroidNotifications.OPEN.equals(intent.getAction())) {
            pendingNotification = AndroidNotifications.takeAction(this, origin);
            if (pendingNotification != null) web.loadUrl(notificationTarget().toString());
            return;
        }
        if (!AndroidUpdates.OPEN.equals(intent.getAction())) return;
        showUpdateWhenReady = true;
        if (updateState == AndroidUpdates.State.READY && updateRelease != null) offerUpdate(updateRelease);
    }

    private void offerLoginSiteAccess(WebView view) {
        siteAccess = UUID.randomUUID().toString();
        // The currently committed top-level document receives a one-use navigation capability.
        view.evaluateJavascript("window.fablePavilionUseLoginSite = (url) => {"
                + "location.href = 'fable-pavilion://login-site?access=" + siteAccess
                + "&invite=' + encodeURIComponent(url); return true; };", null);
    }

    private Uri notificationTarget() {
        Uri.Builder url = origin.buildUpon().encodedPath("/");
        if (pendingNotification != null)
            url.appendQueryParameter("page", "messages").appendQueryParameter("conversation", pendingNotification.conversation);
        return url.build();
    }

    private void offerNotificationAccess(WebView view) {
        notificationAccess = UUID.randomUUID().toString();
        String base = "fable-pavilion://notifications?access=" + notificationAccess;
        view.evaluateJavascript("window.fableNotificationConnect=id=>{location.href=" +
                JSONObject.quote(base + "&operation=connect&id=") + "+encodeURIComponent(id);};" +
                "window.fableNotificationDisconnect=id=>{location.href=" +
                JSONObject.quote(base + "&operation=disconnect&id=") + "+encodeURIComponent(id);};", null);
        emitNotificationStatus();
        if (pendingNotification != null) {
            AndroidNotifications.Action action = pendingNotification;
            pendingNotification = null;
            if ("answer".equals(action.action) || "decline".equals(action.action)) {
                view.evaluateJavascript("window.fableNotificationAction={id:" + JSONObject.quote(action.id) +
                        ",action:" + JSONObject.quote(action.action) + "};" +
                        "window.dispatchEvent(new Event('fable-android-call-action'));", null);
            }
        }
    }

    private void emitNotificationStatus() {
        if (web == null || web.getUrl() == null || notificationAccess == null ||
                !trusted(Uri.parse(web.getUrl()))) return;
        try {
            JSONObject detail = AndroidNotifications.status(this, origin);
            web.evaluateJavascript("window.fableNotificationRegistration=" + detail +
                    ";window.dispatchEvent(new Event('fable-android-notification-registration'));", null);
        } catch (org.json.JSONException failure) {
            Log.w("FableNotification", "Could not read notification registration");
        }
    }

    private void handleNotificationBridge(Uri request) {
        if (notificationAccess == null || !notificationAccess.equals(request.getQueryParameter("access"))) return;
        String id = request.getQueryParameter("id");
        if (!AndroidNotifications.validId(id)) return;
        String operation = request.getQueryParameter("operation");
        if ("disconnect".equals(operation)) {
            AndroidNotifications.disconnect(this, origin, id);
        } else if ("connect".equals(operation)) {
            if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestedNotificationBinding = id;
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS },
                        ASSISTANT_NOTIFICATION_PERMISSION);
            } else AndroidNotifications.connect(this, origin, id);
        }
    }

    private void receiveLoginSite(WebView view, Uri request) {
        if (view != web || view.getUrl() == null || !trusted(Uri.parse(view.getUrl()))
                || !"login-site".equals(request.getHost()) || siteAccess == null
                || !siteAccess.equals(request.getQueryParameter("access"))) return;
        URI invitation = SiteLogin.invitation(request.getQueryParameter("invite"));
        if (invitation == null) return;
        siteAccess = null;
        Uri next = Uri.parse(SiteLogin.origin(invitation).toASCIIString());
        view.post(() -> {
            if (web == view && !isFinishing() && !isDestroyed())
                openSite(next, Uri.parse(invitation.toASCIIString()));
        });
    }

    private void openSite(Uri next, Uri target) {
        if (isolatedFrontend && sameOrigin(origin, next)) {
            startVerifiedFrontend(target);
            return;
        }
        siteAccess = null;
        notificationAccess = null;
        if (!sameOrigin(origin, next)) AndroidNotifications.reset(this);
        if (permissionRequest != null) {
            permissionRequest.deny();
            permissionRequest = null;
        }
        downloads.cancel();
        cancelFileChooser();
        hideFullscreen();
        closePopup();
        WebView previous = web;
        root.removeView(previous);
        previous.destroy();
        origin = next;
        SharedPreferences.Editor preferences = getPreferences(MODE_PRIVATE).edit();
        if (sameOrigin(defaultOrigin, origin)) preferences.remove(SITE_ORIGIN);
        else preferences.putString(SITE_ORIGIN, origin.toString());
        preferences.apply();
        pageRequest = null;
        retryUrl = target;
        offline.setVisibility(View.GONE);
        downloads = new DownloadTransfer(this, origin, SAVE_FILE);
        createWebView();
        if (isolatedFrontend) startVerifiedFrontend(target);
        else {
            web.loadUrl(target.toString());
            refreshAndroidUpdates();
        }
    }

    private void startVerifiedFrontend(Uri target) {
        final long id = ++startupId;
        startingFrontend = true;
        retryUrl = target;
        unavailableSummary.setText("正在打开已验签的前端…");
        retryButton.setVisibility(View.GONE);
        resetSite.setVisibility(View.GONE);
        offline.setVisibility(View.VISIBLE);
        WebView view = web;
        long started = SystemClock.elapsedRealtime();
        new Thread(() -> {
            try {
                VerifiedFrontend release = VerifiedFrontend.openLocal(defaultOrigin, frontendReleaseKey,
                        new java.io.File(getCacheDir(), "verified-frontend"),
                        getSharedPreferences("verified-frontend", MODE_PRIVATE), getAssets());
                runOnUiThread(() -> {
                    if (web != view || startupId != id || isFinishing() || isDestroyed()) return;
                    verifiedFrontend = release;
                    availableFrontend = release;
                    updates.check(defaultOrigin, true, frontendReleaseKey, release, false);
                    view.loadUrl(target.toString());
                    watchVerifiedStartup(view, id, started);
                });
            } catch (Exception failure) {
                Log.w("FableStartup", "Local frontend failed: " + failure.getClass().getSimpleName());
                runOnUiThread(() -> {
                    if (web != view || startupId != id || isFinishing() || isDestroyed()) return;
                    unavailableSummary.setText("本机前端验签失败，请重试");
                    showUnavailable(target);
                });
            }
        }, "fable-local-frontend").start();
        view.postDelayed(() -> {
            if (web != view || startupId != id || !startingFrontend || isDestroyed()) return;
            unavailableSummary.setText("页面启动超时，请重试");
            showUnavailable(target);
        }, 25000);
    }

    private void watchVerifiedStartup(WebView view, long id, long started) {
        view.postDelayed(() -> {
            if (web != view || startupId != id || !startingFrontend || isFinishing() || isDestroyed()) return;
            if (view.getUrl() == null || !trusted(Uri.parse(view.getUrl()))) {
                watchVerifiedStartup(view, id, started);
                return;
            }
            view.evaluateJavascript(
                    "!!document.querySelector('#root > *') && !document.getElementById('app-startup')",
                    ready -> {
                        if (web != view || startupId != id || !startingFrontend || isDestroyed()) return;
                        if ("true".equals(ready)) {
                            startingFrontend = false;
                            offline.setVisibility(View.GONE);
                            Log.i("FableStartup", "Verified frontend ready after " +
                                    (SystemClock.elapsedRealtime() - started) + " ms");
                            checkFrontendUpdate();
                        } else watchVerifiedStartup(view, id, started);
                    });
        }, 300);
    }

    private void checkFrontendUpdate() {
        checkFrontendUpdate(false);
    }

    private void checkFrontendUpdate(boolean force) {
        VerifiedFrontend current = availableFrontend;
        long now = SystemClock.elapsedRealtime();
        if (!isolatedFrontend || current == null || checkingFrontend ||
                (!force && lastFrontendCheck != 0 && now - lastFrontendCheck < 60000)) return;
        checkingFrontend = true;
        lastFrontendCheck = now;
        new Thread(() -> {
            try {
                VerifiedFrontend latest = current.update(frontendReleaseKey,
                        getSharedPreferences("verified-frontend", MODE_PRIVATE));
                runOnUiThread(() -> {
                    if (availableFrontend == current && !isDestroyed()) {
                        availableFrontend = latest;
                        updates.check(defaultOrigin, true, frontendReleaseKey, latest, false);
                        if (latest != current) Log.i("FableStartup", "Verified frontend update ready");
                    }
                });
            } catch (Exception failure) {
                Log.w("FableStartup", "Frontend refresh failed: " + failure.getClass().getSimpleName());
            } finally {
                runOnUiThread(() -> checkingFrontend = false);
            }
        }, "fable-frontend-refresh").start();
    }

    private WebResourceResponse interceptVerified(WebResourceRequest request) {
        if (!isolatedFrontend) return null;
        Uri site = origin;
        if (!sameOrigin(site, request.getUrl()))
            return request.isForMainFrame() ? VerifiedFrontend.unavailable() : null;
        VerifiedFrontend release = verifiedFrontend;
        if (release == null) return VerifiedFrontend.unavailable();
        VerifiedFrontend available = availableFrontend;
        if (available != null && !startingFrontend && request.isForMainFrame()) {
            verifiedFrontend = available;
            release = available;
        }
        String path = request.getUrl().getEncodedPath();
        boolean updateMetadata = "/version.json".equals(path) || AndroidUpdates.FEED.equals(path);
        if (updateMetadata && !request.isForMainFrame()) {
            runOnUiThread(this::checkFrontendUpdate);
            try {
                if (available != null) return available.asset(path, site);
            } catch (Exception ignored) {
                // The mounted release has its own verified version metadata.
            }
        }
        return release.intercept(request, site);
    }

    private boolean trusted(Uri url) { return sameOrigin(origin, url); }

    @SuppressWarnings("deprecation")
    private int versionCode() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (PackageManager.NameNotFoundException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static boolean sameOrigin(Uri origin, Uri url) {
        return "https".equals(url.getScheme()) && url.getUserInfo() == null && url.getHost() != null
                && url.getHost().equalsIgnoreCase(origin.getHost()) && httpsPort(url) == httpsPort(origin);
    }

    private static int httpsPort(Uri uri) { return uri.getPort() < 0 ? 443 : uri.getPort(); }

    private void openBrowser(Uri url) {
        if (!"https".equals(url.getScheme()) && !"http".equals(url.getScheme())) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
        }
    }

    private void showUnavailable(Uri url) {
        if (!trusted(url)) return;
        retryUrl = url;
        if (startingFrontend) {
            startingFrontend = false;
            startupId++;
        }
        retryButton.setVisibility(View.VISIBLE);
        resetSite.setVisibility(sameOrigin(defaultOrigin, origin) ? View.GONE : View.VISIBLE);
        offline.setVisibility(View.VISIBLE);
    }

    private void requestWebPermissions(PermissionRequest request) {
        if (permissionRequest != null || !trusted(request.getOrigin()) || web.getUrl() == null ||
                !trusted(Uri.parse(web.getUrl()))) {
            request.deny();
            return;
        }
        List<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = androidPermission(resource);
            if (permission != null && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
                needed.add(permission);
        }
        if (needed.isEmpty()) grantWebPermissions(request);
        else {
            permissionRequest = request;
            requestPermissions(needed.toArray(new String[0]), WEB_PERMISSIONS);
        }
    }

    private void grantWebPermissions(PermissionRequest request) {
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = androidPermission(resource);
            if (permission != null && checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED)
                allowed.add(resource);
        }
        if (allowed.isEmpty() || web.getUrl() == null || !trusted(Uri.parse(web.getUrl()))) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    private static String androidPermission(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        return null;
    }

    private void launchFileChooser() {
        try {
            startActivityForResult(chooserParams.createIntent(), SELECT_FILE);
        } catch (ActivityNotFoundException | SecurityException ignored) {
            cancelFileChooser();
            Toast.makeText(this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
        }
    }

    private static boolean photoOnly(WebChromeClient.FileChooserParams params) {
        boolean image = false;
        for (String value : params.getAcceptTypes()) for (String part : value.split(",")) {
            String type = part.trim().toLowerCase(Locale.ROOT);
            if (type.isEmpty()) continue;
            if (!type.startsWith("image/")) return false;
            image = true;
        }
        return image;
    }

    private void launchPhotoPicker() {
        boolean multiple = chooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        if (Build.VERSION.SDK_INT >= 33 || (Build.VERSION.SDK_INT >= 30 &&
                SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2)) {
            Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
            if (multiple) picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX,
                    Math.min(20, MediaStore.getPickImagesMaxLimit()));
            try {
                startActivityForResult(picker, SELECT_FILE);
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
                // Fall back to the image-filtered system document picker.
            }
        }
        Intent images = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        try {
            startActivityForResult(images, SELECT_FILE);
        } catch (ActivityNotFoundException | SecurityException ignored) {
            launchFileChooser();
        }
    }

    private Uri[] chosenFiles(int result, Intent data) {
        if (result != RESULT_OK) return null;
        if (photo != null) return new Uri[] { photo };
        if (data == null) return null;
        LinkedHashSet<Uri> chosen = new LinkedHashSet<>();
        ClipData clip = data.getClipData();
        if (clip != null) for (int index = 0; index < clip.getItemCount(); index++) {
            Uri uri = clip.getItemAt(index).getUri();
            if (uri != null) chosen.add(uri);
        }
        if (data.getData() != null) chosen.add(data.getData());
        return chosen.toArray(new Uri[0]);
    }

    private void launchCamera() {
        Uri capture = null;
        try {
            capture = CaptureProvider.newPhoto(this);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            camera.putExtra(MediaStore.EXTRA_OUTPUT, capture);
            camera.setClipData(ClipData.newRawUri("photo", capture));
            camera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            photo = capture;
            startActivityForResult(camera, SELECT_FILE);
        } catch (ActivityNotFoundException | SecurityException | IOException ignored) {
            if (capture != null) CaptureProvider.deletePhoto(this, capture);
            photo = null;
            launchFileChooser();
        }
    }

    private void cancelFileChooser() {
        if (fileChooser != null) fileChooser.onReceiveValue(null);
        fileChooser = null;
        chooserParams = null;
        if (photo != null) CaptureProvider.deletePhoto(this, photo);
        photo = null;
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == ASSISTANT_NOTIFICATION_PERMISSION && requestedNotificationBinding != null) {
            String binding = requestedNotificationBinding;
            requestedNotificationBinding = null;
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                AndroidNotifications.connect(this, origin, binding);
            else AndroidNotifications.failure(this, origin, binding, "请先在 Android 设置中允许通知");
        } else if (code == WEB_PERMISSIONS && permissionRequest != null) {
            PermissionRequest request = permissionRequest;
            permissionRequest = null;
            grantWebPermissions(request);
        } else if (code == CAPTURE_PERMISSION && fileChooser != null) {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera();
            else launchFileChooser();
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == UPDATE_INSTALL_PERMISSION) {
            AndroidUpdates.Release release = requestedInstall;
            requestedInstall = null;
            if (release != null && getPackageManager().canRequestPackageInstalls()) installUpdate(release);
        } else if (code == SAVE_FILE) {
            downloads.destination(result == RESULT_OK && data != null ? data.getData() : null);
        } else if (code == SELECT_FILE && fileChooser != null) {
            Uri[] selection = chosenFiles(result, data);
            if (photo != null && result != RESULT_OK) CaptureProvider.deletePhoto(this, photo);
            photo = null;
            List<Uri> files = new ArrayList<>();
            if (selection != null) for (Uri uri : selection) {
                if ("content".equals(uri.getScheme()) &&
                        (!"com.fablepavilion.app.camera".equals(uri.getAuthority()) ||
                            CaptureProvider.visiblePhoto(this, uri))) files.add(uri);
            }
            ValueCallback<Uri[]> callback = fileChooser;
            fileChooser = null;
            chooserParams = null;
            callback.onReceiveValue(files.isEmpty() ? null : files.toArray(new Uri[0]));
        }
    }

    private void hideFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        WebChromeClient.CustomViewCallback callback = fullscreenCallback;
        fullscreenCallback = null;
        callback.onCustomViewHidden();
    }

    private void back() {
        if (fullscreen != null) hideFullscreen();
        else if (web.canGoBack()) {
            offline.setVisibility(View.GONE);
            web.goBack();
        } else finish();
    }

    @Override public void onBackPressed() { back(); }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString(SITE_ORIGIN, origin.toString());
        if (SiteLogin.invitation(web.getUrl()) == null) web.saveState(state);
    }

    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        configureSystemBars();
        applyWebViewTheme(web);
        emitSystemTheme();
        updates.attach(this::updateChanged);
        AndroidNotifications.observe(this::emitNotificationStatus);
        emitNotificationStatus();
        updateHandler.post(periodicUpdate);
    }

    @Override protected void onPause() {
        updateHandler.removeCallbacks(periodicUpdate);
        updates.detach();
        AndroidNotifications.observe(null);
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override protected void onStop() {
        CookieManager.getInstance().flush();
        super.onStop();
    }

    @Override protected void onDestroy() {
        downloads.cancel();
        cancelFileChooser();
        hideFullscreen();
        closePopup();
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
