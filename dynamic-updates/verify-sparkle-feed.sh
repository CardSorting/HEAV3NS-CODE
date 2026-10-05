#!/bin/bash
set -euo pipefail

FEED_URL="https://releases.heav3ns.com/appcast.xml"
PUBLIC_KEY="GOOutbIDL5kYZ9sNS726PQkfEUOtMlcWZ2ORLjX3Hb0="

color_green="\033[0;32m"
color_cyan="\033[0;36m"
color_yellow="\033[0;33m"
color_red="\033[0;31m"
color_reset="\033[0m"

echo "=========================================================="
echo "  Sparkle 2.0 In-App Update Feed Verification"
echo "  Target Feed: $FEED_URL"
echo "=========================================================="
echo ""

# 1. Fetch Appcast XML
echo -e "${color_cyan}[1] Fetching live appcast feed...${color_reset}"
FEED_CONTENT="$(curl -s -f "$FEED_URL" || true)"

if [ -z "$FEED_CONTENT" ]; then
  echo -e "${color_red}✖ Failed to fetch appcast feed from $FEED_URL${color_reset}"
  exit 1
fi

echo -e "${color_green}✓ Appcast feed reached successfully.${color_reset}"
echo ""

# 2. Parse XML fields
echo -e "${color_cyan}[2] Parsing appcast release metadata...${color_reset}"
VERSION="$(echo "$FEED_CONTENT" | grep -o '<sparkle:version>[^<]*</sparkle:version>' | sed -e 's/<[^>]*>//g')"
SHORT_VERSION="$(echo "$FEED_CONTENT" | grep -o '<sparkle:shortVersionString>[^<]*</sparkle:shortVersionString>' | sed -e 's/<[^>]*>//g')"
ENCLOSURE_URL="$(echo "$FEED_CONTENT" | grep -o 'url="[^"]*"' | cut -d'"' -f2)"
ENCLOSURE_LEN="$(echo "$FEED_CONTENT" | grep -o 'length="[^"]*"' | cut -d'"' -f2)"
ED_SIGNATURE="$(echo "$FEED_CONTENT" | grep -o 'sparkle:edSignature="[^"]*"' | cut -d'"' -f2)"

echo "  • Release Version       : $SHORT_VERSION (Build $VERSION)"
echo "  • Enclosure Package URL : $ENCLOSURE_URL"
echo "  • Declared Size (bytes) : $ENCLOSURE_LEN"
echo "  • EdDSA Signature       : $ED_SIGNATURE"
echo ""

# 3. Verify Enclosure Reachability & Content Length
echo -e "${color_cyan}[3] Checking binary enclosure reachability...${color_reset}"
HTTP_HEAD="$(curl -s -I "$ENCLOSURE_URL")"
HTTP_STATUS="$(echo "$HTTP_HEAD" | head -n 1 | awk '{print $2}')"
ACTUAL_LEN="$(echo "$HTTP_HEAD" | grep -i 'content-length' | awk '{print $2}' | tr -d '\r')"

if [ "$HTTP_STATUS" = "200" ]; then
  echo -e "  ${color_green}✓ Enclosure URL returned HTTP 200 OK${color_reset}"
else
  echo -e "  ${color_red}✖ Enclosure URL returned HTTP $HTTP_STATUS${color_reset}"
  exit 1
fi

if [ "$ACTUAL_LEN" = "$ENCLOSURE_LEN" ]; then
  echo -e "  ${color_green}✓ Declared size matches HTTP content-length ($ACTUAL_LEN bytes)${color_reset}"
else
  echo -e "  ${color_yellow}⚠ Size note: XML says $ENCLOSURE_LEN, HTTP returned $ACTUAL_LEN${color_reset}"
fi
echo ""

# 4. Verify Local App Info.plist Configuration
echo -e "${color_cyan}[4] Checking local macOS Info.plist integration...${color_reset}"
PLIST_FILE="native/Info.plist"
if grep -q "$FEED_URL" "$PLIST_FILE" && grep -q "$PUBLIC_KEY" "$PLIST_FILE"; then
  echo -e "  ${color_green}✓ SUFeedURL and SUPublicEDKey are correctly wired in $PLIST_FILE${color_reset}"
else
  echo -e "  ${color_red}✖ Missing keys in $PLIST_FILE${color_reset}"
  exit 1
fi

echo ""
echo "=========================================================="
echo -e "${color_green}  ✓ SPARKLE VERIFICATION PASSED!${color_reset}"
echo "  Clients running HEAV3NS-CODE will detect updates at"
echo "  $FEED_URL and automatically update in-place."
echo "=========================================================="
