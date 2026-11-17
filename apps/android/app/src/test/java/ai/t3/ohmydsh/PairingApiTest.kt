package ai.t3.ohmydsh

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Drives the app's real HTTP client against a local server that speaks the plugin's wire contract. */
class PairingApiTest {
    private val server = MockWebServer().also { it.start() }
    private val origin get() = "http://${server.hostName}:${server.port}"
    private val code = "yy8BfchgplkbY5zezk1Gbg"

    @After fun stop() = server.shutdown()

    private fun answer(status: Int, body: String = "", vararg headers: Pair<String, String>) {
        server.enqueue(MockResponse().setResponseCode(status).setBody(body).also { r -> headers.forEach { (k, v) -> r.addHeader(k, v) } })
    }

    @Test fun `claim sends code and device name and returns the paired computer`() {
        answer(200, """{"ok":true,"device":{"id":"0a4f5b6162d58597ef4ec2d2","name":"Pixel"},"token":"dsh-dev_abc"}""")
        val r = PairingApi.claim(PairingLink(origin, code), "Google Pixel 8")
        assertTrue(r is PairingApi.Claim.Ok)
        val c = (r as PairingApi.Claim.Ok).computer
        assertEquals("dsh-dev_abc", c.token); assertEquals("0a4f5b6162d58597ef4ec2d2", c.id); assertEquals(origin, c.origin)
        val req = server.takeRequest()
        assertEquals("POST", req.method); assertEquals("/pair/claim", req.path)
        assertTrue(req.getHeader("content-type")!!.startsWith("application/json"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"code\":\"$code\"")); assertTrue(body.contains("Google Pixel 8"))
    }

    @Test fun `claim maps failures to messages a person can act on`() {
        val cases = mapOf(401 to "invalid, expired or already used", 403 to "trusted-host", 404 to "Update the ohmydsh phone app plugin", 429 to "Too many attempts")
        for ((status, expect) in cases) {
            answer(status)
            val r = PairingApi.claim(PairingLink(origin, code), "x")
            assertTrue("status $status", r is PairingApi.Claim.Failed)
            assertTrue("$status -> ${(r as PairingApi.Claim.Failed).message}", r.message.contains(expect))
        }
    }

    @Test fun `claim with an answer that is not a DSH reply fails cleanly`() {
        answer(200, "<html>hello</html>")
        assertTrue(PairingApi.claim(PairingLink(origin, code), "x") is PairingApi.Claim.Failed)
    }

    @Test fun `claim reports an unreachable computer`() {
        val dead = MockWebServer().also { it.start() }; val port = dead.port; dead.shutdown()
        assertTrue(PairingApi.claim(PairingLink("http://127.0.0.1:$port", code), "x") is PairingApi.Claim.Failed)
    }

    @Test fun `session sends the device token as a bearer header and returns the sign-in cookies`() {
        answer(303, "", "Set-Cookie" to "dsh-auth-abc=v1.x.y; Path=/; HttpOnly; SameSite=Strict", "Location" to "/")
        val r = PairingApi.session(Computer("id", "laptop", origin, "dsh-dev_tok"))
        assertTrue(r is PairingApi.Session.Ok)
        val req = server.takeRequest()
        assertEquals("GET", req.method); assertEquals("/pair/session", req.path); assertEquals("Bearer dsh-dev_tok", req.getHeader("authorization"))
        assertTrue((r as PairingApi.Session.Ok).cookies.single().startsWith("dsh-auth-abc="))
    }

    @Test fun `session 401 means the phone was removed on the computer`() {
        answer(401, """{"ok":false}""")
        assertEquals(PairingApi.Session.Revoked, PairingApi.session(Computer("id", "laptop", origin, "dsh-dev_tok")))
    }

    @Test fun `session without a cookie, 403 and 500 are not mistaken for success or revocation`() {
        answer(303); answer(403); answer(500)
        repeat(3) { assertTrue(PairingApi.session(Computer("id", "l", origin, "t")) is PairingApi.Session.Unreachable) }
    }

    /** Opt-in: OHMYDSH_LIVE_ORIGIN and OHMYDSH_LIVE_CODE point at a real DSH with the phone app plugin. */
    @Test fun `live DSH pair then session`() {
        val live = System.getenv("OHMYDSH_LIVE_ORIGIN"); val liveCode = System.getenv("OHMYDSH_LIVE_CODE")
        assumeTrue(live != null && liveCode != null)
        val link = PairingLink.parse("ohmydsh://pair?u=${java.net.URLEncoder.encode(live, "UTF-8")}&c=$liveCode")!!
        val claim = PairingApi.claim(link, "JVM test phone") as PairingApi.Claim.Ok
        val session = PairingApi.session(claim.computer)
        println("LIVE session: " + session::class.simpleName)
        assertTrue(session is PairingApi.Session.Ok)
        assertTrue((session as PairingApi.Session.Ok).cookies.any { it.startsWith("dsh-auth-") && it.contains("HttpOnly") })
        System.getenv("OHMYDSH_LIVE_DEVICE_FILE")?.let { java.io.File(it).writeText(claim.computer.id + "\n" + claim.computer.token) }
    }
}
