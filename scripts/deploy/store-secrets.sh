#!/usr/bin/env bash
# Stores the credentials the deployment scripts need in ~/.cadentra/secrets.env (mode 600), OUTSIDE
# the repository. Input is not echoed and is never sent anywhere by this script.
#
#   bash scripts/deploy/store-secrets.sh
#
# Leave a prompt empty to keep the value already stored.
set -euo pipefail
umask 077
dir="$HOME/.cadentra"
file="$dir/secrets.env"
mkdir -p "$dir"
chmod 700 "$dir"
touch "$file"
chmod 600 "$file"

set_value() { # name value
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${name}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

prompt_secret() { # name label
  local name="$1" label="$2" value
  printf '%s (input hidden, Enter to keep current): ' "$label"
  read -rs value
  printf '\n'
  if [ -n "$value" ]; then set_value "$name" "$value"; echo "  saved $name"; else echo "  kept $name"; fi
}

echo "Credentials are written to $file and nowhere else."
prompt_secret DATABASE_URL 'DATABASE_URL, e.g. mysql://USER:PASSWORD@HOST:4000/cadentra?ssl=true'
prompt_secret RESEND_ADMIN_KEY 'Resend FULL-ACCESS API key (re_...), used once to create the webhook'
echo "Done. Nothing was printed or transmitted."
