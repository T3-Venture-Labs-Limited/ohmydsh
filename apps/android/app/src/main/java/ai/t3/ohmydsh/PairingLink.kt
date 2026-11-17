package ai.t3.ohmydsh

import java.net.URI
import java.net.URLDecoder

/** What a pairing QR code or pasted link carries: where the computer is and the one-time code. */
data class PairingLink(val origin: String, val code: String) {
    companion object {
        private val CODE = Regex("^[A-Za-z0-9_-]{16,64}$")

        /**
         * Accepts, in this order:
         *  - `ohmydsh://pair?u=<origin>&c=<code>` (the QR code)
         *  - `https://host/app/pair#<code>` (the plain link; `http://` too, for Wi-Fi without Tailscale)
         * Anything else, including a link with credentials, a path on the origin, or a malformed code, gives null.
         */
        fun parse(input: String): PairingLink? {
            val text = input.trim()
            if (text.isEmpty() || text.length > 2048) return null
            val uri = try { URI(text) } catch (_: Exception) { return null }
            return when (uri.scheme?.lowercase()) {
                "ohmydsh" -> fromAppLink(uri)
                "http", "https" -> fromWebLink(uri)
                else -> null
            }
        }

        private fun fromAppLink(uri: URI): PairingLink? {
            if (uri.host?.lowercase() != "pair") return null
            val params = queryParams(uri.rawQuery ?: return null)
            val origin = normalizeOrigin(params["u"] ?: return null) ?: return null
            val code = params["c"] ?: return null
            return if (CODE.matches(code)) PairingLink(origin, code) else null
        }

        private fun fromWebLink(uri: URI): PairingLink? {
            val path = uri.rawPath ?: ""
            if (path != "/app/pair" && path != "/app/pair/") return null
            if (uri.rawQuery != null) return null
            val code = uri.rawFragment ?: return null
            val origin = normalizeOrigin("${uri.scheme}://${uri.rawAuthority}") ?: return null
            return if (CODE.matches(code)) PairingLink(origin, code) else null
        }

        private fun queryParams(raw: String): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            for (part in raw.split('&')) {
                val at = part.indexOf('=')
                if (at <= 0) continue
                val key = URLDecoder.decode(part.substring(0, at), "UTF-8")
                if (key in out) return emptyMap() // a repeated key is ambiguous: refuse the whole link
                out[key] = URLDecoder.decode(part.substring(at + 1).replace("+", "%2B"), "UTF-8")
            }
            return out
        }

        /**
         * `scheme://host[:port]` in canonical form, or null. http and https only; no credentials, no path, query or fragment;
         * the default port is dropped and the host is lower-cased, so the same computer always maps to the same stored origin.
         */
        fun normalizeOrigin(input: String): String? {
            val uri = try { URI(input.trim()) } catch (_: Exception) { return null }
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            val path = uri.rawPath ?: ""
            if (path != "" && path != "/") return null
            val host = uri.host?.lowercase() ?: return null
            if (host.isEmpty()) return null
            val port = uri.port
            if (port == 0 || port > 65535) return null
            val defaultPort = if (scheme == "https") 443 else 80
            val shownHost = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            return if (port == -1 || port == defaultPort) "$scheme://$shownHost" else "$scheme://$shownHost:$port"
        }
    }
}
