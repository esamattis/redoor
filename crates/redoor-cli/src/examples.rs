//! Usage examples shown at the end of each `redoor remote` command's `--help`.
//!
//! Flag descriptions alone do not show how the `DEVICE:/absolute/path` syntax, the `--`
//! separator of `exec` or the token flags combine, so every command gets runnable examples.
//! They live together so the wording and device names stay consistent across commands.

/// Shown by `redoor remote --help` as a quick tour of the most common commands.
pub(crate) const REMOTE: &str = "Examples:
  # Log in once and save an access token
  redoor remote login https://redoor.example.com

  # List devices, then run a command and copy a file on one of them
  redoor remote devices
  redoor remote exec workstation -- uptime
  redoor remote cp ./report.csv workstation:/srv/report.csv

  # Use a token from the environment instead of a saved login
  REDOOR_REMOTE_SERVER=https://redoor.example.com REDOOR_REMOTE_TOKEN=redoor_at_... redoor remote devices";

/// Shown by `redoor remote start --help`.
pub(crate) const START: &str = "Examples:
  # Start the agent of a server-managed (for example SSH) device
  redoor remote start build-box

  # Print the lifecycle response for scripts
  redoor remote start build-box --json";

/// Shown by `redoor remote stop --help`.
pub(crate) const STOP: &str = "Examples:
  # Stop the agent of a server-managed device
  redoor remote stop build-box

  # Print the lifecycle response for scripts
  redoor remote stop build-box --json";

/// Shown by `redoor remote exec --help`; the `--` separator is the part people miss.
pub(crate) const EXEC: &str = "Examples:
  # Run a command; everything after -- is passed as argv without a shell
  redoor remote exec workstation -- uptime

  # Run in a directory with an extra environment variable
  redoor remote exec --cwd /srv/app --env RUST_LOG=debug workstation -- cargo test

  # Use a shell explicitly when pipes or globs are needed
  redoor remote exec workstation -- sh -c 'du -sh /var/log/* | sort -h'

  # Give up after five minutes and stream lossless JSON events
  redoor remote exec --timeout 5m --json workstation -- ./backup.sh";

/// Shown by `redoor remote cp --help`.
pub(crate) const CP: &str = "Examples:
  # Upload a local file
  redoor remote cp ./report.csv workstation:/srv/report.csv

  # Download a file into the current directory
  redoor remote cp workstation:/var/log/syslog .

  # Copy a directory tree between two devices
  redoor remote cp -r workstation:/srv/app nas:/backups

  # Merge into an existing directory, replacing conflicting files
  redoor remote cp -r --merge ./site workstation:/var/www

  # Local file names containing a colon need a ./ prefix
  redoor remote cp ./notes:2024.txt workstation:/tmp";

/// Shown by `redoor remote ls --help`.
pub(crate) const LS: &str = "Examples:
  # List a directory
  redoor remote ls workstation:/srv

  # Print the listing as JSON for scripts
  redoor remote ls workstation:/srv --json";

/// Shown by `redoor remote stat --help`.
pub(crate) const STAT: &str = "Examples:
  # Show the size, type and modification time of a path
  redoor remote stat workstation:/etc/hosts

  # Print the metadata as JSON for scripts
  redoor remote stat workstation:/etc/hosts --json";

/// Shown by `redoor remote mkdir --help`.
pub(crate) const MKDIR: &str = "Examples:
  # Create one directory inside an existing parent
  redoor remote mkdir workstation:/srv/uploads

  # Create missing parents and accept an existing directory
  redoor remote mkdir -p workstation:/srv/app/releases/2026-10-22";

/// Shown by `redoor remote rm --help`.
pub(crate) const RM: &str = "Examples:
  # Move a file to the trash
  redoor remote rm workstation:/tmp/old.log

  # Move a directory and its contents to the trash
  redoor remote rm -r workstation:/srv/app/build

  # Delete permanently without using the trash
  redoor remote rm -r --permanent workstation:/tmp/cache";

/// Shown by `redoor remote mv --help`.
pub(crate) const MV: &str = "Examples:
  # Rename a file on one device
  redoor remote mv workstation:/srv/report.csv workstation:/srv/report-2026.csv

  # Move a file into an existing directory
  redoor remote mv workstation:/tmp/report.csv workstation:/srv/archive

  # Move a directory to another device, replacing an existing one
  redoor remote mv --force workstation:/srv/app nas:/backups/app";

/// Shown by `redoor remote find --help`.
pub(crate) const FIND: &str = "Examples:
  # Find paths whose name contains config
  redoor remote find workstation:/srv/app config

  # Include hidden and .gitignored files
  redoor remote find workstation:/home/me .env --hidden --no-ignore

  # Match letter case exactly and allow a longer search
  redoor remote find workstation:/ README --case sensitive --timeout 60";

/// Shown by `redoor remote grep --help`.
pub(crate) const GREP: &str = "Examples:
  # Search file contents with a regular expression
  redoor remote grep workstation:/srv/app 'TODO|FIXME'

  # Search for literal text with two lines of context
  redoor remote grep -F -C 2 workstation:/srv/app 'fn main()'

  # Ignore letter case and print JSON for scripts
  redoor remote grep --case insensitive --json workstation:/var/log 'error'";

/// Shown by `redoor remote login --help`.
pub(crate) const LOGIN: &str = r#"Examples:
  # Log in interactively and choose the token's permissions
  redoor remote login https://redoor.example.com

  # Log in from a script without prompts
  printf '%s\n' "$REDOOR_PASSWORD" | redoor remote login https://redoor.example.com \
    --username admin --password-stdin --permissions files:read,commands:execute \
    --devices all --expires 30d --yes

  # Limit the token to two devices
  redoor remote login https://redoor.example.com --devices workstation,nas

  # Log in to a server with a self-signed certificate; later commands remember it
  redoor remote login https://192.168.1.10:7666 --insecure-tls"#;

/// Shown by `redoor remote logout --help`.
pub(crate) const LOGOUT: &str = "Examples:
  # Revoke the saved token and remove it locally
  redoor remote logout";

/// Shown by `redoor remote status --help`.
pub(crate) const STATUS: &str = "Examples:
  # Show the server, token and permissions in use
  redoor remote status

  # Print the token metadata as JSON for scripts
  redoor remote status --json";

/// Shown by `redoor remote create-token --help`.
pub(crate) const CREATE_TOKEN: &str = r#"Examples:
  # Create a read/write file token for an MCP client
  redoor remote create-token http://127.0.0.1:7666 --permissions files:read,files:write

  # Create a token for every permission and device without prompts
  printf '%s\n' "$REDOOR_PASSWORD" | redoor remote create-token https://redoor.example.com \
    --username admin --password-stdin --permissions all --devices all \
    --name ci --expires 90d --yes"#;

/// Shown by `redoor remote devices --help`.
pub(crate) const DEVICES: &str = "Examples:
  # List device IDs, names and connection status
  redoor remote devices

  # Print the full device list as JSON for scripts
  redoor remote devices --json";
