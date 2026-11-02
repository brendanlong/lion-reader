# R8 rules for release builds. Libraries ship their own (kotlinx.serialization,
# OkHttp, Media3, AndroidX); these cover what reflection-by-name reaches in our
# own code.

# Navigation 3 saves the back stack by serializing each NavKey and restores it
# by looking the class (and its generated serializer) up by name.
-keep class * implements androidx.navigation3.runtime.NavKey { *; }

# JNA (enhanced voices: narration/PhononTts.kt) binds the native library's calls to
# interfaces by method name, and calls back into callbacks the same way.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn java.awt.**
