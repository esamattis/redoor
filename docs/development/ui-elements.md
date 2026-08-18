# UI elements

Shared names for talking about the Web UI. Prefer these over informal words like “sidebar”, “header”, or “panel” when more than one of those exists.

Login has no application chrome. Every other route uses the app shell.

Breakpoint: at `xl` and up the side menus stay on screen. Below `xl` they become modal edge drawers. The bottom drawer is always an overlay; it never shrinks main.

---

## Names

| Say this | Also acceptable | Do not say |
|---|---|---|
| Application menu | left menu | the sidebar (ambiguous) |
| Agent menu | right menu | the agent list (that is the `/agents` page) |
| Top bar | View navigation | header (the file browser has its own) |
| Agent view tabs | — | top tabs (browser has view tabs too) |
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
| APPLICATION| [ Agent view tabs ]            [theme]   | AGENT MENU |
| MENU       +------------------------------------------+            |
|            |                                          |            |
| Home       | MAIN                                     | Agents  [+] |
| Agents     |                                          |            |
| Server logs|   (current route)                        | agent name |
| Transfers  |                                          |   bookmark |
|            |                                          | agent name |
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
| [open application menu]  Agent view tabs  [theme]    |
|                                       [open agent menu]
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
| |APPLICATION|                       |   AGENT MENU | |
| |MENU       |                       |              | |
| |     w-72  |                       |        w-72  | |
| +----------+                        +--------------+ |
+------------------------------------------------------+
```

Open controls: **Open application menu**, **Open agent menu**.  
Close controls: **Close application menu**, **Close agent menu**.

---

## Application menu

Left. Brand mark goes to Server home.

```
+----------------------+
| [logo] Redoor        |
|                      |
| Home                 |   /
| Agents               |   /agents
| Server logs          |   /logs
| Transfers            |   /transfers
|                      |
| [Restart]            |
| [Log out]            |
+----------------------+
```

---

## Agent menu

Right. Not the Agents inventory page.

```
+---------------------------+
| AGENTS                 [+] |   Add managed agent
|                            |
| agent name                 |
|   connected            [✎] |   edit when configuration is editable
|     bookmark               |
|     bookmark           [x] |   Remove bookmark
| agent name                 |
|   stopped                  |
+---------------------------+
```

Empty copy: **No agents configured or connected**.

---

## Top bar

Always present after login. Agent view tabs only appear on an agent route.

```
[ Open application menu ] | AGENT VIEW TABS | [theme] | [ Open agent menu ]
     (narrow only)            flex-1                     (narrow only)
```

### Agent view tabs

Shown when viewing a specific agent.

```
[ {agent name} ] [ Files ] [ Configuration ] [ Logs ]
```

- **{agent name}** — agent details (or lifecycle if not connected)
- **Files** — file browser; only when connected and `cwd` is known
- **Configuration** — edit managed agent; only when editable
- **Logs** — that agent's logs; only when connected

On Server home, Agents, Transfers, Server logs, and Add managed agent the tab strip is empty. The top bar still holds the menu buttons and theme toggle.

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

Global file/directory selection across agents. Empty: **Select files or directories to review them here.**

### Transfers

Active transfers only. **View all** goes to Transfer history (`/transfers`).

### Terminal

Remote shells. Tabs are `{agent name} 1`, …  Lives across route changes.

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
  Agents   [dot] name  [dot] name   [Agent menu]   (narrow only)

  +------------------+
  | App name         |
  | Config file      |
  | Binary path      |
  | External IP      |
  | Authentication   |
  | Binary identity  |
  +------------------+

  Connect an agent
    config.toml snippet
```

---

## Agents inventory

Route `/agents`. Heading **Agents**. This is a page, not the Agent menu.

```
MAIN
  Agents

  Name | Source | Status | Version | Rev | Connection | Issue | Actions
  ...
  {name} actions: Start, Restart, Shutdown, Browse files
```

---

## Agent details

Route `/agents/$id` when connected. Agent view tab **{agent name}**.

```
MAIN
  {name}                    [Restart] [View logs] [Browse Files]
  ID: {id}

  +------------------+ +------------------+
  | Process Info     | | System Load      |
  | System Info      | | User Info        |
  | Uptime           | | Binary           |
  +------------------+ +------------------+
  | Mount Points                          |
  | Upgrade                               |
  +---------------------------------------+
```

When the agent is not connected, same URL, no card grid: centered lifecycle (**Starting {name}**, stopped, disconnected) with **Retry Start** / **Shutdown** when managed.

---

## Add / Edit managed agent

`/agents/new` — **Add managed agent**.  
`/agents/$id/edit` — **Edit managed agent** (agent view tab **Configuration**).

```
MAIN
  Add/Edit managed agent

  Connection
    SSH target, Agent name, SSH username, SSH port
    key or password

  Advanced
    Remote binary, Home directory, Diagnostic log

  [Save…]
  [Delete managed agent]    (edit only)
```

---

## Logs

`/logs` — **Server logs**.  
`/agents/$id/logs` — **{name} logs** (agent view tab **Logs**).

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

Route `/agents/$id/browser/$`. Agent view tab **Files**.

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
  agent + path
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
APPLICATION MENU and AGENT MENU   same on every chrome route
TOP BAR                           always; agent view tabs only on agent routes
APPLICATION TOOLS                 always; same tabs everywhere
MAIN                              the only region that swaps by route
BROWSER HEADER                    only inside the file browser
```
