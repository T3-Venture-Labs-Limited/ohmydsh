# WebView JS interface is not used; keep zxing's camera classes reflectively accessed by the scanner.
-keep class com.journeyapps.barcodescanner.** { *; }
-dontwarn com.google.zxing.**
# security-crypto / Tink reference compile-time-only annotation classes.
-dontwarn javax.annotation.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn org.checkerframework.**
-keep class androidx.security.crypto.** { *; }
-keep class com.google.crypto.tink.** { *; }
# Tink's optional key downloader pulls in google-http-client, which we neither ship nor call.
-dontwarn com.google.api.client.http.**
-dontwarn org.joda.time.**
