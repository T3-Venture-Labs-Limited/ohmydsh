import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version comes from the release tag in CI (-PappVersion=0.1.0 -PappVersionCode=1000) and falls back to the dev value.
val appVersion = (findProperty("appVersion") as String?) ?: "0.1.0"
val appVersionCode = ((findProperty("appVersionCode") as String?) ?: "1000").toInt()

android {
    namespace = "ai.t3.ohmydsh"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.t3.ohmydsh"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
    }

    // Release signing: all four values come from the environment (CI repo secrets) or a git-ignored keystore.properties.
    // Without them the release build is signed with the debug key and says so loudly; never commit a keystore.
    val ksFile = System.getenv("OHMYDSH_KEYSTORE_FILE")?.let { File(it) }
    signingConfigs {
        if (ksFile != null && ksFile.exists()) {
            create("release") {
                storeFile = ksFile
                storePassword = System.getenv("OHMYDSH_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("OHMYDSH_KEY_ALIAS")
                keyPassword = System.getenv("OHMYDSH_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: run {
                logger.warn("WARNING: no release keystore configured; signing the release APK with the DEBUG key. Do not publish it.")
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "DebugProbesKt.bin")
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.google.android.material:material:1.12.0")
    // QR scanner (Apache-2.0): ZXing core + a camera view; no Google Play services needed.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
