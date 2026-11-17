package ai.t3.ohmydsh

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** The paired computers, encrypted at rest with a hardware-backed Android Keystore key (AES-256). Excluded from backups. */
class Store(context: Context) {
    private val prefs: SharedPreferences = try {
        open(context)
    } catch (e: Exception) {
        // A Keystore key that was invalidated (for example after a restore) cannot decrypt the old file: start clean.
        context.deleteSharedPreferences(FILE)
        open(context)
    }

    private fun open(context: Context): SharedPreferences {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            context, FILE, key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun load(): Computers = Computers.fromJson(prefs.getString(KEY, null))

    fun save(computers: Computers) {
        prefs.edit().putString(KEY, computers.toJson()).apply()
    }

    private companion object {
        const val FILE = "ohmydsh_computers"
        const val KEY = "computers"
    }
}
