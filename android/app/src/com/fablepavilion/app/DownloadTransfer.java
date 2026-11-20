package com.fablepavilion.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.URLUtil;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/** Transfers a same-origin download using an origin-bound, single-use WebView message port. */
final class DownloadTransfer {
    private static final long MAX_BYTES = 256L * 1024 * 1024;
    private static final String BLOB_REGISTRY = "Symbol.for('com.fablepavilion.app.downloads')";
    private final Activity activity;
    private final Uri origin;
    private final int requestCode;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = this::failed;
    private File pending;
    private OutputStream spool;
    private WebMessagePort port;
    private long received;
    private String filename;
    private String mime;

    DownloadTransfer(Activity activity, Uri origin, int requestCode) {
        this.activity = activity;
        this.origin = origin;
        this.requestCode = requestCode;
    }

    void watchBlobUrls(WebView web) {
        // Retain the site's Blob handle while its URL is live, so downloads honor the page's CSP.
        web.evaluateJavascript("(() => {"
                + "const key=" + BLOB_REGISTRY + ";if(URL[key])return;"
                + "const blobs=new Map();Object.defineProperty(URL,key,{value:blobs});"
                + "const create=URL.createObjectURL,revoke=URL.revokeObjectURL;"
                + "URL.createObjectURL=function(value){const url=create.call(URL,value);"
                + "if(value instanceof Blob)blobs.set(url,{blob:value});return url;};"
                + "URL.revokeObjectURL=function(url){blobs.delete(String(url));return revoke.call(URL,url);};"
                + "document.addEventListener('click',e=>{const link=e.target.closest?.('a[download]');"
                + "const download=link&&blobs.get(link.href);if(download)download.name=link.download;},true);"
                + "})()", null);
    }

    void start(WebView web, Uri url, String disposition, String mime) {
        if (pending != null) {
            Toast.makeText(activity, "请先完成当前文件的保存", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            pending = File.createTempFile("web-download-", ".tmp", activity.getCacheDir());
            spool = new FileOutputStream(pending);
            received = 0;
            WebMessagePort[] channel = web.createWebMessageChannel();
            port = channel[0];
            String token = UUID.randomUUID().toString();
            filename = URLUtil.guessFileName(url.toString(), disposition, mime);
            this.mime = mime;
            port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
                @Override public void onMessage(WebMessagePort source, WebMessage message) {
                    if (source == port) accept(url, message.getData());
                }
            });
            resetTimeout();
            web.evaluateJavascript(receiver(token, url), result -> {
                if (port != channel[0]) {
                    channel[1].close();
                    return;
                }
                if (!"true".equals(result) || web.getUrl() == null ||
                        !MainActivity.sameOrigin(origin, Uri.parse(web.getUrl()))) {
                    channel[1].close();
                    failed();
                    return;
                }
                web.postWebMessage(new WebMessage(token, new WebMessagePort[] { channel[1] }), origin);
            });
        } catch (IOException | IllegalStateException error) {
            failed();
        }
    }

    private static String receiver(String token, Uri url) {
        String source = JSONObject.quote(url.toString());
        String stream = "blob".equals(url.getScheme())
                ? "if(!download){port.postMessage('error!');return;}"
                    + "port.postMessage('meta!'+JSON.stringify({name:download.name,mime:download.blob.type}));"
                    + "const reader=download.blob.stream().getReader();"
                : "const response=await fetch(" + source + ",{credentials:'same-origin',redirect:'error'});"
                    + "if(!response.ok||!response.body)throw Error();"
                    + "port.postMessage('meta!'+JSON.stringify({disposition:response.headers.get('Content-Disposition'),"
                    + "mime:response.headers.get('Content-Type')}));"
                    + "const reader=response.body.getReader();";
        return "(() => {const token=" + JSONObject.quote(token) + ";"
                + "const download=URL[" + BLOB_REGISTRY + "]?.get(" + source + ");"
                + "const receive=async e=>{if(e.data!==token||!e.ports.length)return;"
                + "removeEventListener('message',receive);const port=e.ports[0];"
                + "try{" + stream
                + "for(;;){const {done,value}=await reader.read();if(done)break;"
                + "for(let offset=0;offset<value.length;offset+=65536){"
                + "const bytes=value.subarray(offset,offset+65536);"
                + "await new Promise(resolve=>{port.onmessage=resolve;"
                + "port.postMessage(btoa(String.fromCharCode(...bytes)));});}}"
                + "port.postMessage('done!');}catch{port.postMessage('error!');}};"
                + "addEventListener('message',receive);setTimeout(()=>removeEventListener('message',receive),30000);"
                + "return true;})()";
    }

    private void accept(Uri url, String data) {
        if (spool == null || data == null) return;
        try {
            if (data.startsWith("meta!") && data.length() <= 8_192) {
                JSONObject metadata = new JSONObject(data.substring(5));
                String suppliedMime = metadata.optString("mime", "").split(";", 2)[0].trim();
                if (!suppliedMime.isEmpty()) mime = suppliedMime;
                String name = metadata.optString("name", "");
                String disposition = metadata.optString("disposition", "");
                if (!name.isEmpty()) filename = name;
                else if (!disposition.isEmpty()) filename = URLUtil.guessFileName(url.toString(), disposition, mime);
                return;
            }
            if ("done!".equals(data)) {
                closePort();
                spool.close();
                spool = null;
                Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                picker.putExtra(Intent.EXTRA_TITLE, filename.replaceAll("[/\\\\\\p{Cntrl}]", "_"));
                activity.startActivityForResult(picker, requestCode);
                return;
            }
            if ("error!".equals(data) || data.length() > 88_000) throw new IOException("Download stream");
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            received += bytes.length;
            if (received > MAX_BYTES) throw new IOException("Download limit");
            spool.write(bytes);
            resetTimeout();
            port.postMessage(new WebMessage("continue"));
        } catch (IOException | JSONException | IllegalArgumentException |
                IllegalStateException | ActivityNotFoundException error) {
            failed();
        }
    }

    void destination(Uri destination) {
        File ready = pending;
        pending = null;
        if (ready == null) return;
        if (destination == null) {
            ready.delete();
            return;
        }
        new Thread(() -> {
            try (FileInputStream input = new FileInputStream(ready);
                    OutputStream output = activity.getContentResolver().openOutputStream(destination, "wt")) {
                if (output == null) throw new IOException("No file destination");
                byte[] buffer = new byte[64 * 1024];
                for (int size; (size = input.read(buffer)) != -1; ) output.write(buffer, 0, size);
            } catch (IOException | SecurityException error) {
                handler.post(this::reportFailure);
            } finally {
                ready.delete();
            }
        }, "save-web-download").start();
    }

    private void resetTimeout() {
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, 30_000);
    }

    private void closePort() {
        handler.removeCallbacks(timeout);
        if (port != null) port.close();
        port = null;
    }

    void cancel() {
        closePort();
        if (spool != null) try { spool.close(); } catch (IOException ignored) { }
        spool = null;
        if (pending != null) pending.delete();
        pending = null;
    }

    private void failed() {
        cancel();
        reportFailure();
    }

    private void reportFailure() {
        Toast.makeText(activity, "无法保存文件，请重试", Toast.LENGTH_SHORT).show();
    }
}
