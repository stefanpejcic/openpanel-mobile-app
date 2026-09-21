# Changelog

## 1.1.0

- Added backup & restore: export saved servers and their logins to a password-encrypted file (via the share sheet), and import a previously exported file (with its password) to restore them or move them to another device. Accessible from the icon in the top-right of the server list.
- Added the ability to edit a saved server's details and login from the server list, instead of having to remove and re-add it.
- Fixed: connecting to an OpenAdmin server running a build old enough to predate the `/api/login` SSO handoff (or its CSRF exemption) no longer dead-ends with a raw "CSRF error" alert — the app now falls back to the normal login page instead.

## 1.0.0

- Initial release, rebranded to OpenPanel with dual OpenPanel/OpenAdmin server support.
