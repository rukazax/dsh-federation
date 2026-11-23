plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "ru.dsh.hub"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.dsh.hub"
        minSdk = 24
        targetSdk = 35
        versionCode = 4
        versionName = "0.4"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.02")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.5")
    implementation("androidx.core:core-ktx:1.13.1")
    // Shizuku 13.1.5 (api + aidl + provider). Артефакты лежат в app/libs: с этого хоста
    // dl.google.com недоступен, а Gradle сначала спрашивает google() и висит на таймаутах.
    // На чистой сети эти три строки заменяются обычными координатами:
    //   implementation("dev.rikka.shizuku:api:13.1.5") / aidl / provider
    implementation(fileTree("libs") { include("*.aar") })
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
