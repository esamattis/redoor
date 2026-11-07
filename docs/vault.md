# Vault

The vault lets you keep secrets (`.env` files, credentials, private notes) on your devices
in encrypted form and still open, edit, upload and download them through redoor as if they
were ordinary files. It also protects the SSH keys redoor creates for your devices.

The vault key exists only in your browser. Your devices only ever store ciphertext, and the
redoor server only stores keys in a form it cannot open itself.

## Encrypted files

A file whose name ends in `.redoorencrypted` is encrypted with the vault. On the device it is
unreadable; in redoor it behaves like a normal file while the vault is unlocked:

- **Open and edit** it in the editor. Saving encrypts the new content again before it is
  written to the device.
- **Create** one from the New menu by giving the file name the `.redoorencrypted` suffix.
- **Upload** files encrypted by ticking _Encrypt_ in the upload dialog. They are stored as
  `name.redoorencrypted`.
- **Download decrypted** from the editor's actions to get the plaintext on your computer.

Copying, moving, renaming and deleting work without unlocking, because they never need the
content. Each file gets its own random key, so one file's key never opens another file.

## How file contents are encrypted

### Inside an encrypted file

An encrypted file has two parts:

- **A readable header** that says which vault and which key generation encrypted the file,
  and holds the file's own key, encrypted with the vault key. It contains no file names or
  dates. A tamper check over the header, keyed with the file key, detects any change to it.
- **The content**, split into chunks of 64 KiB. Each chunk is encrypted and sealed with its
  own authentication tag (ChaCha20-Poly1305). The chunks are numbered and the last one is
  marked, so a changed, removed, reordered or appended chunk is detected, as is a file cut
  short.

Because the header is readable without any key, redoor can tell even while the vault is locked
which vault and generation a file needs, and explain why a file cannot be opened (another
vault, a destroyed generation, a generation it does not know) instead of calling it corrupted.

### Opening and downloading

1. The browser reads the header and opens the file key with the vault key. The vault key
   itself never leaves the browser.
2. The browser sends that one file key with the request, never in a URL.
3. Before sending anything back, the server checks the header and its tamper check, so a
   wrong, foreign or modified file fails with a clear error instead of garbage.
4. The server streams the ciphertext from the device, decrypts it chunk by chunk and passes a
   chunk on only after it verified it. If a later chunk fails, the transfer stops rather than
   delivering altered content.
5. When the request ends, the server forgets the file key.

### Saving and uploading

1. For every save or upload the browser creates a new random file key, encrypts it with the
   current vault key for the header, and sends the content and the file key to the server.
   The content travels to the server in plaintext, protected only by the connection, so
   reach redoor over HTTPS whenever it is not on the same machine.
2. The server encrypts the content chunk by chunk as it arrives and streams the ciphertext to
   the device.
3. The device writes the new version next to the old one and swaps it in only at the end.
   A save swaps it in only if nobody changed the file on the device since it was opened;
   otherwise the editor offers to overwrite or discard. A failed or interrupted save or
   upload leaves the previous version intact.

### What this means in practice

- Files of any size stream through the server in small chunks, so it never holds a whole
  file in memory. Uploads and decrypted downloads stream from and to disk in the browser
  too, and sizes and progress work as for ordinary files.
- The server handles plaintext only while a request for that file runs, one chunk at a time.
  It never writes plaintext to a temporary file, keeps keys out of its logs and wipes them
  from memory after use.
- On Linux and Termux the server process cannot be inspected by other processes of its own
  OS user, such as a local device's agent, so they cannot read keys from its memory. macOS
  offers no such protection.

## Creating and unlocking the vault

The vault is created the first time you need it (for example when you create your first
encrypted file), or from **Settings → Vault**. Every user who signs in to the server shares
the same vault.

You choose one or more **unlock methods**:

- **Passkeys.** Unlock with a passkey (a phone, a security key, a password manager, the
  operating system's built-in passkeys). A passkey only works on the hostname it was
  registered on, so register one per address you use for redoor.
- **Passphrase.** Optional. It works from any address, and it is your recovery path if you
  lose your passkeys. Redoor can generate a strong one for you.

Each unlock method opens the same vault, so any one of them is enough. You can add and remove
methods later under **Unlock methods**, as long as at least one remains.

> [!WARNING]
> A vault without a passphrase is lost together with its passkeys: no backup and no server
> administrator can open your files then. Redoor warns you whenever a vault would end up
> without a passphrase.

## How long the vault stays unlocked

When you unlock, you pick how long the vault stays unlocked **without use**: 15 minutes (the
default), 1 hour, 24 hours, 1 week, or _Until I lock it_. Using an encrypted file counts as
use and starts the time again.

The vault locks in every tab of the browser when any of these happens:

- the picked time passes without use,
- you press **Lock now** in Settings → Vault,
- you sign out, or your login session ends or is revoked (for example by a password change),
- the vault key is rotated or a backup is restored in another browser,
- the redoor server restarts.

Unlocking once unlocks every open tab, and the vault stays unlocked across page reloads and
browser restarts until one of the above happens.

### How the browser keeps it unlocked

To stay unlocked across reloads, your browser stores the vault key, but only encrypted with a
secret that the server holds for your current login session. **Both halves are needed** to
open the vault:

- the browser has the encrypted key but not the secret,
- the server has the secret but never the key.

The server keeps that secret in memory only, gives it back only to the same login session and
only within the time you picked, and forgets it as soon as the vault locks. After that, the
key stored in the browser can never be opened again, not by signing in again, and not by
copying the browser profile to another computer. The time limit is therefore enforced even
when no redoor tab is open.

A tab that is already open notices a lock that happened elsewhere (expiry, a server restart, a
lock from another tab) the next time it checks with the server, for example when it becomes
visible again or reconnects.

## Key rotation

**Rotate vault key** in Settings → Vault creates a new vault key. New and saved files use the
new key, while files encrypted with older keys keep working, because the vault can still open
every older **key generation**. Rotation also happens, when you choose so, after you remove an
unlock method or change the passphrase, so that the removed method can no longer open the
vault.

Rotating locks the vault in every other browser, so each one has to unlock again.

Under **Encrypted files** in Settings → Vault you can scan your connected devices for
encrypted files and see which key generation each uses:

- **Rewrap** moves a file to the current key generation without decrypting its content.
- **Re-encrypt** encrypts the content again with a brand new file key, for files you suspect
  someone may have seen.

Once no file needs an old generation any more, you can **destroy** it under **Key
generations**. Files that still use a destroyed generation can no longer be opened; redoor
tells you so instead of reporting a corrupted file.

## Backups

The vault's keys are stored on the redoor server in a single file. **Download vault backup**
saves it. The backup contains only encrypted keys, so it is safe to keep anywhere; it still
needs one of the vault's unlock methods to open.

**Restore vault backup** replaces the vault on the server with a backup. It needs proof that
you can unlock both the backup and the vault it replaces, so a stolen login cannot swap your
vault for someone else's. Restoring locks the vault in every browser.

Keep a backup after creating the vault and after every rotation: losing the server's data
directory without one means losing every encrypted file.

## SSH device keys

When a vault exists, the SSH keys redoor creates for your SSH devices are encrypted with it.
Starting such a device asks you to unlock the vault, and the server then keeps that device's
key in memory while the device runs, so it can reconnect on its own. After a server restart,
the next start asks for the vault again.

## What the vault protects against

| Threat                                                      | Why it is protected                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Other users or processes on a device, stolen disks, backups | Devices only ever store ciphertext and never see a key.                                     |
| A stolen copy of the server's data directory                | It holds only encrypted keys. A passphrase protects them only as well as it is strong.      |
| Access tokens, the remote CLI and MCP clients               | They can copy encrypted files but never decrypt them or change the vault.                   |
| A stolen login cookie on its own                            | It cannot change the vault, because every change needs proof that you hold the vault key.   |
| A copied browser profile, after the vault locked            | The server has forgotten its half of the stored key, so the browser's half opens nothing.   |
| Tampering with an encrypted file's content                  | Every chunk and the header are authenticated, so changes are detected instead of decrypted. |

## What the vault does not protect against

| Threat                                                           | Why, and what to do                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone using your browser while the vault is unlocked           | The vault is open for anyone at that browser. Lock the vault or sign out when you leave a shared computer.                                                                                              |
| A copy of your browser profile taken while the vault is unlocked | The copy carries your login session too, so it can open the vault and keep it unlocked until you sign out, lock the vault, change your password or the server restarts. Sign out if you suspect a copy. |
| Malware or a malicious browser extension on your computer        | It can see whatever the redoor page sees, including decrypted files and your passphrase as you type it.                                                                                                 |
| A compromised redoor server                                      | The server delivers the redoor web app and can already run commands on every device, so it could also capture keys and plaintext.                                                                       |
| Someone who can read the server's memory                         | Root on the server machine, or on macOS any process of the server's OS user, can read file keys during requests, the browsers' secrets and the decrypted SSH keys of running devices.                   |
| An unencrypted connection to redoor                              | File contents travel between the browser and the server in plaintext. Use HTTPS whenever redoor is not on the same machine.                                                                             |
| Deleting, rolling back or swapping encrypted files on a device   | An older version of a file is still a valid encrypted file, and the header does not name the file, so a device user can restore an old version or swap two encrypted files unnoticed. Keep backups.     |
| What the device can still see                                    | File names, sizes, modification times and the vault's name in each header stay readable on the device. Do not put secrets in file names.                                                                |
| Decrypted copies                                                 | Files saved with _Download decrypted_ are ordinary plaintext files on your computer.                                                                                                                    |
| Losing every unlock method                                       | Nobody can recover the vault then, not even from a backup or by the server's administrator. Keep a passphrase, or more than one passkey.                                                                |
