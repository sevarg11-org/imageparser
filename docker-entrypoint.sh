#!/bin/sh
set -eu

PUID="${PUID:-568}"
PGID="${PGID:-568}"
CONFIG_DIRECTORY="${IMAGEPARSER_CONFIG_DIR:-/config}"
PHOTO_DIRECTORY="${IMAGEPARSER_ROOT:-/data}"

case "$PUID:$PGID" in
    *[!0-9:]* | :* | *:)
        echo "PUID and PGID must be numeric user and group IDs." >&2
        exit 1
        ;;
esac

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$CONFIG_DIRECTORY"
    if ! chown -R "$PUID:$PGID" "$CONFIG_DIRECTORY"; then
        echo "Warning: unable to change ownership of $CONFIG_DIRECTORY; checking existing ACL access." >&2
    fi

    if ! gosu "$PUID:$PGID" test -w "$CONFIG_DIRECTORY"; then
        echo "$CONFIG_DIRECTORY is not writable by UID $PUID and GID $PGID." >&2
        echo "Update the TrueNAS dataset ACL or set PUID/PGID to its writable owner." >&2
        exit 1
    fi

    if ! gosu "$PUID:$PGID" test -w "$PHOTO_DIRECTORY"; then
        echo "Warning: $PHOTO_DIRECTORY is not writable by UID $PUID and GID $PGID." >&2
        echo "Image browsing will work, but XMP and EXIF updates may fail." >&2
    fi

    exec gosu "$PUID:$PGID" env HOME=/tmp "$@"
fi

if [ ! -w "$CONFIG_DIRECTORY" ]; then
    echo "$CONFIG_DIRECTORY is not writable by UID $(id -u) and GID $(id -g)." >&2
    exit 1
fi

exec "$@"
