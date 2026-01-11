// Check if vendored dependencies exist
val vendorMavenDir = file("vendor-maven")
val useVendoredDeps = vendorMavenDir.exists() && vendorMavenDir.listFiles()?.isNotEmpty() == true

pluginManagement {
    repositories {
        // Vendored dependencies take priority when available
        if (file("vendor-maven").exists()) {
            maven {
                url = uri("vendor-maven")
                content {
                    includeGroupByRegex(".*")
                }
            }
        }
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // Vendored dependencies take priority when available
        if (file("vendor-maven").exists()) {
            maven {
                url = uri("vendor-maven")
                content {
                    includeGroupByRegex(".*")
                }
            }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "LionReader"
include(":app")
