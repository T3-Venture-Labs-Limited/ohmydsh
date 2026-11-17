package ai.t3.ohmydsh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComputersTest {
    private val a = Computer("a1", "laptop", "https://laptop.ts.net", "dsh-dev_A")
    private val b = Computer("b2", "desktop", "http://192.168.1.5:3080", "dsh-dev_B")

    @Test fun `pairing adds and activates and the same origin replaces its entry`() {
        var c = Computers.EMPTY.withPaired(a)
        assertEquals("a1", c.active?.id)
        c = c.withPaired(b)
        assertEquals(listOf("a1", "b2"), c.items.map { it.id }); assertEquals("b2", c.activeId)
        c = c.withPaired(a.copy(id = "a9", token = "dsh-dev_NEW"))
        assertEquals(listOf("b2", "a9"), c.items.map { it.id }); assertEquals("dsh-dev_NEW", c.active?.token)
    }

    @Test fun `removing the active computer falls back to another and removing the last leaves none`() {
        val c = Computers.EMPTY.withPaired(a).withPaired(b)
        val after = c.without("b2")
        assertEquals("a1", after.active?.id)
        assertNull(after.without("a1").active)
        assertTrue(after.without("a1").items.isEmpty())
    }

    @Test fun `switching only works for known computers`() {
        val c = Computers.EMPTY.withPaired(a).withPaired(b)
        assertEquals("a1", c.withActive("a1").active?.id)
        assertEquals("b2", c.withActive("zzz").active?.id)
    }

    @Test fun `json round trip keeps everything`() {
        val c = Computers.EMPTY.withPaired(a).withPaired(b).withActive("a1")
        assertEquals(c, Computers.fromJson(c.toJson()))
    }

    @Test fun `corrupt or hostile storage never crashes and never yields a bad origin`() {
        assertEquals(Computers.EMPTY, Computers.fromJson(null))
        assertEquals(Computers.EMPTY, Computers.fromJson("not json"))
        val hostile = """{"active":"x","computers":[{"id":"x","name":"n","origin":"javascript:alert(1)","token":"t"},{"id":"y","name":"n","origin":"https://ok.ts.net/evil","token":"t"},{"id":"","name":"n","origin":"https://ok.ts.net","token":"t"},{"id":"z","name":"","origin":"https://ok.ts.net","token":""}]}"""
        assertTrue(Computers.fromJson(hostile).items.isEmpty())
    }

    @Test fun `the token is only in the encrypted json, names are readable`() {
        assertEquals("laptop.tail1234", Computers.nameFor("https://laptop.tail1234.ts.net"))
        assertEquals("192.168.1.5", Computers.nameFor("http://192.168.1.5:3080"))
        assertFalse(a.toString().isEmpty())
    }
}
