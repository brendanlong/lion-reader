package com.lionreader.shared.db

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlin.test.Test
import kotlin.test.assertEquals

class LionReaderDatabaseTest {
    @Test
    fun upsertReplacesExistingValue() {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            LionReaderDatabase.Schema.create(driver)
            val queries = LionReaderDatabase(driver).appMetadataQueries
            queries.upsert("schema", "1")
            queries.upsert("schema", "2")
            assertEquals("2", queries.selectValue("schema").executeAsOne())
        }
    }
}
