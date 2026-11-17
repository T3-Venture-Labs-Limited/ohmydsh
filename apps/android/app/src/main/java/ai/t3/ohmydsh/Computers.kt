package ai.t3.ohmydsh

import org.json.JSONArray
import org.json.JSONObject

/** One paired computer. `token` is the long-lived device token; it only ever leaves this app in an Authorization header. */
data class Computer(val id: String, val name: String, val origin: String, val token: String)

data class Computers(val items: List<Computer>, val activeId: String?) {
    val active: Computer? get() = items.firstOrNull { it.id == activeId } ?: items.firstOrNull()

    /** Add or replace (same origin = same computer) and make it the active one. */
    fun withPaired(computer: Computer): Computers =
        Computers(items.filterNot { it.origin == computer.origin || it.id == computer.id } + computer, computer.id)

    fun without(id: String): Computers {
        val rest = items.filterNot { it.id == id }
        return Computers(rest, if (activeId == id) rest.firstOrNull()?.id else activeId)
    }

    fun withActive(id: String): Computers = if (items.any { it.id == id }) copy(activeId = id) else this

    fun toJson(): String = JSONObject()
        .put("active", activeId ?: JSONObject.NULL)
        .put("computers", JSONArray(items.map { JSONObject().put("id", it.id).put("name", it.name).put("origin", it.origin).put("token", it.token) }))
        .toString()

    companion object {
        val EMPTY = Computers(emptyList(), null)

        fun fromJson(text: String?): Computers {
            if (text.isNullOrBlank()) return EMPTY
            return try {
                val root = JSONObject(text)
                val arr = root.optJSONArray("computers") ?: JSONArray()
                val items = (0 until arr.length()).mapNotNull { i ->
                    val o = arr.optJSONObject(i) ?: return@mapNotNull null
                    val origin = PairingLink.normalizeOrigin(o.optString("origin")) ?: return@mapNotNull null
                    val token = o.optString("token")
                    val id = o.optString("id")
                    if (token.isEmpty() || id.isEmpty()) null else Computer(id, o.optString("name").ifEmpty { origin }, origin, token)
                }
                Computers(items, if (root.isNull("active")) null else root.optString("active"))
            } catch (_: Exception) {
                EMPTY
            }
        }

        /** A readable default name for a computer: its host name without the tailnet suffix noise. */
        fun nameFor(origin: String): String = origin.substringAfter("://").substringBefore(':').removeSuffix(".ts.net")
    }
}
