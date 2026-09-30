# UI elements

Shared names for talking about the Web UI. Prefer these over informal words like “sidebar”, “header”, or “panel” when more than one of those exists.

Use **device** for a machine accessed through Redoor and **Redoor agent** for the
process running on it. Restart, update, version, and process logs refer to the
agent. Route paths use the internal agent terminology (`/agents`).

Login has no application chrome. Every other route uses the app shell.

Breakpoint: at `xl` and up the side menus stay on screen. Below `xl` they become modal edge drawers. The bottom drawer is always an overlay; it never shrinks main.

---

## Names

| Say this | Also acceptable | Do not say |
|---|---|---|
| Application menu | left menu | the sidebar (ambiguous) |
| Device menu | right menu | the device list (that is the `/agents` page) |
| Top bar | View navigation | header (the file browser has its own) |
| Device view tabs | — | top tabs (browser has view tabs too) |
| Main | page, route content | content area |
| Browser header | breadcrumbs, path bar | header |
| Directory view tabs / File view tabs | Files / Details / Sync, Edit / View | the tabs |
| File list | directory listing | the table |
| Application tools | bottom drawer | the panel, footer |
| Selected / Transfers / Terminal | application-tools tabs | — |
| Toast | — | notification, alert (alerts are dialogs) |
| Dialog | confirmation dialog, action menu | modal (unless you mean the mobile side menus) |
| Drop overlay | — | upload dialog |

---

## App shell (desktop, `xl+`)

Side menus are persistent columns. Top bar and application tools overlay main; main scrolls underneath and is padded so content is not hidden.

```
+------------+------------------------------------------+------------+
|            | TOP BAR                                  |            |
|            | View navigation                          |            |
| APPLICATION| [ Device view tabs ]           [theme]   | DEVICE MENU|
| MENU       +------------------------------------------+            |
|            |                                          |            |
| Home       | MAIN                                     | Devices [+] |
| Devices    |                                          |            |
| Server logs|   (current route)                        | device name|
| Transfers  |                                          |   bookmark |
|            |                                          | device name|
| [Restart]  |                                          |            |
| [Log out]  |                                          |            |
|            +------------------------------------------+            |
|            | APPLICATION TOOLS                        |            |
|            | [Selected] [Transfers] [Terminal]  [v/^] |            |
+------------+------------------------------------------+------------+
```

---

## App shell (narrow, below `xl`)

Main is full width. Burgers on the top bar open one side menu at a time as a modal drawer.

```
+------------------------------------------------------+
| TOP BAR                                              |
| [open application menu]  Device view tabs [theme]    |
|                                      [open device menu]
+------------------------------------------------------+
| MAIN                                                 |
|                                                      |
+------------------------------------------------------+
| APPLICATION TOOLS                                    |
| [Selected] [Transfers] [Terminal]              [v/^] |
+------------------------------------------------------+

Either menu open (never both):

+------------------------------------------------------+
| dimmed backdrop                                      |
| +----------+                        +--------------+ |
| |APPLICATION|                       |  DEVICE MENU | |
| |MENU       |                       |              | |
| |     w-72  |                       |        w-72  | |
| +----------+                        +--------------+ |
+------------------------------------------------------+
```

Open controls: **Open application menu**, **Open device menu**.

Close controls: **Close application menu**, **Close device menu**.

---

## Application menu

Left. Brand mark goes to Server home.

```
+----------------------+
| [logo] Redoor        |
|                      |
| Home                 |   /
| Devices              |   /agents
| Server logs          |   /logs
| Transfers            |   /transfers
|                      |
| [Restart]            |
| [Log out]            |
+----------------------+
```

---

## Device menu

Right. Not the Devices inventory page.

```
+---------------------------+
| DEVICES                [+] |   Add device
|                            |
| device name                |
|   connected            [✎] |   edit when configuration is editable
|     bookmark               |
|     bookmark           [x] |   Remove bookmark
| device name                |
|   stopped                  |
+---------------------------+
```

Empty copy: **No devices configured or connected**.

---

## Top bar

Always present after login. Device view tabs only appear on a device route.

```
[ Open application menu ] | DEVICE VIEW TABS | [theme] | [ Open device menu ]
     (narrow only)            flex-1                     (narrow only)
```

### Device view tabs

Shown when viewing a specific device.

```
[ {device name} ] [ Files ] [ Configuration ] [ Logs ]
```

- **{device name}** — device details (or lifecycle if not connected)
- **Files** — file browser; only when connected and `cwd` is known
- **Configuration** — edit device connection settings; only when editable
- **Logs** — that agent's logs; only when connected

On Server home, Devices, Transfers, Server logs, and Add device the tab strip is empty. The top bar still holds the menu buttons and theme toggle.

---

## Application tools

Bottom drawer. Default: collapsed, Terminal tab. Overlay; does not push main.

```
collapsed
+------------------------------------------------------------------+
| [Selected  N] [Transfers  …] [Terminal]                    [ ^ ] |
+------------------------------------------------------------------+

expanded
+------------------------------------------------------------------+
| = resize handle                                                  |
| [Selected  N] [Transfers  …] [Terminal]                    [ v ] |
+------------------------------------------------------------------+
| tab panel                                                        |
+------------------------------------------------------------------+
```

Toggle: **Expand bottom drawer** / **Minimize bottom drawer**.  
Resize: **Resize bottom drawer**.

### Selected

Global file/directory selection across devices. Empty: **Select files or directories to review them here.**

### Transfers

Active transfers only. **View all** goes to Transfer history (`/transfers`).

### Terminal

Remote shells. Tabs are `{device name} 1`, …  Lives across route changes.

```
+------------------------------------------------------------------+
| [box 1] [box 2]                              [New terminal]      |
| Connected / Disconnected / Connecting                            |
+------------------------------------------------------------------+
| terminal scrollback                                              |
+------------------------------------------------------------------+
```

---

## Overlays

Not part of the shell layout. Stack above everything.

```
                    +---------------------------+
                    | TOAST                     |   top-center, not modal
                    +---------------------------+

+--------------------------------------------------------------+
| DROP OVERLAY                                                 |
| Drop files here to upload them to {path}                     |
+--------------------------------------------------------------+

              +----------------------------+
              | DIALOG                     |   titled, backdrop
              |                            |
              |              [Cancel] [OK] |
              +----------------------------+

Action menus are the same Dialog component, anchored to a control
instead of centered.
```

---

## Login

No application chrome.

```
                    +---------------------------+
                    | [logo] Redoor             |
                    | Sign in to Redoor         |
                    | Username                  |
                    | Password                  |
                    | [Sign in]                 |
                    +---------------------------+
```

---

## Server home

Route `/`. Heading **Server**.

```
MAIN
  Server
  Devices  [dot] name  [dot] name   [Device menu]  (narrow only)

  +------------------+
  | App name         |
  | Config file      |
  | Binary path      |
  | External IP      |
  | Authentication   |
  | Binary identity  |
  +------------------+

  Connect a device
    config.toml snippet
```

---

## Devices inventory

Route `/agents`. Heading **Devices**. This is a page, not the Device menu.

```
MAIN
  Devices

  Name | Source | Status | Version | Rev | Connection | Issue | Actions
  ...
  {name} actions: Connect, Restart, Disconnect, Browse files
```

---

## Device details

Route `/agents/$id` when connected. Device view tab **{device name}**.

```
MAIN
  {name}                    [Restart] [View logs] [Browse Files]
  ID: {id}

  +------------------+ +------------------+
  | Redoor agent     | | System Load      |
  | System Info      | | User Info        |
  | Uptime           | | Binary           |
  +------------------+ +------------------+
  | Mount Points                          |
  | Upgrade                               |
  +---------------------------------------+
```

When the device is not connected, same URL, no card grid: centered lifecycle (**Connecting {name}**, stopped, disconnected) with **Retry Start** / **Disconnect** when managed. Connect and disconnect start or stop the agent, not the operating system. Inventory sources are **Managed by Redoor** and **Started independently**.

---

## Add / Edit device

`/agents/new` — **Add device**.

`/agents/$id/edit` — **Edit device** (device view tab **Configuration**).

```
MAIN
  Add/Edit device

  Connection
    SSH target, Device name, SSH username, SSH port
    key or password

  Advanced
    Remote binary, Home directory, Diagnostic log

  [Save…]
  [Remove device]    (edit only; stops its agent, preserves device files)
```

---

## Logs

`/logs` — **Server logs**.  
`/agents/$id/logs` — **{name} logs** (device view tab **Logs**, showing agent process logs).

```
MAIN
  {title}                              [x] Auto-scroll
  Live | Reconnecting… | Connecting…
  +----------------------------------------------------+
  | log entries                                        |
  +----------------------------------------------------+
```

---

## Transfer history

Route `/transfers`. Heading **Transfer history**.

Full list of every transfer. The Transfers tab in application tools is the active-only subset of this page.

---

## File browser

Route `/agents/$id/browser/$`. Device view tab **Files**.

All browser views share the browser header. Directory vs file then has its own view tabs.

```
MAIN
  BROWSER HEADER
  [home] [parent]  / bread / crumbs              [edit path]
  DIRECTORY VIEW TABS or FILE VIEW TABS

  (view body)
```

| Kind | View tabs |
|---|---|
| Directory | **Files** · **Details** · **Sync** |
| File | **Edit** or **View** · **Details** · **Sync** |

**Edit** only when the file is editable; otherwise **View** (images).

---

### Directory · Files

Default directory view. Densest screen.

```
  [home] [parent]  / path / here                 [edit path]
  [ Files ] [ Details ] [ Sync ]

  [New v] [Paste] [Upload v] [reload] [hidden] [More v]
  Filter files

  Select | Type | Name | Size | Modified | Owner | Group | …
  ...
  Disk usage: …    Filesystem: …
```

New: **New file**, **New directory**.  
Upload: **Upload files**, **Upload directory**.

A Selected-files card can appear above the list when the global selection can be copied or moved into this directory.

---

### File · Edit

Code editor fills the space between the top bar and application tools. The page scroller is locked; the editor scrolls.

```
  [home] [parent]  / path / file.txt             [edit path]
  [ Edit ] [ Details ] [ Sync ]

  [Save] [Reload] [Download] [fullscreen] [vim] [Search & Replace]
  +--------------------------------------------------------------+
  | CodeMirror                                                   |
  +--------------------------------------------------------------+
```

---

### Sync

Directory or file. Copies, moves, or compares the current path with another selected path.

```
  SYNC FILE / SYNC DIRECTORY
  {basename}

  [ current --> selected | selected --> current ]
  device + path
  [copy] [move] [compare]
  transfer status
  file diff                         (files only)
```

---

### Missing path

```
  File or directory does not exist
  File name
  [create file] [create directory]
```

The path editor in the browser header opens so the URL can be corrected.

---

## What changes per route

```
APPLICATION MENU and DEVICE MENU  same on every chrome route
TOP BAR                           always; device view tabs only on device routes
APPLICATION TOOLS                 always; same tabs everywhere
MAIN                              the only region that swaps by route
BROWSER HEADER                    only inside the file browser
```
