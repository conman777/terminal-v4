#!/bin/bash

# Phase 1 Integration Verification Script
# Tests all Phase 1 endpoints and functionality

set -e

BASE_URL="${BASE_URL:-http://localhost:3020}"
API_URL="$BASE_URL/api"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
print_header() {
    echo ""
    echo "=========================================="
    echo "$1"
    echo "=========================================="
}

print_test() {
    echo -e "${YELLOW}TEST:${NC} $1"
}

print_pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

print_fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

print_info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# Check if server is running
check_server() {
    print_header "Checking Server Health"
    print_test "GET /api/health"

    RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/health")
    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        print_pass "Server is healthy"
        print_info "Response: $BODY"
    else
        print_fail "Server health check failed (status: $STATUS_CODE)"
        exit 1
    fi
}

# Test browser session creation
test_create_session() {
    print_header "Testing Session Creation"
    print_test "POST /api/browser/sessions"

    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d '{"name":"Test Session 1"}' \
        "$API_URL/browser/sessions")

    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        SESSION_ID=$(echo "$BODY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [ -n "$SESSION_ID" ]; then
            print_pass "Session created: $SESSION_ID"
            echo "$SESSION_ID" > /tmp/test_session_id.txt
            return 0
        else
            print_fail "Session ID not found in response"
            return 1
        fi
    else
        print_fail "Failed to create session (status: $STATUS_CODE)"
        print_info "Response: $BODY"
        return 1
    fi
}

# Test listing sessions
test_list_sessions() {
    print_header "Testing Session Listing"
    print_test "GET /api/browser/sessions"

    RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/browser/sessions")
    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        SESSION_COUNT=$(echo "$BODY" | grep -o '"id"' | wc -l)
        print_pass "Listed sessions (count: $SESSION_COUNT)"
        print_info "Response preview: $(echo "$BODY" | head -c 200)..."
    else
        print_fail "Failed to list sessions (status: $STATUS_CODE)"
    fi
}

# Test getting a specific session
test_get_session() {
    print_header "Testing Get Session"

    if [ ! -f /tmp/test_session_id.txt ]; then
        print_fail "No session ID available for testing"
        return 1
    fi

    SESSION_ID=$(cat /tmp/test_session_id.txt)
    print_test "GET /api/browser/sessions/$SESSION_ID"

    RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/browser/sessions/$SESSION_ID")
    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        print_pass "Retrieved session details"
        print_info "Response: $(echo "$BODY" | head -c 200)..."
    else
        print_fail "Failed to get session (status: $STATUS_CODE)"
    fi
}

# Test updating session
test_update_session() {
    print_header "Testing Session Update"

    if [ ! -f /tmp/test_session_id.txt ]; then
        print_fail "No session ID available for testing"
        return 1
    fi

    SESSION_ID=$(cat /tmp/test_session_id.txt)
    print_test "PUT /api/browser/sessions/$SESSION_ID"

    RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
        -H "Content-Type: application/json" \
        -d '{"name":"Updated Test Session","currentUrl":"http://example.com"}' \
        "$API_URL/browser/sessions/$SESSION_ID")

    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        print_pass "Session updated successfully"
        print_info "Response: $(echo "$BODY" | head -c 200)..."
    else
        print_fail "Failed to update session (status: $STATUS_CODE)"
    fi
}

# Test activating session
test_activate_session() {
    print_header "Testing Session Activation"

    if [ ! -f /tmp/test_session_id.txt ]; then
        print_fail "No session ID available for testing"
        return 1
    fi

    SESSION_ID=$(cat /tmp/test_session_id.txt)
    print_test "PUT /api/browser/sessions/$SESSION_ID/activate"

    RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
        "$API_URL/browser/sessions/$SESSION_ID/activate")

    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        print_pass "Session activated successfully"
    else
        print_fail "Failed to activate session (status: $STATUS_CODE)"
    fi
}

# Test getting session logs
test_get_logs() {
    print_header "Testing Session Logs"

    if [ ! -f /tmp/test_session_id.txt ]; then
        print_fail "No session ID available for testing"
        return 1
    fi

    SESSION_ID=$(cat /tmp/test_session_id.txt)
    print_test "GET /api/browser/sessions/$SESSION_ID/logs"

    RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/browser/sessions/$SESSION_ID/logs")
    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        LOG_COUNT=$(echo "$BODY" | grep -o '"count":[0-9]*' | cut -d':' -f2)
        print_pass "Retrieved session logs (count: $LOG_COUNT)"
    else
        print_fail "Failed to get session logs (status: $STATUS_CODE)"
    fi
}

# Test browser stats
test_browser_stats() {
    print_header "Testing Browser Stats"
    print_test "GET /api/browser/stats"

    RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/browser/stats")
    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        print_pass "Retrieved browser stats"
        print_info "Response: $(echo "$BODY" | head -c 200)..."
    else
        print_fail "Failed to get browser stats (status: $STATUS_CODE)"
    fi
}

# Test creating multiple concurrent sessions
test_concurrent_sessions() {
    print_header "Testing Concurrent Session Creation"

    for i in {1..5}; do
        print_test "Creating session $i/5"

        RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -d "{\"name\":\"Concurrent Session $i\"}" \
            "$API_URL/browser/sessions")

        STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)

        if [ "$STATUS_CODE" = "200" ]; then
            print_pass "Concurrent session $i created"
        else
            print_fail "Failed to create concurrent session $i (status: $STATUS_CODE)"
        fi

        sleep 0.2
    done
}

# Test deleting session
test_delete_session() {
    print_header "Testing Session Deletion"

    if [ ! -f /tmp/test_session_id.txt ]; then
        print_fail "No session ID available for testing"
        return 1
    fi

    SESSION_ID=$(cat /tmp/test_session_id.txt)
    print_test "DELETE /api/browser/sessions/$SESSION_ID"

    RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE \
        "$API_URL/browser/sessions/$SESSION_ID")

    STATUS_CODE=$(echo "$RESPONSE" | tail -n 1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$STATUS_CODE" = "200" ]; then
        print_pass "Session deleted successfully"
        rm -f /tmp/test_session_id.txt
    else
        print_fail "Failed to delete session (status: $STATUS_CODE)"
    fi
}

# Test database file creation
test_database_file() {
    print_header "Testing Database Persistence"

    # Try multiple possible database locations
    POSSIBLE_PATHS=(
        "$HOME/terminal-v4/data/browser-storage.db"
        "$HOME/.local/share/terminal-v4/browser-storage.db"
        "$(pwd)/data/browser-storage.db"
    )

    DB_PATH=""
    for path in "${POSSIBLE_PATHS[@]}"; do
        if [ -f "$path" ]; then
            DB_PATH="$path"
            break
        fi
    done

    if [ -n "$DB_PATH" ]; then
        DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
        print_pass "Database file exists at $DB_PATH (size: $DB_SIZE)"

        # Check if sqlite3 is available
        if command -v sqlite3 >/dev/null 2>&1; then
            # Check if database has tables
            TABLE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>&1)
            if [ $? -eq 0 ]; then
                print_pass "Database has $TABLE_COUNT tables"
            else
                print_fail "Failed to query database: $TABLE_COUNT"
            fi

            # Check migration status
            MIGRATION_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM storage_migrations;" 2>&1)
            if [ $? -eq 0 ]; then
                print_pass "Database has $MIGRATION_COUNT applied migrations"
            else
                print_fail "Failed to check migrations"
            fi
        else
            print_info "sqlite3 not installed, skipping table inspection"
        fi
    else
        print_fail "Database file not found in any expected location"
        print_info "Checked: ${POSSIBLE_PATHS[*]}"
    fi
}

# Run all tests
main() {
    print_header "Phase 1 Integration Verification"
    print_info "Testing against: $BASE_URL"
    print_info "Timestamp: $(date)"

    # Health check first
    check_server

    # Database tests
    test_database_file

    # Session CRUD tests
    test_create_session
    test_list_sessions
    test_get_session
    test_update_session
    test_activate_session
    test_get_logs
    test_browser_stats

    # Concurrent session test
    test_concurrent_sessions

    # Cleanup
    test_delete_session

    # Summary
    print_header "Test Summary"
    echo "Tests Passed: $TESTS_PASSED"
    echo "Tests Failed: $TESTS_FAILED"
    echo "Total Tests: $((TESTS_PASSED + TESTS_FAILED))"

    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}All tests passed!${NC}"
        exit 0
    else
        echo -e "${RED}Some tests failed!${NC}"
        exit 1
    fi
}

# Run main function
main
