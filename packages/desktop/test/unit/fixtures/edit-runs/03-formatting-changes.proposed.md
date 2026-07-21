# Configuration Reference

Set the `timeout` value in milliseconds before the request is cancelled.

You can override this by setting the `MT_TIMEOUT` environment variable, but the value must be a positive integer.

Reference the `config` object rather than reading environment variables directly whenever possible.

Most settings can be changed at runtime, but a few require the application to be fully restarted.

See the **advanced options** section for more detail.
