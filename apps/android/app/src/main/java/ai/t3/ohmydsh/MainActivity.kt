package ai.t3.ohmydsh

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.util.concurrent.Executors

/**
 * One activity, three screens: pairing (first run, and the computer list), connecting, and the DSH web UI full-screen.
 * The WebView only ever loads the origin of a computer the user paired, and external links leave for the browser.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var store: Store
    private var computers = Computers.EMPTY
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private lateinit var pairingScreen: View
    private lateinit var connectingScreen: View
    private lateinit var refresh: SwipeRefreshLayout
    private lateinit var web: WebView
    private lateinit var list: LinearLayout
    private lateinit var listTitle: TextView
    private lateinit var intro: TextView
    private lateinit var status: TextView
    private lateinit var connectingText: TextView
    private lateinit var retry: Button
    private lateinit var back: Button

    private var shown: Screen = Screen.PAIRING
    private var currentOrigin: String? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null
    private var lastCheck = 0L
    private var downY = 0f
    private var inFlight = false

    private enum class Screen { PAIRING, CONNECTING, WEB }

    private val scan = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val link = PairingLink.parse(text)
        if (link == null) showStatus(getString(R.string.err_not_dsh_qr)) else confirmPair(link)
    }

    private val chooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = pendingChooser ?: return@registerForActivityResult
        pendingChooser = null
        cb.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        store = Store(this)
        computers = store.load()

        pairingScreen = findViewById(R.id.pairing)
        connectingScreen = findViewById(R.id.connecting)
        refresh = findViewById(R.id.refresh)
        web = findViewById(R.id.web)
        list = findViewById(R.id.computer_list)
        listTitle = findViewById(R.id.list_title)
        intro = findViewById(R.id.intro)
        status = findViewById(R.id.status)
        connectingText = findViewById(R.id.connecting_text)
        retry = findViewById(R.id.retry)
        back = findViewById(R.id.back_to_list)

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        findViewById<Button>(R.id.scan).setOnClickListener { startScan() }
        findViewById<Button>(R.id.paste).setOnClickListener { askForLink() }
        retry.setOnClickListener { connect() }
        back.setOnClickListener { showPairing() }
        setupWebView()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    shown == Screen.WEB && web.canGoBack() -> web.goBack()
                    shown == Screen.WEB || (shown == Screen.CONNECTING && computers.items.isNotEmpty()) -> showPairing()
                    else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
                }
            }
        })

        if (!handleIntent(intent)) {
            if (computers.active != null) connect() else showPairing()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // Coming back after a while: make sure this phone is still paired, without reloading the page it is on.
        val now = System.currentTimeMillis()
        val active = computers.active
        if (shown == Screen.WEB && active != null && now - lastCheck > 60_000) {
            lastCheck = now
            io.execute {
                if (PairingApi.session(active) == PairingApi.Session.Revoked) main.post { onRevoked(active) }
            }
        }
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        pendingChooser?.onReceiveValue(null)
        pendingChooser = null
        io.shutdownNow()
        web.destroy()
        super.onDestroy()
    }

    // ── Screens ──────────────────────────────────────────────────────────────

    private fun show(screen: Screen) {
        shown = screen
        pairingScreen.visibility = if (screen == Screen.PAIRING) View.VISIBLE else View.GONE
        connectingScreen.visibility = if (screen == Screen.CONNECTING) View.VISIBLE else View.GONE
        refresh.visibility = if (screen == Screen.WEB) View.VISIBLE else View.GONE
    }

    private fun showStatus(text: String) {
        status.text = text
        status.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun showPairing(message: String = "") {
        show(Screen.PAIRING)
        showStatus(message)
        intro.setText(if (computers.items.isEmpty()) R.string.intro_first else R.string.intro_more)
        listTitle.visibility = if (computers.items.isEmpty()) View.GONE else View.VISIBLE
        list.removeAllViews()
        val inflater = LayoutInflater.from(this)
        for (c in computers.items) {
            val row = inflater.inflate(R.layout.item_computer, list, false)
            row.findViewById<TextView>(R.id.computer_name).text = c.name
            row.findViewById<TextView>(R.id.computer_origin).text = c.origin
            row.findViewById<TextView>(R.id.computer_active).visibility = if (c.id == computers.active?.id) View.VISIBLE else View.GONE
            row.setOnClickListener {
                computers = computers.withActive(c.id).also { store.save(it) }
                connect()
            }
            row.findViewById<Button>(R.id.computer_remove).setOnClickListener { confirmRemove(c) }
            list.addView(row)
        }
    }

    private fun showConnecting(text: String, failed: Boolean) {
        show(Screen.CONNECTING)
        connectingText.text = text
        retry.visibility = if (failed) View.VISIBLE else View.GONE
        back.visibility = if (failed) View.VISIBLE else View.GONE
        findViewById<View>(R.id.progress).visibility = if (failed) View.GONE else View.VISIBLE
    }

    // ── Pairing ──────────────────────────────────────────────────────────────

    private fun handleIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (intent.action != Intent.ACTION_VIEW) return false
        val link = PairingLink.parse(data.toString())
        if (link == null) { showPairing(getString(R.string.err_not_dsh_qr)); return true }
        confirmPair(link)
        return true
    }

    private fun startScan() {
        scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt(getString(R.string.scan_prompt)).setBeepEnabled(false).setOrientationLocked(false))
    }

    private fun askForLink() {
        val input = EditText(this).apply {
            hint = getString(R.string.paste_hint)
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        val pad = (20 * resources.displayMetrics.density).toInt()
        val frame = LinearLayout(this).apply { setPadding(pad, pad / 2, pad, 0); addView(input, LinearLayout.LayoutParams(-1, -2)) }
        AlertDialog.Builder(this)
            .setTitle(R.string.paste_title)
            .setView(frame)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.paste_ok) { _, _ ->
                val link = PairingLink.parse(input.text.toString())
                if (link == null) showStatus(getString(R.string.err_not_dsh_link)) else confirmPair(link)
            }
            .show()
    }

    private fun confirmPair(link: PairingLink) {
        val http = link.origin.startsWith("http://")
        AlertDialog.Builder(this)
            .setTitle(R.string.confirm_title)
            .setMessage(getString(if (http) R.string.confirm_body_http else R.string.confirm_body, link.origin))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.confirm_ok) { _, _ -> pair(link) }
            .show()
    }

    private fun pair(link: PairingLink) {
        if (inFlight) return
        inFlight = true
        showConnecting(getString(R.string.pairing_with, link.origin), failed = false)
        val name = listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ").take(60)
        io.execute {
            val result = PairingApi.claim(link, name)
            main.post {
                inFlight = false
                when (result) {
                    is PairingApi.Claim.Ok -> {
                        computers = computers.withPaired(result.computer).also { store.save(it) }
                        connect()
                    }
                    is PairingApi.Claim.Failed -> showPairing(result.message)
                }
            }
        }
    }

    private fun confirmRemove(c: Computer) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.remove_title, c.name))
            .setMessage(R.string.remove_body)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.remove_ok) { _, _ -> forget(c) }
            .show()
    }

    /** Forget a computer on this phone. (Removing the phone on the computer's Settings page revokes it there.) */
    private fun forget(c: Computer) {
        computers = computers.without(c.id).also { store.save(it) }
        wipeWebData()
        showPairing()
    }

    private fun onRevoked(c: Computer) {
        computers = computers.without(c.id).also { store.save(it) }
        wipeWebData()
        showPairing(getString(R.string.err_revoked, c.name))
    }

    private fun wipeWebData() {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        web.clearCache(true)
        web.clearHistory()
        web.loadUrl("about:blank")
        currentOrigin = null
    }

    // ── Connecting and the web UI ────────────────────────────────────────────

    private fun connect() {
        val computer = computers.active ?: return showPairing()
        if (inFlight) return
        inFlight = true
        showConnecting(getString(R.string.connecting_to, computer.name), failed = false)
        io.execute {
            val result = PairingApi.session(computer)
            main.post {
                inFlight = false
                when (result) {
                    is PairingApi.Session.Ok -> {
                        val cm = CookieManager.getInstance()
                        for (line in result.cookies) cm.setCookie(computer.origin, line)
                        cm.flush()
                        lastCheck = System.currentTimeMillis()
                        currentOrigin = computer.origin
                        show(Screen.WEB)
                        web.loadUrl(computer.origin + "/")
                    }
                    PairingApi.Session.Revoked -> onRevoked(computer)
                    is PairingApi.Session.Unreachable -> showConnecting(result.message, failed = true)
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            userAgentString = "$userAgentString ohmydsh-android/${BuildConfig.VERSION_NAME}"
        }
        refresh.setColorSchemeResources(R.color.brand_blue)
        // DSH scrolls inside its own panes, so the page itself is always "at the top". Pull-to-refresh therefore only starts
        // from the top edge of the screen, where it cannot fight a chat that is scrolled.
        web.setOnTouchListener { _, e ->
            if (e.actionMasked == MotionEvent.ACTION_DOWN) downY = e.y
            false
        }
        refresh.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 || downY > 64 * resources.displayMetrics.density }
        refresh.setOnRefreshListener { web.reload() }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (isOwnOrigin(url)) return false
                openExternally(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { refresh.isRefreshing = true }
            override fun onPageFinished(view: WebView, url: String?) { refresh.isRefreshing = false }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) {
                // Only a failed top-level page matters: a 401 there means the sign-in expired or the phone was removed.
                if (request.isForMainFrame && error.statusCode == 401 && !inFlight) {
                    web.stopLoading()
                    connect()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    refresh.isRefreshing = false
                    showConnecting(getString(R.string.err_page, Computers.nameFor(currentOrigin ?: "")), failed = true)
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                pendingChooser?.onReceiveValue(null)
                pendingChooser = callback
                return try {
                    chooser.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    pendingChooser = null
                    callback.onReceiveValue(null)
                    Toast.makeText(this@MainActivity, R.string.err_no_files, Toast.LENGTH_SHORT).show()
                    false
                }
            }
        }
        web.setDownloadListener { url, _, _, _, _ -> openExternally(Uri.parse(url)) }
    }

    private fun isOwnOrigin(uri: Uri): Boolean {
        val origin = currentOrigin ?: return false
        return PairingLink.normalizeOrigin("${uri.scheme}://${uri.encodedAuthority}") == origin
    }

    private fun openExternally(uri: Uri) {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "mailto" && scheme != "tel") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.err_no_browser, Toast.LENGTH_SHORT).show()
        }
    }
}
