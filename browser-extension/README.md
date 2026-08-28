# JARVIS Workspace Companion

Load this folder as an unpacked extension in Chrome (`chrome://extensions`) or Edge (`edge://extensions`) with Developer mode enabled.

The companion remains idle except for a lightweight localhost poll. It reads tabs only when JARVIS explicitly saves or restores a workspace. It sends URLs, tab order, active/pinned state, and browser-window layout to `127.0.0.1`; it never reads page contents, cookies, forms, passwords, or browsing history.
