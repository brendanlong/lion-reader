// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.ktlint) apply false
    alias(libs.plugins.detekt) apply false
    alias(libs.plugins.sentry) apply false
}

// Task to vendor all dependencies to a local Maven repository for offline builds
// This creates a proper Maven repository structure that can be used with --offline flag
tasks.register("vendorDependencies") {
    description = "Downloads all dependencies to vendor-maven/ for offline builds"
    group = "build setup"

    doLast {
        val vendorDir = rootProject.file("vendor-maven")
        println("Vendor directory: ${vendorDir.absolutePath}")

        // Clean and create vendor directory
        if (vendorDir.exists()) {
            vendorDir.deleteRecursively()
        }
        vendorDir.mkdirs()

        // Maps to track what we've processed
        val processedModules = mutableSetOf<String>()
        val gradleCache = java.io.File("${System.getProperty("user.home")}/.gradle/caches/modules-2")

        fun copyModuleToVendor(group: String, name: String, version: String) {
            val moduleKey = "$group:$name:$version"
            if (moduleKey in processedModules) return
            processedModules.add(moduleKey)

            val groupPath = group.replace(".", "/")
            val targetDir = java.io.File(vendorDir, "$groupPath/$name/$version")

            // Find files in Gradle cache (files-2.1 structure)
            val cacheDir = java.io.File(gradleCache, "files-2.1/$group/$name/$version")
            if (cacheDir.exists()) {
                cacheDir.walkTopDown().filter { it.isFile }.forEach { sourceFile ->
                    targetDir.mkdirs()
                    // Rename artifacts to Maven standard: name-version.extension
                    val targetName = when (sourceFile.extension) {
                        "jar", "aar" -> "$name-$version.${sourceFile.extension}"
                        else -> sourceFile.name // POM and module files already have correct names
                    }
                    val targetFile = java.io.File(targetDir, targetName)
                    if (!targetFile.exists()) {
                        sourceFile.copyTo(targetFile)
                    }
                }
            }
        }

        // First, ensure all dependencies are downloaded by resolving all configurations
        rootProject.subprojects.forEach { subproject ->
            subproject.configurations.forEach { config ->
                if (config.isCanBeResolved) {
                    try {
                        config.resolvedConfiguration.resolvedArtifacts.forEach { artifact ->
                            val id = artifact.moduleVersion.id
                            copyModuleToVendor(id.group, id.name, id.version)
                        }
                    } catch (e: Exception) {
                        // Some configurations can't be resolved, skip them
                    }
                }
            }
        }

        val jarCount = vendorDir.walkTopDown().filter { it.extension == "jar" }.count()
        val aarCount = vendorDir.walkTopDown().filter { it.extension == "aar" }.count()

        println("Vendored ${processedModules.size} modules to vendor-maven/")
        println("  - $jarCount JAR files")
        println("  - $aarCount AAR files")
        println("")
        println("Next steps:")
        println("  1. git lfs track 'android/vendor-maven/**/*.jar'")
        println("  2. git lfs track 'android/vendor-maven/**/*.aar'")
        println("  3. git add android/vendor-maven .gitattributes")
        println("  4. git commit -m 'Vendor Android dependencies'")
    }
}
