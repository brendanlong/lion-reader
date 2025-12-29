#!/bin/bash
# Creates the test database in addition to the default database
# This script runs automatically when the PostgreSQL container starts

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE lionreader_test;
    GRANT ALL PRIVILEGES ON DATABASE lionreader_test TO lionreader;
EOSQL

echo "Test database 'lionreader_test' created successfully"
