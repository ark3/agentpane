#!/bin/sh
set -eu
test "$1" = "--replace"
printf '%s' "edited by fixture" > "$2"
