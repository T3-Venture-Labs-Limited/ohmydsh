package ai.t3.ohmydsh

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** The two calls the app makes to DSH's pairing routes. Blocking: call from a background thread. No Android classes. */
object PairingApi {
    sealed interface Claim {
        data class Ok(val computer: Computer) : Claim
        data class Failed(val message: String) : Claim
    }

    sealed interface Session {
        /** `Set-Cookie` lines to hand to the WebView's cookie jar for this origin. */
        data class Ok(val cookies: List<String>) : Session
        /** The computer no longer knows this phone (removed in Settings, or its data was reset). */
        object Revoked : Session
        data class Unreachable(val message: String) : Session
    }

    private const val CONNECT_MS = 10_000
    private const val READ_MS = 15_000
    private const val MAX_BODY = 64 * 1024

    private fun open(origin: String, path: String): HttpURLConnection {
        val c = URL(origin + path).openConnection() as HttpURLConnection
        c.connectTimeout = CONNECT_MS
        c.readTimeout = READ_MS
        c.instanceFollowRedirects = false
        c.useCaches = false
        c.setRequestProperty("accept", "application/json")
        return c
    }

    private fun body(stream: java.io.InputStream?): String {
        if (stream == null) return ""
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (out.size() < MAX_BODY) {
            val n = stream.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toString("UTF-8")
    }

    private fun errorText(raw: String, fallback: String): String =
        try { JSONObject(raw).optString("error").ifEmpty { fallback } } catch (_: Exception) { fallback }

    /** Exchange the one-time code for a device token. */
    fun claim(link: PairingLink, deviceName: String): Claim {
        val c = try { open(link.origin, "/pair/claim") } catch (e: Exception) { return Claim.Failed("That address is not valid.") }
        return try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(JSONObject().put("code", link.code).put("deviceName", deviceName).toString().toByteArray()) }
            val status = c.responseCode
            val text = body(if (status in 200..299) c.inputStream else c.errorStream)
            when {
                status == 200 -> {
                    val json = JSONObject(text)
                    val token = json.optString("token")
                    val id = json.optJSONObject("device")?.optString("id").orEmpty()
                    if (token.isEmpty() || id.isEmpty()) Claim.Failed("The computer sent an unexpected answer. Is that address ohmydsh, with its phone app turned on?")
                    else Claim.Ok(Computer(id, Computers.nameFor(link.origin), link.origin, token))
                }
                status == 401 -> Claim.Failed("This pairing code is invalid, expired or already used. Make a new one in ohmydsh (Settings → Phone app).")
                status == 403 -> Claim.Failed("The computer refused this address. Start ohmydsh with --trusted-host for it, or use its Tailscale address.")
                status == 404 -> Claim.Failed("That server does not offer phone pairing. Update the ohmydsh phone app plugin.")
                status == 429 -> Claim.Failed("Too many attempts. Wait a few minutes and make a new code.")
                else -> Claim.Failed(errorText(text, "Pairing failed (HTTP $status)."))
            }
        } catch (e: java.net.UnknownHostException) {
            Claim.Failed("Cannot find that computer. Are the phone and the computer on the same Wi-Fi or Tailscale network?")
        } catch (e: java.net.SocketTimeoutException) {
            Claim.Failed("The computer did not answer. Check that ohmydsh is running and reachable.")
        } catch (e: javax.net.ssl.SSLException) {
            Claim.Failed("The secure connection failed: ${e.message ?: "certificate problem"}.")
        } catch (e: java.io.IOException) {
            Claim.Failed("Could not reach the computer (${e.message ?: "network error"}).")
        } catch (e: Exception) {
            Claim.Failed("The computer sent an unexpected answer.")
        } finally {
            c.disconnect()
        }
    }

    /** Trade the device token for a normal DSH sign-in cookie (the same one `/?token=` sets in a browser). */
    fun session(computer: Computer): Session {
        val c = try { open(computer.origin, "/pair/session") } catch (e: Exception) { return Session.Unreachable("That address is not valid.") }
        return try {
            c.requestMethod = "GET"
            c.setRequestProperty("authorization", "Bearer ${computer.token}")
            val status = c.responseCode
            when (status) {
                200, 302, 303 -> {
                    val cookies = c.headerFields.entries.firstOrNull { it.key.equals("set-cookie", ignoreCase = true) }?.value.orEmpty()
                    if (cookies.isEmpty()) Session.Unreachable("The computer did not sign this phone in.") else Session.Ok(cookies)
                }
                401 -> Session.Revoked
                403 -> Session.Unreachable("The computer refused this address (HTTP 403). Is ohmydsh started with --trusted-host for it?")
                429 -> Session.Unreachable("Too many attempts. Try again in a few minutes.")
                else -> Session.Unreachable("The computer answered HTTP $status.")
            }
        } catch (e: java.net.UnknownHostException) {
            Session.Unreachable("Cannot find ${Computers.nameFor(computer.origin)}. Is it on, and are you on the same Wi-Fi or Tailscale network?")
        } catch (e: java.net.SocketTimeoutException) {
            Session.Unreachable("${Computers.nameFor(computer.origin)} did not answer. Check that ohmydsh is running.")
        } catch (e: java.io.IOException) {
            Session.Unreachable("Could not reach ${Computers.nameFor(computer.origin)} (${e.message ?: "network error"}).")
        } finally {
            c.disconnect()
        }
    }
}
