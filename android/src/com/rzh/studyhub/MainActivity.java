package com.rzh.studyhub;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 学习台的原生外壳。
 *
 * 设计要点，每一条都有具体理由：
 *
 * 1. 资源通过 https://appassets.androidplatform.net/ 提供，而不是 file:///android_asset/。
 *    getUserMedia、Service Worker 都要求「安全上下文」。file:// 在不同 WebView 版本上
 *    是否被视为可信并不一致，而拦截一个 https 源的请求可以稳定得到安全上下文。
 *    androidplatform.net 是 Google 保留给这个用途的域名，永远不会真正解析到公网。
 *    （等价于 androidx.webkit 的 WebViewAssetLoader，这里手写以避免引入依赖）
 *
 * 2. 没有申请 INTERNET 权限。内容全部打包在 APK 内，数据全部存在应用私有目录，
 *    从系统层面保证不可能有数据外传。
 *
 * 3. 备份导出/导入走原生 SAF，不走网页的 <a download>。
 *    WebView 里 blob: URL 的下载会静默失败，如果不做这层桥，
 *    「导出备份」按钮会看起来点了但什么都没发生 —— 而这个 App 唯一的数据丢失风险
 *    就是没有备份，所以这条链路必须真的通。
 */
public class MainActivity extends Activity {

    private static final String TAG = "StudyHub";
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int REQ_MIC = 1001;
    private static final int REQ_EXPORT = 2001;
    private static final int REQ_IMPORT = 2002;

    private WebView web;
    private PermissionRequest pendingMicRequest;
    private byte[] pendingExportBytes;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("woff2", "font/woff2");
        MIME.put("txt", "text/plain");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.parseColor("#12141A"));
        getWindow().setNavigationBarColor(Color.parseColor("#12141A"));

        if (Build.VERSION.SDK_INT >= 21) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web = new WebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.parseColor("#12141A"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 练耳出题要在没有用户手势的情况下播放合成音，必须关掉这个限制
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        if (Build.VERSION.SDK_INT >= 26) {
            s.setSafeBrowsingEnabled(false);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u == null) return null;
                String url = u.toString();
                if (!url.startsWith(ORIGIN)) return null;
                String path = u.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                return serveAsset(path.substring(1));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 站内导航照常，站外链接一律不在 WebView 里打开
                return u == null || !u.toString().startsWith(ORIGIN);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean wantsMic = false;
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
                }
                if (!wantsMic) {
                    request.deny();
                    return;
                }
                if (hasMicPermission()) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    // 系统权限还没给：先记下网页这次请求，等用户在系统弹窗里同意后再放行
                    pendingMicRequest = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.loadUrl(ORIGIN + "/index.html");
    }

    private boolean hasMicPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private WebResourceResponse serveAsset(String assetPath) {
        try {
            InputStream in = getAssets().open(assetPath);
            String ext = "";
            int dot = assetPath.lastIndexOf('.');
            if (dot >= 0) ext = assetPath.substring(dot + 1).toLowerCase();
            String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
            WebResourceResponse res = new WebResourceResponse(mime, "utf-8", in);
            Map<String, String> headers = new HashMap<>();
            // 同源即可，不需要 CORS；但 SW 注册要求 Service-Worker-Allowed 覆盖到根
            headers.put("Service-Worker-Allowed", "/");
            headers.put("Cache-Control", "no-cache");
            res.setResponseHeaders(headers);
            return res;
        } catch (IOException e) {
            Log.w(TAG, "asset 缺失: " + assetPath);
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    new HashMap<String, String>(), new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_MIC) {
            boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (pendingMicRequest != null) {
                if (granted) {
                    pendingMicRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingMicRequest.deny();
                    Toast.makeText(this, "没有麦克风权限，练声模块无法使用", Toast.LENGTH_LONG).show();
                }
                pendingMicRequest = null;
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_EXPORT) {
            if (result == RESULT_OK && data != null && data.getData() != null && pendingExportBytes != null) {
                try {
                    OutputStream os = getContentResolver().openOutputStream(data.getData());
                    os.write(pendingExportBytes);
                    os.flush();
                    os.close();
                    toJs("window.__bridgeExportDone && window.__bridgeExportDone(true, '')");
                } catch (Exception e) {
                    toJs("window.__bridgeExportDone && window.__bridgeExportDone(false, " + jsStr(e.getMessage()) + ")");
                }
            } else {
                toJs("window.__bridgeExportDone && window.__bridgeExportDone(false, '已取消')");
            }
            pendingExportBytes = null;
        } else if (req == REQ_IMPORT) {
            if (result == RESULT_OK && data != null && data.getData() != null) {
                try {
                    InputStream is = getContentResolver().openInputStream(data.getData());
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    is.close();
                    String text = new String(bos.toByteArray(), "UTF-8");
                    toJs("window.__bridgeImportDone && window.__bridgeImportDone(true, " + jsStr(text) + ")");
                } catch (Exception e) {
                    toJs("window.__bridgeImportDone && window.__bridgeImportDone(false, " + jsStr(e.getMessage()) + ")");
                }
            } else {
                toJs("window.__bridgeImportDone && window.__bridgeImportDone(false, '已取消')");
            }
        }
    }

    private void toJs(final String script) {
        runOnUiThread(new Runnable() {
            @Override public void run() { if (web != null) web.evaluateJavascript(script, null); }
        });
    }

    /** 把任意字符串安全地嵌进 JS 字面量（不能靠拼引号，备份内容里全是引号和反斜杠） */
    private static String jsStr(String s) {
        if (s == null) return "''";
        StringBuilder b = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\'': b.append("\\'"); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\u2028': b.append("\\u2028"); break;
                case '\u2029': b.append("\\u2029"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append("'").toString();
    }

    public class Bridge {

        /** 网页据此判断自己跑在原生外壳里，从而启用原生导出/导入 */
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public int versionCode() {
            return 1;
        }

        /** 导出备份：拉起系统「保存到」选择器 */
        @JavascriptInterface
        public void exportFile(String filename, String base64Content) {
            try {
                pendingExportBytes = Base64.decode(base64Content, Base64.DEFAULT);
            } catch (Exception e) {
                toJs("window.__bridgeExportDone && window.__bridgeExportDone(false, '编码错误')");
                return;
            }
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("application/json");
            i.putExtra(Intent.EXTRA_TITLE, filename);
            startActivityForResult(i, REQ_EXPORT);
        }

        /** 导入备份：拉起系统文件选择器 */
        @JavascriptInterface
        public void importFile() {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            startActivityForResult(i, REQ_IMPORT);
        }

        /**
         * 练声/回归时保持屏幕常亮。
         * 引导流程有倒计时、回归体检要连续录 40 秒，中途灭屏会打断采集，
         * 而用户此时双手可能正在做呼吸支撑动作，没法去点屏幕。
         */
        @JavascriptInterface
        public void setKeepAwake(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public boolean hasMic() {
            return hasMicPermission();
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setWebChromeClient(null);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 切后台时让页面停掉分析循环与音频，避免麦克风指示灯一直亮着耗电
        if (web != null) web.evaluateJavascript(
                "window.__onNativePause && window.__onNativePause()", null);
    }
}
