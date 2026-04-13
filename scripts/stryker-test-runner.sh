#!/bin/bash
# Wrapper for Stryker command runner.
# Suppresses bun coverage output to avoid EPIPE, preserves exit code.
bun test 2>/dev/null
exit $?
