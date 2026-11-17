package ai.t3.ohmydsh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingLinkTest {
    private val code = "yy8BfchgplkbY5zezk1Gbg" // 22 chars, the shape DSH issues

    @Test fun `parses the QR link with an https origin`() {
        val link = PairingLink.parse("ohmydsh://pair?u=https%3A%2F%2Flaptop.tail1234.ts.net&c=$code")
        assertEquals(PairingLink("https://laptop.tail1234.ts.net", code), link)
    }

    @Test fun `parses the QR link with a LAN http origin and port`() {
        val link = PairingLink.parse("ohmydsh://pair?u=http%3A%2F%2F192.168.1.121%3A3080&c=$code")
        assertEquals(PairingLink("http://192.168.1.121:3080", code), link)
    }

    @Test fun `parses the plain https fallback link and the http one`() {
        assertEquals(PairingLink("https://laptop.tail1234.ts.net", code), PairingLink.parse("https://laptop.tail1234.ts.net/app/pair#$code"))
        assertEquals(PairingLink("http://10.0.0.5:34567", code), PairingLink.parse("http://10.0.0.5:34567/app/pair#$code"))
        assertEquals(PairingLink("https://a.ts.net", code), PairingLink.parse("  https://A.ts.net:443/app/pair/#$code \n"))
    }

    @Test fun `origin is canonical so one computer is one entry`() {
        assertEquals("https://a.ts.net", PairingLink.normalizeOrigin("HTTPS://A.TS.NET:443/"))
        assertEquals("http://a:80".replace(":80", ""), PairingLink.normalizeOrigin("http://a:80"))
        assertEquals("http://[::1]:3080", PairingLink.normalizeOrigin("http://[::1]:3080"))
    }

    @Test fun `rejects anything that is not exactly a pairing link`() {
        val bad = listOf(
            "", "   ", "hello", code,
            "ohmydsh://pair?u=https%3A%2F%2Fa.ts.net", // no code
            "ohmydsh://pair?c=$code", // no origin
            "ohmydsh://other?u=https%3A%2F%2Fa.ts.net&c=$code", // wrong host
            "ohmydsh://pair?u=https%3A%2F%2Fa.ts.net&c=short", // code too short
            "ohmydsh://pair?u=https%3A%2F%2Fa.ts.net&c=${"a".repeat(65)}", // code too long
            "ohmydsh://pair?u=https%3A%2F%2Fa.ts.net&c=$code%21", // code with a symbol
            "ohmydsh://pair?u=ftp%3A%2F%2Fa.ts.net&c=$code", // scheme
            "ohmydsh://pair?u=javascript%3Aalert(1)&c=$code",
            "ohmydsh://pair?u=https%3A%2F%2Fuser%3Apw%40a.ts.net&c=$code", // credentials
            "ohmydsh://pair?u=https%3A%2F%2Fa.ts.net%2Fevil&c=$code", // path on the origin
            "ohmydsh://pair?u=https%3A%2F%2Fa.ts.net%3Fx%3D1&c=$code", // query on the origin
            "ohmydsh://pair?u=https%3A%2F%2Fa.ts.net&u=https%3A%2F%2Fevil.example&c=$code", // repeated key
            "https://a.ts.net/app/pair", // no fragment
            "https://a.ts.net/other#$code", // wrong path
            "https://a.ts.net/app/pair?x=1#$code", // query
            "https://user@a.ts.net/app/pair#$code", // credentials
            "ftp://a.ts.net/app/pair#$code",
            "https://a.ts.net/app/pair#" + "x".repeat(3000),
        )
        for (text in bad) assertNull("should reject: ${text.take(60)}", PairingLink.parse(text))
    }

    @Test fun `different computers stay different`() {
        assertNotEquals(PairingLink.normalizeOrigin("https://a.ts.net"), PairingLink.normalizeOrigin("https://a.ts.net:8443"))
    }
}
