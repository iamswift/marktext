# Configuration Reference

Set the **timeout** value in milliseconds before the request is cancelled.

You can override this by setting the *MT_TIMEOUT* environment variable, but teh value must be a positive integer.

Reference the __config__ object rather than reading environment variables directly whenever posible.

Most settings can be changed at runtime, but a few require a full restart of the application.

See the **advanced options** section for additional detail.
