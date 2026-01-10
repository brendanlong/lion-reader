#!/bin/bash
#
# gradle-proxy-bootstrap.sh
#
# Downloads Gradle dependencies via curl when Java/Gradle can't authenticate
# with an HTTPS proxy. This is a workaround for environments where https_proxy
# is set with authentication credentials, but Java's HttpURLConnection doesn't
# support proxy authentication for HTTPS CONNECT tunneling.
#
# Usage:
#   ./android/scripts/gradle-proxy-bootstrap.sh
#
# The script will:
#   1. Download the Gradle distribution if needed
#   2. Iteratively discover missing dependencies by running Gradle
#   3. Download each missing dependency via curl
#   4. Set up a local Maven repository that Gradle can use
#   5. Keep iterating until Gradle succeeds or no progress is made
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(dirname "$SCRIPT_DIR")"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
LOCAL_REPO="/tmp/gradle-proxy-bootstrap-repo"
DOWNLOADED_LIST="/tmp/gradle-proxy-downloaded.txt"
MAX_ITERATIONS=50

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Maven repositories to search (in order of preference)
MAVEN_REPOS=(
    "https://dl.google.com/dl/android/maven2"
    "https://repo.maven.apache.org/maven2"
    "https://plugins.gradle.org/m2"
)

# Check if proxy is configured
check_proxy() {
    if [[ -z "${https_proxy:-}" && -z "${HTTPS_PROXY:-}" ]]; then
        log_error "No https_proxy configured. This script is for proxy environments."
        log_info "If Gradle is failing for other reasons, check your network connection."
        exit 1
    fi

    local proxy="${https_proxy:-$HTTPS_PROXY}"
    log_info "Using proxy: ${proxy%%@*}@..." # Hide credentials
}

# Download Gradle distribution if needed
bootstrap_gradle() {
    local wrapper_props="$ANDROID_DIR/gradle/wrapper/gradle-wrapper.properties"
    if [[ ! -f "$wrapper_props" ]]; then
        log_error "gradle-wrapper.properties not found at $wrapper_props"
        exit 1
    fi

    local dist_url=$(grep "distributionUrl" "$wrapper_props" | cut -d'=' -f2 | sed 's/\\//g')
    local dist_name=$(basename "$dist_url")
    local dist_base="${dist_name%.zip}"

    # Check if already downloaded
    local cache_dir="$GRADLE_USER_HOME/wrapper/dists/$dist_base"
    if [[ -d "$cache_dir" ]] && find "$cache_dir" -name "gradle-*" -type d | grep -q .; then
        log_info "Gradle distribution already cached"
        return 0
    fi

    log_info "Downloading Gradle distribution: $dist_name"

    # Find or create the hash directory
    mkdir -p "$cache_dir"
    local hash_dir=$(find "$cache_dir" -maxdepth 1 -type d -name "*" ! -name "$(basename "$cache_dir")" | head -1)
    if [[ -z "$hash_dir" ]]; then
        # Create a hash directory (Gradle uses a hash of the URL)
        hash_dir="$cache_dir/$(echo "$dist_url" | md5sum | cut -c1-16)"
        mkdir -p "$hash_dir"
    fi

    # Download
    local temp_zip="/tmp/$dist_name"
    if ! curl -fSL -o "$temp_zip" "$dist_url"; then
        log_error "Failed to download Gradle distribution"
        exit 1
    fi

    # Clean up old files and extract
    rm -f "$hash_dir"/*.lck "$hash_dir"/*.part
    cp "$temp_zip" "$hash_dir/"
    cd "$hash_dir" && unzip -q "$dist_name" && cd - > /dev/null
    rm "$temp_zip"

    log_info "Gradle distribution installed"
}

# Download a Maven artifact
download_artifact() {
    local group="$1"
    local artifact="$2"
    local version="$3"
    local extension="${4:-pom}"

    local group_path="${group//./\/}"
    local filename="${artifact}-${version}.${extension}"
    local cache_key="${group}:${artifact}:${version}:${extension}"

    # Skip if already downloaded
    if grep -qF "$cache_key" "$DOWNLOADED_LIST" 2>/dev/null; then
        return 0
    fi

    # Try each repository
    for base_url in "${MAVEN_REPOS[@]}"; do
        local url="${base_url}/${group_path}/${artifact}/${version}/${filename}"
        local dest_dir="$LOCAL_REPO/$group_path/$artifact/$version"
        local dest_file="$dest_dir/$filename"

        # Skip if file exists
        if [[ -f "$dest_file" ]]; then
            echo "$cache_key" >> "$DOWNLOADED_LIST"
            return 0
        fi

        mkdir -p "$dest_dir"

        if curl -fsSL -o "$dest_file" "$url" 2>/dev/null; then
            echo "$cache_key" >> "$DOWNLOADED_LIST"

            # If it's a POM, also try to download JAR/AAR and module metadata
            if [[ "$extension" == "pom" ]]; then
                download_artifact "$group" "$artifact" "$version" "jar" 2>/dev/null || true
                download_artifact "$group" "$artifact" "$version" "aar" 2>/dev/null || true
                download_artifact "$group" "$artifact" "$version" "module" 2>/dev/null || true

                # Parse POM for dependencies and queue them
                extract_dependencies "$dest_file"
            fi

            return 0
        fi
        rm -f "$dest_file"
    done

    return 1
}

# Extract dependencies from a POM file
extract_dependencies() {
    local pom="$1"

    # Simple XML parsing with grep/sed (not perfect but works for most cases)
    # Extract groupId, artifactId, version from dependency blocks
    grep -A10 "<dependency>" "$pom" 2>/dev/null | \
        grep -E "<(groupId|artifactId|version)>" | \
        sed 's/.*<groupId>\([^<]*\)<\/groupId>.*/GROUP:\1/' | \
        sed 's/.*<artifactId>\([^<]*\)<\/artifactId>.*/ARTIFACT:\1/' | \
        sed 's/.*<version>\([^<]*\)<\/version>.*/VERSION:\1/' | \
        tr '\n' ':' | \
        sed 's/GROUP:/\nGROUP:/g' | \
        grep "^GROUP:" | \
        while read -r line; do
            local g=$(echo "$line" | sed 's/.*GROUP:\([^:]*\).*/\1/')
            local a=$(echo "$line" | sed 's/.*ARTIFACT:\([^:]*\).*/\1/')
            local v=$(echo "$line" | sed 's/.*VERSION:\([^:]*\).*/\1/' | tr -d ':')

            # Skip if version contains variables like ${something}
            if [[ -n "$g" && -n "$a" && -n "$v" && ! "$v" =~ \$ ]]; then
                echo "${g}:${a}:${v}" >> /tmp/gradle-proxy-deps-queue.txt
            fi
        done
}

# Process queued dependencies
process_dependency_queue() {
    local queue_file="/tmp/gradle-proxy-deps-queue.txt"
    [[ -f "$queue_file" ]] || return 0

    local count=0
    while IFS=: read -r group artifact version; do
        [[ -z "$group" ]] && continue
        if download_artifact "$group" "$artifact" "$version" "pom"; then
            ((count++))
        fi
    done < "$queue_file"

    > "$queue_file"  # Clear queue
    echo "$count"
}

# Set up Gradle init script to use local repo
setup_gradle_init() {
    local init_dir="$GRADLE_USER_HOME/init.d"
    mkdir -p "$init_dir"

    cat > "$init_dir/proxy-bootstrap-repo.gradle" << 'GRADLE_INIT'
// Added by gradle-proxy-bootstrap.sh
// Configures a local Maven repository for dependencies downloaded via curl

settingsEvaluated { settings ->
    settings.pluginManagement {
        repositories {
            maven {
                url = uri("file:///tmp/gradle-proxy-bootstrap-repo")
                metadataSources {
                    mavenPom()
                    artifact()
                }
            }
        }
    }
}
GRADLE_INIT

    log_info "Gradle init script created: $init_dir/proxy-bootstrap-repo.gradle"
}

# Parse Gradle error output for missing artifacts
parse_missing_artifact() {
    local output="$1"

    # Look for patterns like:
    # "could not resolve plugin artifact 'group:artifact.gradle.plugin:version'"
    # "Could not find group:artifact:version"

    echo "$output" | grep -oE "could not resolve[^']*'[^']+'" | \
        sed "s/.*'\([^']*\)'.*/\1/" | \
        head -1

    echo "$output" | grep -oE "Could not find [^.]+\.[^:]+:[^:]+:[^.]+" | \
        sed 's/Could not find //' | \
        head -1
}

# Run Gradle and check for missing dependencies
run_gradle_check() {
    cd "$ANDROID_DIR"

    # Run with minimal JVM options
    export JAVA_TOOL_OPTIONS="-Djdk.http.auth.tunneling.disabledSchemes= -Djdk.http.auth.proxying.disabledSchemes="

    local output
    output=$(./gradlew help --no-daemon --no-configuration-cache 2>&1) || true

    if echo "$output" | grep -q "BUILD SUCCESSFUL"; then
        return 0
    fi

    # Extract the missing artifact
    local missing=$(parse_missing_artifact "$output")
    if [[ -n "$missing" ]]; then
        echo "$missing"
        return 1
    fi

    # Check for other specific patterns
    if echo "$output" | grep -q "could not resolve plugin artifact"; then
        echo "$output" | grep "could not resolve plugin artifact" | \
            sed "s/.*'\([^']*\)'.*/\1/" | head -1
        return 1
    fi

    # Unknown error
    echo "$output" >&2
    return 2
}

# Convert plugin ID to Maven coordinates
plugin_to_maven() {
    local plugin="$1"

    # Plugin markers use the pattern: pluginId:pluginId.gradle.plugin:version
    if [[ "$plugin" =~ ^([^:]+):([^:]+)\.gradle\.plugin:(.+)$ ]]; then
        echo "${BASH_REMATCH[1]}:${BASH_REMATCH[2]}.gradle.plugin:${BASH_REMATCH[3]}"
    else
        echo "$plugin"
    fi
}

# Main bootstrap loop
main() {
    log_info "Gradle Proxy Bootstrap"
    log_info "======================"

    check_proxy

    # Initialize
    mkdir -p "$LOCAL_REPO"
    > "$DOWNLOADED_LIST"
    > /tmp/gradle-proxy-deps-queue.txt

    # Step 1: Bootstrap Gradle itself
    log_info "Step 1: Ensuring Gradle distribution is available..."
    bootstrap_gradle

    # Step 2: Set up init script
    log_info "Step 2: Setting up Gradle init script..."
    setup_gradle_init

    # Step 3: Iteratively resolve dependencies
    log_info "Step 3: Resolving dependencies..."

    local iteration=0
    local last_missing=""
    local stuck_count=0

    while [[ $iteration -lt $MAX_ITERATIONS ]]; do
        ((iteration++))
        log_info "Iteration $iteration/$MAX_ITERATIONS"

        local missing
        if missing=$(run_gradle_check); then
            log_info "BUILD SUCCESSFUL!"
            break
        fi

        if [[ -z "$missing" ]]; then
            log_error "Could not determine missing dependency. Check Gradle output above."
            exit 1
        fi

        # Check if we're stuck on the same dependency
        if [[ "$missing" == "$last_missing" ]]; then
            ((stuck_count++))
            if [[ $stuck_count -ge 3 ]]; then
                log_error "Stuck on dependency: $missing"
                log_error "This dependency may not exist or requires manual resolution."
                exit 1
            fi
        else
            stuck_count=0
        fi
        last_missing="$missing"

        log_info "Missing: $missing"

        # Parse the coordinates
        IFS=':' read -r group artifact version <<< "$missing"

        if [[ -z "$group" || -z "$artifact" || -z "$version" ]]; then
            log_warn "Could not parse: $missing"
            continue
        fi

        # Download the artifact
        if download_artifact "$group" "$artifact" "$version" "pom"; then
            log_info "Downloaded: $group:$artifact:$version"
        else
            log_warn "Could not find: $group:$artifact:$version"
        fi

        # Process any transitive dependencies discovered
        local trans_count=$(process_dependency_queue)
        if [[ "$trans_count" -gt 0 ]]; then
            log_info "Downloaded $trans_count transitive dependencies"
        fi
    done

    if [[ $iteration -ge $MAX_ITERATIONS ]]; then
        log_error "Reached maximum iterations ($MAX_ITERATIONS)"
        log_error "Some dependencies may still be missing"
        exit 1
    fi

    local total=$(wc -l < "$DOWNLOADED_LIST" 2>/dev/null || echo 0)
    log_info "Bootstrap complete! Downloaded $total artifacts."
    log_info "Local repo: $LOCAL_REPO"
}

main "$@"
