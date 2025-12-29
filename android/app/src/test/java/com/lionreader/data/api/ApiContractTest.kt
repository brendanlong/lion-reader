package com.lionreader.data.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.TestInstance
import java.net.HttpURLConnection
import java.net.URL
import kotlin.test.assertTrue

/**
 * Contract test that validates the Android client's API paths against the server's OpenAPI spec.
 *
 * This test fetches the OpenAPI specification from the production server and verifies that
 * all API paths used by [LionReaderApiImpl] exist in the spec. This catches mismatches between
 * the client and server early, before they cause runtime 404 errors.
 *
 * The test requires network access to the production server. If the server is unreachable,
 * the test will be skipped (not failed) to avoid breaking CI in case of network issues.
 *
 * To run this test locally:
 *   ./gradlew testDebugUnitTest --tests "*.ApiContractTest"
 *
 * To force the test to fail on network issues (e.g., in CI):
 *   ./gradlew testDebugUnitTest --tests "*.ApiContractTest" -DAPI_CONTRACT_TEST_STRICT=true
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ApiContractTest {
    private lateinit var openApiPaths: Set<PathWithMethod>
    private var fetchError: Exception? = null

    /**
     * All API paths used by [LionReaderApiImpl].
     *
     * IMPORTANT: When adding new API endpoints to [LionReaderApiImpl], add them here too!
     * This list should mirror all the paths in [LionReaderApiImpl].
     */
    private val clientPaths =
        listOf(
            // Auth endpoints
            PathWithMethod("POST", "auth/login"),
            PathWithMethod("GET", "auth/providers"),
            PathWithMethod("GET", "auth/me"),
            PathWithMethod("POST", "auth/logout"),
            // Subscription endpoints
            PathWithMethod("GET", "subscriptions"),
            // Tag endpoints
            PathWithMethod("GET", "tags"),
            // Entry endpoints
            PathWithMethod("GET", "entries"),
            PathWithMethod("GET", "entries/{id}"),
            PathWithMethod("POST", "entries/mark-read"),
            PathWithMethod("POST", "entries/{id}/star"),
            PathWithMethod("DELETE", "entries/{id}/star"),
        )

    @BeforeAll
    fun fetchOpenApiSpec() {
        try {
            val url = URL(OPENAPI_URL)
            val connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000

            if (connection.responseCode != 200) {
                throw RuntimeException("Failed to fetch OpenAPI spec: HTTP ${connection.responseCode}")
            }

            val responseBody = connection.inputStream.bufferedReader().use { it.readText() }
            val spec = json.decodeFromString<OpenApiSpec>(responseBody)

            // Extract paths from the spec, normalizing them to match our client format
            // OpenAPI paths look like "/auth/login", we want "auth/login"
            openApiPaths =
                spec.paths.flatMap { (path, methods) ->
                    val normalizedPath = path.removePrefix("/")
                    methods.keys.map { method ->
                        PathWithMethod(method.uppercase(), normalizedPath)
                    }
                }.toSet()
        } catch (e: Exception) {
            fetchError = e
            System.err.println("Failed to fetch OpenAPI spec: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    @TestFactory
    @DisplayName("Client API paths exist in server OpenAPI spec")
    fun verifyClientPathsExistInSpec(): List<DynamicTest> {
        // Check if we should skip or fail on network errors
        val strictMode = System.getProperty("API_CONTRACT_TEST_STRICT")?.toBoolean() ?: false

        if (fetchError != null) {
            if (strictMode) {
                throw fetchError!!
            }
            // In non-strict mode, skip all tests if we couldn't fetch the spec
            return listOf(
                DynamicTest.dynamicTest("OpenAPI spec fetch") {
                    assumeTrue(
                        false,
                        "Skipping: Could not fetch OpenAPI spec from $OPENAPI_URL: " +
                            "${fetchError?.javaClass?.simpleName}: ${fetchError?.message}",
                    )
                },
            )
        }

        return clientPaths.map { clientPath ->
            DynamicTest.dynamicTest("${clientPath.method} ${clientPath.path}") {
                // Normalize path parameters: client uses {id}, OpenAPI might use {entryId}
                val normalizedClientPath = normalizePathParameters(clientPath.path)
                val matchingPath =
                    openApiPaths.any { specPath ->
                        specPath.method == clientPath.method &&
                            normalizePathParameters(specPath.path) == normalizedClientPath
                    }

                assertTrue(
                    matchingPath,
                    """
                    |API path not found in server OpenAPI spec!
                    |
                    |Client path: ${clientPath.method} ${clientPath.path}
                    |
                    |This means the Android client is calling an endpoint that doesn't exist on the server.
                    |
                    |Possible causes:
                    |1. The endpoint was removed or renamed on the server
                    |2. The client path has a typo
                    |3. The OpenAPI spec is out of date
                    |
                    |Available ${clientPath.method} paths in spec:
                    |${openApiPaths.filter { it.method == clientPath.method }.joinToString("\n") { "  - ${it.path}" }}
                    """.trimMargin(),
                )
            }
        }
    }

    /**
     * Normalize path parameters to a common format for comparison.
     * Converts specific parameter names like {entryId} to generic {param} format.
     */
    private fun normalizePathParameters(path: String): String = path.replace(Regex("\\{[^}]+}"), "{param}")

    data class PathWithMethod(
        val method: String,
        val path: String,
    )

    @Serializable
    data class OpenApiSpec(
        val paths: Map<String, Map<String, kotlinx.serialization.json.JsonElement>>,
    )

    companion object {
        private const val OPENAPI_URL = "https://lion-reader.fly.dev/api/openapi"

        private val json =
            Json {
                ignoreUnknownKeys = true
                isLenient = true
            }
    }
}
